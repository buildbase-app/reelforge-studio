#!/usr/bin/env bash
# Docker end-to-end acceptance (issue #16): builds the image, runs the server,
# then drives it from a SEPARATE container on a Docker network (an agent on
# "another machine"): MCP journey, auth/scope/validation negatives, Host/Origin
# checks, configuration over MCP (#24: sources, a runtime change, a refused
# start-up-only key, encrypted secrets), licence activation against a mock
# licence server container (#25: unlicensed, activate, render, offline grace,
# revoked, limit_reached, deactivate), and a restart that must keep projects,
# keys, renders, runtime settings and the licence instance id.
#
# Issue #26: by default it tests the RELEASE image (the Dockerfile's default
# target and edition) with the hardened run flags: --read-only, tmpfs /tmp,
# --cap-drop ALL, no-new-privileges, UID 10001 and the seccomp profile
# deployment/seccomp/chrome.json with Chromium's sandbox on. A release build
# fixes licence.mode/serverUrl/orgId at build time, so this test builds the
# release edition with the mock licence server baked in (build args
# LICENCE_SERVER_URL / LICENCE_ORG_ID; the only difference to the published
# image is that one small layer, which RELEASE_IMAGE=... compares).
#
#   e2e/docker/run.sh                 # build + test (release edition, hardened)
#   IMAGE=reelforge-studio:e2e SKIP_BUILD=1 e2e/docker/run.sh
#   CLAUDE=1 e2e/docker/run.sh        # also: headless Claude Code makes a reel over MCP only (--max-turns 40)
#   DB=postgres e2e/docker/run.sh     # database from the compose profile (postgres | mysql); default sqlite
#   EDITION=dev e2e/docker/run.sh     # dev edition: the licence server comes from env instead
#   HARDENED=0 e2e/docker/run.sh      # plain `docker run` flags (no read-only, capabilities, seccomp profile)
#   RELEASE_IMAGE=reelforge-studio:release e2e/docker/run.sh   # also check the published release image:
#                                     # production licence settings fixed, same layers as the tested image but one
#   E2E_PREFIX=obs PORT=4331 e2e/docker/run.sh   # other container/network/volume names and host port (parallel runs)
#   SCALE=1 E2E_PREFIX=que PORT=4335 e2e/docker/run.sh   # issue #36: api + 2 workers on PostgreSQL + MinIO (scale.sh)
#   STORAGE=s3 e2e/docker/run.sh      # issue #27: then migrate to a MinIO container, restart on storage.driver s3,
#                                     # render -> MinIO -> signed download -> ffprobe, retention, readyz (storage.mjs)
#
# Issue #64 (observability): JSON logs, GET /metrics checked with promtool and scraped by an OpenTelemetry
# Collector container ("otel", OTEL_IMAGE), OTLP traces/logs/metrics selected at runtime over MCP and
# received by that collector, then the collector stopped: the studio must keep serving.
#   E2E_PREFIX=aud PORT=4333 e2e/docker/run.sh   # same, for the audit run
#
# Issue #65: audit log, key lifecycle and idempotency (audit.mjs) with the stdout and OTLP audit sinks on;
# the same collector receives the OTLP audit logs (debug exporter, detailed) and must show the entries.
#
# The data volume starts as a v0.1 filesystem data directory (seed-v01.mjs): the
# server must import it once into the database, and the e2e key is that imported
# key. POSTGRES_IMAGE / MYSQL_IMAGE select mirrors of the official images.
#
# Extra docker build args (proxy, CA secret, BASE_IMAGE mirror) go in BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/../.."
# Issue #36: SCALE=1 runs the multi-instance e2e instead (api + two workers, PostgreSQL, MinIO): e2e/docker/scale.sh.
[ "${SCALE:-}" = 1 ] && exec e2e/docker/scale.sh
IMAGE=${IMAGE:-reelforge-studio:e2e}
CLIENT_IMAGE=${CLIENT_IMAGE:-node:22-bookworm-slim}
DB=${DB:-sqlite}
EDITION=${EDITION:-release}
HARDENED=${HARDENED:-1}
P=${E2E_PREFIX:-rf-e2e}
NET=$P-net VOL=$P-data NAME=$P-server PORT=${PORT:-4321} PROJECT=$P
STORAGE=${STORAGE:-local} STORAGE_DRIVER=local MINIO=$P-minio MINIO_IMAGE=${MINIO_IMAGE:-mirror.gcr.io/minio/minio}
case "$STORAGE" in local|s3) ;; *) echo "STORAGE must be local or s3"; exit 2 ;; esac
# Licence (#25): a mock of the BuildBase licence API in its own container; the server only knows its URL.
LIC=$P-licence LIC_ORG=6b01478bb42d2c444e99fcd8-mocklice
# Observability (#64) and audit sinks (#65): one OpenTelemetry Collector ("otel") and promtool (Prometheus image).
OTEL=$P-otel OTEL_IMAGE=${OTEL_IMAGE:-mirror.gcr.io/otel/opentelemetry-collector-contrib:0.140.0} PROM_IMAGE=${PROM_IMAGE:-mirror.gcr.io/prom/prometheus:v3.7.3}
lkey() { openssl rand -hex 13 | cut -c1-25 | tr 'a-f01' 'A-FGH' | sed 's/.\{5\}/&-/g;s/-$//'; }
KEY_A=$(lkey) KEY_B=$(lkey) KEY_C=$(lkey)
LICENCE_KEYS="[\"$KEY_A\",\"$KEY_B\",\"$KEY_C\"]"
case "$DB" in sqlite|postgres|mysql) ;; *) echo "DB must be sqlite, postgres or mysql"; exit 2 ;; esac
case "$EDITION" in release|dev) ;; *) echo "EDITION must be release or dev"; exit 2 ;; esac
[ "$DB" = sqlite ] || NET=${PROJECT}_default
WORK=$(mktemp -d); chmod 755 "$WORK"
cleanup() {
  docker rm -f $NAME $LIC $OTEL $MINIO $P-nobucket >/dev/null 2>&1 || true
  [ "$DB" = sqlite ] && { docker network rm $NET >/dev/null 2>&1 || true; } || docker compose -p $PROJECT --profile "$DB" down -v >/dev/null 2>&1 || true
  docker volume rm $VOL >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT
# `docker logs X | grep -q ...` is flaky under pipefail: grep -q exits at the first
# match, docker logs then dies of SIGPIPE (exit 141) and the pipeline fails even
# though the line is there (CI run 44916484714). Read the whole log, then grep.
logs_have() { local c=$1; shift; docker logs "$c" > "$WORK/container.log" 2>&1 || true; grep -q -- "$@" "$WORK/container.log"; }

if [ "$EDITION" = release ]; then
  EDITION_ARGS=(--build-arg REELFORGE_EDITION=release --build-arg LICENCE_SERVER_URL=http://licence:8080 --build-arg LICENCE_ORG_ID=$LIC_ORG)
else
  EDITION_ARGS=(--build-arg REELFORGE_EDITION=dev)
fi
[ "${SKIP_BUILD:-}" = 1 ] || docker build ${BUILD_ARGS:-} "${EDITION_ARGS[@]}" -t "$IMAGE" .
echo "== image $IMAGE: edition $(docker image inspect -f '{{ index .Config.Labels "app.reelforge.edition" }}' "$IMAGE"), hardened run flags: $HARDENED"
[ "$(docker image inspect -f '{{ index .Config.Labels "app.reelforge.edition" }}' "$IMAGE")" = "$EDITION" ] || { echo "✘ $IMAGE is not a $EDITION build"; exit 1; }
# The hardened run flags (docs/DEPLOY.md#hardening). The image's user is 10001:10001.
HARD=()
[ "$HARDENED" = 1 ] && HARD=(--read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g --cap-drop ALL --security-opt no-new-privileges
  --security-opt "seccomp=$PWD/deployment/seccomp/chrome.json" -e REELFORGE_CHROMIUM_NO_SANDBOX=0)
# A dev build gets the mock licence server from env; a release build has it baked in.
LIC_ENV=()
[ "$EDITION" = dev ] && LIC_ENV=(-e REELFORGE_LICENCE_SERVER_URL=http://licence:8080 -e REELFORGE_LICENCE_ORG_ID=$LIC_ORG)

KEY=rf_$(openssl rand -hex 24)
PLAIN_V01=sk_v01_plaintext_$(openssl rand -hex 8)
mkdir -p "$WORK/secret" "$WORK/out" "$WORK/client" "$WORK/config" "$WORK/mock" "$WORK/otel"
printf %s "$KEY" > "$WORK/secret/key"
S3_ID=e2e$(openssl rand -hex 6) S3_SECRET=$(openssl rand -hex 20) S3_BUCKET=reelforge-e2e
printf %s "$S3_ID" > "$WORK/secret/s3id"; printf %s "$S3_SECRET" > "$WORK/secret/s3secret"
openssl rand -base64 32 > "$WORK/secret/secretkey"
# The config file (REELFORGE_CONFIG): one source of settings; env and runtime settings override it.
printf 'limits:\n  maxJsonBytes: 4194304\nlogging:\n  level: info\n' > "$WORK/config/reelforge.yaml"; chmod 644 "$WORK/config/reelforge.yaml"
DBPASS=$(openssl rand -hex 16)
case "$DB" in
  postgres) printf %s "postgresql://reelforge:$DBPASS@postgres:5432/reelforge" > "$WORK/secret/dburl" ;;
  mysql) printf %s "mysql://reelforge:$DBPASS@mysql:3306/reelforge?allowPublicKeyRetrieval=true" > "$WORK/secret/dburl" ;;
  *) : > "$WORK/secret/dburl" ;;
esac
# The server runs as UID 10001: a *_FILE secret must be readable by it.
for f in key dburl secretkey s3id s3secret; do [ -e "$WORK/secret/$f" ] || continue; chown 10001 "$WORK/secret/$f" 2>/dev/null || chmod 644 "$WORK/secret/$f"; done
chmod 777 "$WORK/out" "$WORK/otel"
cp e2e/otel/collector.yaml "$WORK/config/collector.yaml"; chmod 644 "$WORK/config/collector.yaml"
cp e2e/docker/*.mjs examples/sample-reel.json "$WORK/client/"
cp e2e/mock-licence/server.mjs "$WORK/mock/"; chmod -R a+rX "$WORK/mock"
(cd "$WORK/client" && npm init -y >/dev/null && npm i -q --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 $([ "$STORAGE" = s3 ] && echo @aws-sdk/client-s3@3.1164.0) >/dev/null)

start() {
  # The database is chosen by DATABASE_URL alone (here its _FILE variant, so the password stays out of `docker inspect`).
  local dbenv=(); [ "$DB" = sqlite ] || dbenv=(-v "$WORK/secret/dburl:/run/secrets/dburl:ro" -e DATABASE_URL_FILE=/run/secrets/dburl)
  # STORAGE=s3: the MinIO settings are always there (for `reelforge storage migrate`); storage.driver picks the driver.
  local s3env=(); [ "$STORAGE" = s3 ] && s3env=(-e REELFORGE_STORAGE_DRIVER=$STORAGE_DRIVER -e REELFORGE_S3_ENDPOINT=http://minio:9000 -e REELFORGE_S3_BUCKET=${S3_BUCKET_OVERRIDE:-$S3_BUCKET}
    -e REELFORGE_S3_FORCE_PATH_STYLE=true -v "$WORK/secret/s3id:/run/secrets/s3id:ro" -e REELFORGE_S3_ACCESS_KEY_ID_FILE=/run/secrets/s3id
    -v "$WORK/secret/s3secret:/run/secrets/s3secret:ro" -e REELFORGE_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3secret)
  docker run -d --name $NAME --network $NET --network-alias reelforge -p 127.0.0.1:$PORT:4321 --shm-size=1g "${HARD[@]}" \
    -v $VOL:/data -v "$WORK/secret/key:/run/secrets/key:ro" -e REELFORGE_BOOTSTRAP_KEY_FILE=/run/secrets/key "${dbenv[@]}" \
    -v "$WORK/secret/secretkey:/run/secrets/secretkey:ro" -e REELFORGE_SECRET_KEY_FILE=/run/secrets/secretkey \
    -v "$WORK/config/reelforge.yaml:/config/reelforge.yaml:ro" -e REELFORGE_CONFIG=/config/reelforge.yaml \
    "${LIC_ENV[@]}" "${s3env[@]}" -e REELFORGE_AUDIT_SINKS=stdout,otlp -e REELFORGE_AUDIT_OTLP_ENDPOINT=http://otel:4318/v1/logs \
    -e REELFORGE_ALLOWED_HOSTS=reelforge,reelforge:4321 "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' $NAME)" = healthy ] && return; sleep 2; done
  docker logs $NAME; echo "server did not become healthy"; exit 1
}
client() { docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -v "$WORK/otel:/otel:ro" -w /c \
  -e URL=http://reelforge:4321/mcp -e KEY="$KEY" -e SAMPLE=sample-reel.json -e PLAIN_V01="$PLAIN_V01" -e PHASE="${PHASE:-before}" -e LICENCE_KEYS="$LICENCE_KEYS" \
  -e EDITION="$EDITION" -e SANDBOX="$HARDENED" "$CLIENT_IMAGE" node "$@"; }
licence_server() {
  docker run -d --name $LIC --network $NET --network-alias licence -v "$WORK/mock:/m:ro" -e ORG_ID=$LIC_ORG \
    -e SEED_KEYS="[{\"key\":\"$KEY_A\",\"activationLimit\":1},{\"key\":\"$KEY_C\",\"activationLimit\":1}]" "$CLIENT_IMAGE" node /m/server.mjs >/dev/null
  for _ in $(seq 1 30); do logs_have $LIC 'mock licence server on' && return; sleep 1; done
  docker logs $LIC; echo "mock licence server did not start"; exit 1
}

if [ "$DB" = sqlite ]; then
  docker network create $NET >/dev/null
else
  echo "== $DB from the compose profile"
  POSTGRES_PASSWORD=$DBPASS MYSQL_PASSWORD=$DBPASS MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16) \
    docker compose -p $PROJECT --profile "$DB" up -d --wait "$DB"
fi
docker volume create $VOL >/dev/null
echo "== mock licence server (container \"licence\")"; licence_server
if [ "$STORAGE" = s3 ]; then
  echo "== MinIO (container \"minio\")"
  if ! docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 && ! docker pull -q "$MINIO_IMAGE" >/dev/null 2>&1; then
    echo "   $MINIO_IMAGE cannot be pulled (MinIO stopped publishing images in 2025): building MinIO from its official source"
    MINIO_IMAGE=$(e2e/minio/build-image.sh)
  fi
  docker run -d --name $MINIO --network $NET --network-alias minio -e MINIO_ROOT_USER="$S3_ID" -e MINIO_ROOT_PASSWORD="$S3_SECRET" "$MINIO_IMAGE" server /data >/dev/null
  for _ in $(seq 1 30); do docker run --rm --network $NET "$CLIENT_IMAGE" node -e "fetch('http://minio:9000/minio/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && break; sleep 1; done
  docker run --rm --network $NET -v "$WORK/client:/c:ro" -w /c -e S3_ID="$S3_ID" -e S3_SECRET="$S3_SECRET" "$CLIENT_IMAGE" node --input-type=module -e "
    import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
    await new S3Client({ endpoint: 'http://minio:9000', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ID, secretAccessKey: process.env.S3_SECRET } }).send(new CreateBucketCommand({ Bucket: '$S3_BUCKET' }));
    console.log('✔ bucket $S3_BUCKET created ($MINIO_IMAGE)');"
fi
echo "== OpenTelemetry Collector (container \"otel\", $OTEL_IMAGE): OTLP audit logs (#65) and telemetry (#64)"
docker run -d --name $OTEL --network $NET --network-alias otel --user 10001 -v "$WORK/config/collector.yaml:/etc/otelcol/config.yaml:ro" -v "$WORK/otel:/out" \
  "$OTEL_IMAGE" --config /etc/otelcol/config.yaml >/dev/null
for _ in $(seq 1 30); do logs_have $OTEL 'Everything is ready' && break; sleep 1; done
logs_have $OTEL 'Everything is ready' && echo "✔ collector $OTEL_IMAGE is up" || { docker logs $OTEL | tail -20; echo "✘ the collector did not start"; exit 1; }
echo "== seed a v0.1 data directory"
docker run --rm -v $VOL:/data -v "$WORK/client:/c:ro" -w /c -e KEY="$KEY" -e PLAIN_V01="$PLAIN_V01" -e SAMPLE=sample-reel.json "$CLIENT_IMAGE" \
  sh -c 'node seed-v01.mjs && chown -R 10001:10001 /data'
start
echo "== database and one-time v0.1 import"
docker logs $NAME 2>&1 | grep -oE '"msg":"(database|imported|applying)[^"]*' | sed 's/^"msg":"/   /'
logs_have $NAME "database: ${DB/postgres/postgresql} " && echo "✔ server uses $DB" || { echo "✘ server is not on $DB"; docker logs $NAME; exit 1; }
if [ "$DB" = sqlite ]; then docker exec $NAME test -s /data/reelforge.db && echo "✔ /data/reelforge.db exists"
else docker exec $NAME test ! -e /data/reelforge.db && echo "✔ no SQLite file on the volume"; fi
api() { curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT$1"; }
echo "== container hardening"
[ "$(docker exec $NAME id -u):$(docker exec $NAME id -g)" = 10001:10001 ] && echo "✔ runs as UID:GID 10001:10001" || { echo "✘ not UID 10001"; exit 1; }
docker exec $NAME sh -c 'test ! -w /app && test ! -w /app/packages/core/src/index.ts' && echo "✔ the application files are not writable by the server user" || { echo "✘ /app is writable"; exit 1; }
if [ "$HARDENED" = 1 ]; then
  hc=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}' $NAME)
  # Docker keeps the seccomp profile inline in SecurityOpt; ours carries a "ReelForge:" comment.
  case "$hc" in "true [ALL] "*no-new-privileges*"ReelForge: Chromium's namespace sandbox"*) echo "✔ --read-only, --cap-drop ALL, no-new-privileges, seccomp profile deployment/seccomp/chrome.json" ;;
    *) echo "✘ hardening flags missing: ${hc:0:200}"; exit 1 ;; esac
  docker exec $NAME sh -c 'touch /etc/rf 2>/dev/null' && { echo "✘ the root filesystem is writable"; exit 1; } || echo "✔ the root filesystem is read-only; /tmp and /data are writable: $(docker exec $NAME sh -c 'touch /tmp/rf /data/.rf && rm /tmp/rf /data/.rf && echo yes')"
  [ "$(docker exec $NAME sh -c 'grep CapEff /proc/1/status' | awk '{print $2}')" = 0000000000000000 ] && echo "✔ no effective capabilities" || { echo "✘ capabilities present"; exit 1; }
  docker exec $NAME sh -c 'grep -q "NoNewPrivs:[[:space:]]*1" /proc/1/status' && echo "✔ NoNewPrivs is set" || { echo "✘ NoNewPrivs not set"; exit 1; }
  probe=$(docker exec -i $NAME node --input-type=module < e2e/docker/sandbox-probe.mjs)
  echo "$probe" | grep '"sandboxed":true' >/dev/null && echo "✔ Chromium's own sandbox runs (renderers in a nested PID namespace): $probe" || { echo "✘ Chromium sandbox not active: $probe"; exit 1; }
fi
if [ "$EDITION" = release ]; then
  echo "== release build: licence settings fixed by the image"
  docker exec $NAME reelforge config check | sed 's/^/   /'
  # The same image refuses to start when the config file or env tries to change them.
  for override in REELFORGE_LICENCE_MODE=off REELFORGE_LICENCE_SERVER_URL=http://fake-licence.example REELFORGE_LICENCE_ORG_ID=aaaaaaaaaaaaaaaaaaaaaaaa; do
    out=$(timeout 120 docker run --rm --network none "${HARD[@]}" -e "$override" "$IMAGE" 2>&1) && { echo "✘ started with $override"; exit 1; }
    echo "$out" | grep 'fixed by this release build' >/dev/null && echo "✔ refuses to start with $override: $(echo "$out" | grep -o '"licence[^"]*" is fixed by this release build[^.]*' | head -1)" || { echo "✘ unexpected output for $override"; echo "$out" | tail -5; exit 1; }
  done
  printf 'licence:\n  mode: "off"\n' > "$WORK/config/off.yaml"; chmod 644 "$WORK/config/off.yaml"
  out=$(timeout 120 docker run --rm --network none "${HARD[@]}" -v "$WORK/config/off.yaml:/config/off.yaml:ro" -e REELFORGE_CONFIG=/config/off.yaml "$IMAGE" 2>&1) && { echo "✘ started with licence.mode off in the config file"; exit 1; }
  echo "$out" | grep '/config/off.yaml (licence.mode): "licence.mode" is fixed' >/dev/null && echo "✔ refuses to start with licence.mode: off in the config file" || { echo "✘ config file override"; echo "$out" | tail -5; exit 1; }
fi
[ "$(api /v1/projects/legacy-v01/versions)" = '{"versions":[1,2]}' ] && echo "✔ v0.1 project imported with both versions; the imported key works" || { echo "✘ v0.1 import"; api /v1/projects/legacy-v01/versions; exit 1; }
api /v1/projects/legacy-v01 | grep '"Made by v0.1, edited"' >/dev/null && echo "✔ current manifest is version 2" || { echo "✘ v0.1 manifest"; exit 1; }
api /v1/themes/legacy-theme | grep '"legacy-theme"' >/dev/null && echo "✔ v0.1 theme imported" || { echo "✘ v0.1 theme"; exit 1; }
echo "== licence: unlicensed, activate over MCP, render (mock licence server)"; PHASE=start client licence.mjs
echo "== MCP journey (separate container)"; client journey.mjs
echo "== ffprobe"; docker run --rm -v "$WORK/out:/o:ro" --entrypoint ffprobe "$IMAGE" -v error -count_frames \
  -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration -of compact /o/docker-e2e.mp4
echo "== audit log, key lifecycle, idempotency over MCP (#65, separate container)"; client audit.mjs
AUD_KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keyId"])' "$WORK/out/audit.json")
docker logs $NAME > "$WORK/server.log" 2>&1 || true
python3 - "$WORK/server.log" "$AUD_KEY" "$WORK/out/audit.json" <<'PY' || exit 1
import json, re, sys
log, key, secrets = open(sys.argv[1]).read(), sys.argv[2], json.load(open(sys.argv[3]))["secrets"]
entries = [json.loads(l) for l in log.splitlines() if l.startswith('{"type":"audit"')]
mine = [e for e in entries if e.get("targetId") == key]
ok = {"key.create", "key.rotate", "key.revoke", "auth.denied"} <= {e["action"] for e in mine} and all(e["at"].endswith("Z") and e.get("requestId") for e in mine)
print(("✔" if ok else "✘") + f" stdout sink: {len(entries)} JSON audit lines in the container log; key {key}: {sorted({e['action'] for e in mine})}")
leak = [s[:8] for s in secrets if s in log] or re.findall(r"rf_[A-Za-z0-9_-]{20,}", log)
print(("✘ the server log contains key material" if leak else "✔ no API key secret or rf_ key material in the server log (stdout sink included)"))
sys.exit(0 if ok and not leak else 1)
PY
docker logs $OTEL > "$WORK/otel.log" 2>&1 || true
grep -q "audit.target.id: Str($AUD_KEY)" "$WORK/otel.log" && grep -q 'audit.action: Str(key.rotate)' "$WORK/otel.log" && grep -q 'InstrumentationScope reelforge.audit' "$WORK/otel.log" \
  && echo "✔ OTLP sink: the collector received the key's audit entries ($(grep -c 'EventName: reelforge.audit' "$WORK/otel.log") log records)" || { echo "✘ OTLP entries missing in the collector"; tail -40 "$WORK/otel.log"; exit 1; }
logs_have $NAME 'audit sink otlp: .* not delivered to http://otel-down.invalid:4318' && echo "✔ a failing sink is visible in the server log (and the request succeeded)" || { echo "✘ the failing OTLP sink left no warning"; exit 1; }
echo "== auth, scopes, validation"; client neg.mjs
echo "== observability (#64): JSON logs, Prometheus /metrics, OTLP to an OpenTelemetry Collector (container \"otel\")"
docker logs $NAME > "$WORK/container.log" 2>&1 || true
grep -m1 '"route":"/mcp".*"status":200' "$WORK/container.log" | grep -q '"request_id":"[^"]\+".*"key_id":"[^"]\+".*"status":200,"duration_ms":' \
  && echo "✔ JSON access log lines: request id, key id, route template, status, duration ($(grep -c '"route":' "$WORK/container.log") lines)" || { echo "✘ no JSON access log"; tail -5 "$WORK/container.log"; exit 1; }
grep -q -- "$KEY" "$WORK/container.log" && { echo "✘ the server log contains the API key"; exit 1; } || echo "✔ no API key in the server log"
curl -s -D "$WORK/metrics.h" "http://127.0.0.1:$PORT/metrics" > "$WORK/metrics.txt"
grep -qi '^content-type: text/plain; version=0.0.4' "$WORK/metrics.h" && docker run --rm -i --entrypoint promtool "$PROM_IMAGE" check metrics < "$WORK/metrics.txt" \
  && echo "✔ GET /metrics passes promtool check metrics ($(grep -c '^[a-z]' "$WORK/metrics.txt") samples)" || { echo "✘ /metrics is not valid Prometheus text"; head -20 "$WORK/metrics.txt"; exit 1; }
for m in 'http_server_request_duration_seconds_bucket{.*http_route="/mcp"' 'reelforge_jobs_finished_total{.*reelforge_job_status="succeeded"' 'reelforge_render_frames_total{.*reelforge_engine="html"' 'reelforge_licence_state{reelforge_licence_state="valid"} 1' 'reelforge_jobs_queued 0'; do
  grep -q "^$m" "$WORK/metrics.txt" || { echo "✘ /metrics lacks $m"; exit 1; }; done; echo "✔ /metrics has HTTP, job, render, licence and queue metrics"
# Label values only (metric names such as reelforge_job_duration_seconds contain "job_").
grep -o '="[^"]*"' "$WORK/metrics.txt" | sort -u > "$WORK/labels.txt"
grep -Eq "(job|run|prv|key|ast)_[a-z0-9]{8,}|rf_|e2e-docker-" "$WORK/labels.txt" && { echo "✘ ids or keys in metric labels: $(grep -E '(job|run|prv|key|ast)_[a-z0-9]{8,}|rf_|e2e-docker-' "$WORK/labels.txt" | head -3)"; exit 1; } \
  || echo "✔ no ids or keys in metric labels ($(wc -l < "$WORK/labels.txt") distinct label values, bounded cardinality)"
# The collector started before the server (it already took the OTLP audit logs, #65).
docker inspect -f '{{.State.Running}}' $OTEL 2>/dev/null | grep -q true && echo "✔ collector $OTEL_IMAGE is running" || { echo "✘ collector not running"; exit 1; }
PHASE=on client obs.mjs
PHASE=check client obs.mjs || { docker logs $OTEL 2>&1 | tail -20; exit 1; }
PHASE=metrics-otlp client obs.mjs
docker stop $OTEL >/dev/null
PHASE=down client obs.mjs
logs_have $NAME 'OTLP .* export to http://otel:4318 failed' && echo "✔ the failing export is a warning in the server log: $(grep -o 'OTLP [a-z]* export to http://otel:4318 failed[^:]*' "$WORK/container.log" | head -1)" || { echo "✘ no export warning in the log"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")" = 200 ] && echo "✔ the server kept running" || { echo "✘ server down"; exit 1; }
echo "== Host/Origin checks"
mcp() { curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/mcp" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$@" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
[ "$(mcp -H 'Host: evil.example')" = 403 ] && echo "✔ forged Host → 403" || { echo "✘ forged Host not refused"; exit 1; }
[ "$(mcp -H 'Origin: https://evil.example')" = 403 ] && echo "✔ foreign Origin → 403" || { echo "✘ foreign Origin not refused"; exit 1; }
echo "== licence: offline grace (licence server stopped)"
docker stop $LIC >/dev/null
PHASE=grace client licence.mjs
logs_have $NAME 'licence: licence server unreachable' && echo "✔ the grace warning is in the server log" || { echo "✘ no grace warning in the log"; docker logs $NAME 2>&1 | grep licence; exit 1; }
echo "== licence: revoked, limit_reached, deactivate (licence server back)"
docker rm -f $LIC >/dev/null; licence_server
PHASE=revoke client licence.mjs
docker exec $NAME reelforge licence status > "$WORK/licence.txt" && grep -q '^status: *valid' "$WORK/licence.txt" && grep -q "key: *${KEY_C:0:5}-\*\*\*\*\*" "$WORK/licence.txt" \
  && echo "✔ reelforge licence status (CLI in the container): valid, key masked" || { echo "✘ reelforge licence status"; cat "$WORK/licence.txt"; exit 1; }
sed 's/^/   /' "$WORK/licence.txt" | head -6
for k in $KEY_A $KEY_B $KEY_C; do logs_have $NAME "$k" && { echo "✘ the server log contains a licence key"; exit 1; }; done; echo "✔ no licence key in the server log"
echo "== configuration over MCP (separate container)"
logs_have $NAME 'encrypted 1 stored secret(s) with REELFORGE_SECRET_KEY: ELEVENLABS_API_KEY' && echo "✔ v0.1 plaintext provider key encrypted once on start" || { echo "✘ plaintext provider key not encrypted"; docker logs $NAME; exit 1; }
logs_have $NAME 'config file: /config/reelforge.yaml' && echo "✔ config file read (REELFORGE_CONFIG)" || { echo "✘ config file not read"; exit 1; }
logs_have $NAME "$PLAIN_V01" && { echo "✘ the server log contains a secret"; exit 1; } || echo "✔ no secret in the server log"
PHASE=before client config.mjs
docker exec $NAME reelforge config check | sed 's/^/   /'
docker exec $NAME reelforge config show > "$WORK/show.txt"
grep -E '^(limits.rateLimitPerMinute|licence.key|providers.elevenlabs.apiKey) ' "$WORK/show.txt" | sed 's/^/   /'
grep -q "$PLAIN_V01\|LIC-E2E" "$WORK/show.txt" && { echo "✘ config show printed a secret"; exit 1; } || echo "✔ reelforge config show (CLI in the container) redacts secrets and shows the runtime value"
grep -Eq '^limits.rateLimitPerMinute +600 +\(runtime' "$WORK/show.txt" || { echo "✘ config show does not show the runtime value"; cat "$WORK/show.txt"; exit 1; }
echo "== restart keeps data"
before=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/projects" | md5sum)
docker rm -f $NAME >/dev/null; start
after=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/projects" | md5sum)
[ "$before" = "$after" ] && echo "✔ projects survive a new container on the same volume" || { echo "✘ projects changed after restart"; exit 1; }
logs_have $NAME 'imported v0.1' && { echo "✘ v0.1 data imported a second time"; exit 1; } || echo "✔ no second import after the restart"
logs_have $NAME 'encrypted .* stored secret' && { echo "✘ secrets encrypted a second time"; exit 1; } || echo "✔ no second encryption pass after the restart"
echo "== configuration after the restart"; PHASE=after client config.mjs
echo "== licence after the restart"; PHASE=restart client licence.mjs
[ "$(api "/v1/audit?targetId=$AUD_KEY&action=key.rotate&result=success" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["events"]))')" = 1 ] \
  && echo "✔ the audit trail survives the restart" || { echo "✘ audit trail lost after the restart"; exit 1; }
case "$DB" in
  postgres) n=$(docker compose -p $PROJECT exec -T postgres psql -U reelforge -d reelforge -tAc 'SELECT count(*) FROM "Project"') ;;
  mysql) n=$(docker compose -p $PROJECT exec -T -e MYSQL_PWD=$DBPASS mysql mysql -ureelforge reelforge -N -e 'SELECT count(*) FROM Project') ;;
  *) n=skip ;;
esac
[ "$n" = skip ] || { [ "$n" -ge 2 ] && echo "✔ $n projects are rows in $DB" || { echo "✘ expected projects in $DB, got $n"; exit 1; }; }
case "$DB" in
  postgres) aud=$(docker compose -p $PROJECT exec -T postgres psql -U reelforge -d reelforge -tAc "SELECT (SELECT count(*) FROM \"AuditLog\" WHERE \"targetId\" = '$AUD_KEY'), (SELECT count(*) FROM \"IdempotencyKey\")" | tr '|' ' ') ;;
  mysql) aud=$(docker compose -p $PROJECT exec -T -e MYSQL_PWD=$DBPASS mysql mysql -ureelforge reelforge -N -e "SELECT (SELECT count(*) FROM AuditLog WHERE targetId = '$AUD_KEY'), (SELECT count(*) FROM IdempotencyKey)" | tr '\t' ' ') ;;
  *) aud=skip ;;
esac
[ "$aud" = skip ] || { set -- $aud; [ "$1" -ge 4 ] && [ "$2" -ge 2 ] && echo "✔ audit entries ($1 for the rotated key) and idempotency keys ($2) are rows in $DB" || { echo "✘ unexpected AuditLog/IdempotencyKey rows in $DB: $aud"; exit 1; }; }
case "$DB" in
  postgres) rows=$(docker compose -p $PROJECT exec -T postgres psql -U reelforge -d reelforge -tAc 'SELECT name, scheme, value FROM "ProviderSetting" UNION ALL SELECT key, scheme, value FROM "Setting"') ;;
  mysql) rows=$(docker compose -p $PROJECT exec -T -e MYSQL_PWD=$DBPASS mysql mysql -ureelforge reelforge -N -e 'SELECT name, scheme, value FROM ProviderSetting UNION ALL SELECT `key`, scheme, value FROM Setting') ;;
  *) rows=skip ;;
esac
case "$DB" in
  postgres) lic=$(docker compose -p $PROJECT exec -T postgres psql -U reelforge -d reelforge -tAc 'SELECT * FROM "LicenceState"') ;;
  mysql) lic=$(docker compose -p $PROJECT exec -T -e MYSQL_PWD=$DBPASS mysql mysql -ureelforge reelforge -N -e 'SELECT * FROM LicenceState') ;;
  *) lic=skip ;;
esac
if [ "$lic" != skip ]; then
  echo "$lic" | grep -q "$(cat "$WORK/out/instance.txt")" && ! echo "$lic" | grep -q "$KEY_A\|$KEY_B\|$KEY_C" \
    && echo "✔ the licence state is a row in $DB (instance id, no key)" || { echo "✘ unexpected LicenceState in $DB"; echo "$lic" | cut -c1-80; exit 1; }
fi
if [ "$rows" != skip ]; then
  echo "$rows" | grep -E 'ELEVENLABS_API_KEY.aes-256-gcm' >/dev/null && echo "$rows" | grep -E 'licence.key.aes-256-gcm' >/dev/null && echo "$rows" | grep -E 'limits.rateLimitPerMinute.plain.600' >/dev/null \
    && ! echo "$rows" | grep -q "$PLAIN_V01\|LIC-E2E" && echo "✔ secrets are AES-256-GCM ciphertext in $DB; the runtime rate limit is a row" || { echo "✘ unexpected settings rows in $DB"; echo "$rows" | cut -c1-60; exit 1; }
fi

if [ "$STORAGE" = s3 ]; then
  echo "== storage: migrate local files to MinIO (reelforge storage migrate, twice: idempotent)"
  docker exec $NAME reelforge storage migrate --to s3 | tee "$WORK/migrate1.txt" | sed 's/^/   /'
  grep -Eq '^copied: [1-9][0-9]* objects' "$WORK/migrate1.txt" && echo "✔ STO-33 first run copied the local assets and renders" || { echo "✘ migrate copied nothing"; exit 1; }
  docker exec $NAME reelforge storage migrate --to s3 | tee "$WORK/migrate2.txt" | sed 's/^/   /'
  grep -Eq '^copied: 0 objects .*already there: [1-9]' "$WORK/migrate2.txt" && echo "✔ STO-33 second run copied nothing (idempotent)" || { echo "✘ migrate is not idempotent"; exit 1; }
  echo "== storage: restart on storage.driver s3"
  docker rm -f $NAME >/dev/null; STORAGE_DRIVER=s3; start
  logs_have $NAME '"msg":"storage: s3 ' && echo "✔ the server uses the s3 driver" || { echo "✘ not on s3"; docker logs $NAME | tail; exit 1; }
  curl -s "http://127.0.0.1:$PORT/readyz" | grep -q '"storage":"ok"' && echo "✔ /readyz: storage ok" || { echo "✘ /readyz storage"; curl -s "http://127.0.0.1:$PORT/readyz"; exit 1; }
  docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -w /c -e URL=http://reelforge:4321/mcp -e KEY="$KEY" -e SAMPLE=sample-reel.json \
    -e S3_ENDPOINT=http://minio:9000 -e S3_ID="$S3_ID" -e S3_SECRET="$S3_SECRET" -e S3_BUCKET="$S3_BUCKET" "$CLIENT_IMAGE" node storage.mjs
  echo "== ffprobe (render stored in MinIO, downloaded through the signed URL)"
  docker run --rm -v "$WORK/out:/o:ro" --entrypoint ffprobe "$IMAGE" -v error -count_frames \
    -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration -of compact /o/storage-e2e.mp4 | tee "$WORK/probe.txt" | sed 's/^/   /'
  grep -q 'codec_name=h264|width=1080|height=1920' "$WORK/probe.txt" && echo "✔ STO-31 decodable 1080x1920 H.264" || { echo "✘ ffprobe"; exit 1; }
  run=$(cat "$WORK/out/storage-render.txt")
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/renders/$run/output" -r 0-99)
  echo "   GET /v1/renders/$run/output (Range 0-99, deleted by retention) -> $code"
  [ "$code" = 404 ] && echo "✔ STO-34 the render deleted by retention is gone from the API too" || { echo "✘ deleted render still served ($code)"; exit 1; }
  latest=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/projects/storage-e2e/renders" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).renders[0].renderId))')
  hdr=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $KEY" -r 0-99 "http://127.0.0.1:$PORT/v1/renders/$latest/output")
  echo "$hdr" | grep -q '^HTTP/1.1 206' && echo "$hdr" | grep -qi '^content-range: bytes 0-99/' && echo "✔ STO-32 REST output streamed from MinIO through the server with Range (206)" || { echo "✘ Range through the server"; echo "$hdr"; exit 1; }
  docker exec $NAME reelforge storage cleanup --dry-run | sed 's/^/   /'
  docker exec $NAME reelforge storage status > "$WORK/storage-status.txt" && grep -q '^health: *ok' "$WORK/storage-status.txt" && echo "✔ reelforge storage status (CLI in the container): s3, health ok" || { echo "✘ storage status"; cat "$WORK/storage-status.txt"; exit 1; }
  logs_have $NAME "$S3_SECRET" && { echo "✘ the server log contains the storage secret"; exit 1; } || echo "✔ STO-24 no storage secret in the server log"
  echo "== storage: a missing bucket is reported by /readyz"
  NAME_SAVE=$NAME; NAME=$P-nobucket; S3_BUCKET_OVERRIDE=missing-bucket-$P
  docker run -d --name $NAME --network $NET "${HARD[@]}" --tmpfs /data:rw,uid=10001,gid=10001 -e REELFORGE_STORAGE_DRIVER=s3 -e REELFORGE_S3_ENDPOINT=http://minio:9000 \
    -e REELFORGE_S3_BUCKET=$S3_BUCKET_OVERRIDE -e REELFORGE_S3_FORCE_PATH_STYLE=true -e REELFORGE_S3_ACCESS_KEY_ID_FILE=/run/secrets/s3id -e REELFORGE_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3secret \
    -v "$WORK/secret/s3id:/run/secrets/s3id:ro" -v "$WORK/secret/s3secret:/run/secrets/s3secret:ro" "${LIC_ENV[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' $NAME)" = healthy ] && break; sleep 2; done
  ready=$(docker exec $NAME node -e "fetch('http://127.0.0.1:4321/readyz').then(async r=>console.log(r.status, await r.text()))")
  echo "   $ready" | cut -c1-240
  echo "$ready" | grep -q '^503 .*"storage":"unavailable (s3): bucket \\"missing-bucket' && echo "✔ STO-25 /readyz is 503 with a clear storage message" || { echo "✘ /readyz did not report the missing bucket"; exit 1; }
  docker rm -f $NAME >/dev/null; NAME=$NAME_SAVE; unset S3_BUCKET_OVERRIDE
fi

if [ -n "${RELEASE_IMAGE:-}" ]; then
  echo "== the published release image ($RELEASE_IMAGE)"
  [ "$(docker image inspect -f '{{ index .Config.Labels "app.reelforge.edition" }}' "$RELEASE_IMAGE")" = release ] && echo "✔ $RELEASE_IMAGE is a release build" || { echo "✘ $RELEASE_IMAGE is not a release build"; exit 1; }
  docker run --rm --network none "${HARD[@]}" -e REELFORGE_DATA_DIR=/tmp/d "$RELEASE_IMAGE" reelforge config show --offline > "$WORK/release-show.txt"
  grep -E '^licence\.(mode|serverUrl|orgId) ' "$WORK/release-show.txt" | sed 's/^/   /'
  grep -Eq '^licence\.mode +"required" +\(build: release build' "$WORK/release-show.txt" \
    && grep -Eq '^licence\.serverUrl +"https://api\.console\.buildbase\.app" +\(build' "$WORK/release-show.txt" \
    && grep -Eq '^licence\.orgId +"6b01478bb42d2c444e99fcd8" +\(build' "$WORK/release-show.txt" \
    && echo "✔ licence.mode required, BuildBase production server and organisation, all fixed by the build" || { echo "✘ release licence settings"; cat "$WORK/release-show.txt"; exit 1; }
  # The tested image and the published one share every layer but the edition step's.
  a=$(docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' "$IMAGE"); b=$(docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}' "$RELEASE_IMAGE")
  na=$(grep -c . <<< "$a"); nb=$(grep -c . <<< "$b")
  differ=$(paste <(echo "$a") <(echo "$b") | awk '$1 != $2' | wc -l)
  [ "$na" = "$nb" ] && [ "$differ" = 1 ] \
    && echo "✔ $IMAGE and $RELEASE_IMAGE share $((na - 1)) of $na layers; only the edition step's layer (build-info.json) differs" || { echo "✘ the images differ in $differ of $na layers (expected 1)"; exit 1; }
fi

if [ "${CLAUDE:-}" = 1 ]; then
  echo "== headless Claude Code, MCP only, against $IMAGE (--max-turns 40)"
  umask 077; printf '{"mcpServers":{"reelforge":{"type":"http","url":"http://127.0.0.1:%s/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$PORT" "$KEY" > "$WORK/mcp.json"
  started=$(date +%s)
  claude -p "You are connected to a ReelForge video studio through the 'reelforge' MCP server. Make a 15 to 20 second vertical reel with 3 tips for writing better product hooks. Plan the scenes, engines, templates, per-scene timing and theme yourself, render it, wait for it to finish, and reply with the project id, job id, render id, duration, frame count and download URL. Use only the reelforge tools." \
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --allowedTools mcp__reelforge --max-turns 40 --output-format json < /dev/null > "$WORK/claude.json" || true
  umask 022
  python3 - "$WORK/claude.json" "$(( $(date +%s) - started ))" <<'PY' | tee "$WORK/claude-summary.txt"
import json, sys
r = json.load(open(sys.argv[1]))
print(f"   result: {r.get('subtype')}  is_error: {r.get('is_error')}  turns: {r.get('num_turns')}  wall time: {sys.argv[2]} s  "
      f"duration_ms: {r.get('duration_ms')}  cost_usd: {r.get('total_cost_usd')}")
print("   reply: " + (r.get('result') or '').replace('\n', '\n          ')[:1500])
PY
  grep -q 'is_error: False' "$WORK/claude-summary.txt" || { echo "✘ the Claude run did not finish cleanly"; exit 1; }
  # The newest render on the volume is the agent's: decode and probe it.
  latest=$(docker exec $NAME sh -c 'ls -td /data/projects/*/renders/run_* 2>/dev/null | head -1')
  [ -n "$latest" ] && docker exec $NAME ls "$latest" >/dev/null || { echo "✘ no render found on the volume"; exit 1; }
  file=$latest/final.mp4
  echo "   render: $file"
  docker exec $NAME ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration -of compact "$file" | sed 's/^/   /'
  docker exec $NAME ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$file" | head -1 | grep -qx '1080,1920' && echo "✔ the agent's reel is a decodable 1080×1920 MP4" || { echo "✘ the agent's render is not 1080×1920"; exit 1; }
fi
echo "ALL DOCKER E2E CHECKS PASSED (DB=$DB, EDITION=$EDITION, HARDENED=$HARDENED, STORAGE=$STORAGE)"
