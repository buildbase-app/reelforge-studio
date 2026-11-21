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
#   E2E_PREFIX=aud PORT=4333 e2e/docker/run.sh   # own container/network/volume names and host port (parallel runs)
#
# Issue #65: audit log, key lifecycle and idempotency (audit.mjs) with the stdout and OTLP audit sinks on;
# an OpenTelemetry Collector container (OTEL_IMAGE) receives the OTLP logs and must show the entries.
#
# The data volume starts as a v0.1 filesystem data directory (seed-v01.mjs): the
# server must import it once into the database, and the e2e key is that imported
# key. POSTGRES_IMAGE / MYSQL_IMAGE select mirrors of the official images.
#
# Extra docker build args (proxy, CA secret, BASE_IMAGE mirror) go in BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=${IMAGE:-reelforge-studio:e2e}
CLIENT_IMAGE=${CLIENT_IMAGE:-node:22-bookworm-slim}
DB=${DB:-sqlite}
EDITION=${EDITION:-release}
HARDENED=${HARDENED:-1}
P=${E2E_PREFIX:-e2e}
NET=rf-$P-net VOL=rf-$P-data NAME=rf-$P-server PORT=${PORT:-4321} PROJECT=rf-$P
# Licence (#25): a mock of the BuildBase licence API in its own container; the server only knows its URL.
LIC=rf-$P-licence LIC_ORG=6b01478bb42d2c444e99fcd8-mocklice
# Audit sinks (#65): an OpenTelemetry Collector (OTLP/HTTP receiver, debug exporter) as container "otel".
OTEL=rf-$P-otel OTEL_IMAGE=${OTEL_IMAGE:-otel/opentelemetry-collector:0.140.0}
lkey() { openssl rand -hex 13 | cut -c1-25 | tr 'a-f01' 'A-FGH' | sed 's/.\{5\}/&-/g;s/-$//'; }
KEY_A=$(lkey) KEY_B=$(lkey) KEY_C=$(lkey)
LICENCE_KEYS="[\"$KEY_A\",\"$KEY_B\",\"$KEY_C\"]"
case "$DB" in sqlite|postgres|mysql) ;; *) echo "DB must be sqlite, postgres or mysql"; exit 2 ;; esac
case "$EDITION" in release|dev) ;; *) echo "EDITION must be release or dev"; exit 2 ;; esac
[ "$DB" = sqlite ] || NET=${PROJECT}_default
WORK=$(mktemp -d); chmod 755 "$WORK"
cleanup() {
  docker rm -f $NAME $LIC $OTEL >/dev/null 2>&1 || true
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
for f in key dburl secretkey; do chown 10001 "$WORK/secret/$f" 2>/dev/null || chmod 644 "$WORK/secret/$f"; done
chmod 777 "$WORK/out"
cp e2e/docker/*.mjs examples/sample-reel.json "$WORK/client/"
cp e2e/mock-licence/server.mjs "$WORK/mock/"; chmod -R a+rX "$WORK/mock"
printf 'receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  debug:\n    verbosity: detailed\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n' > "$WORK/otel/config.yaml"; chmod -R a+rX "$WORK/otel"
(cd "$WORK/client" && npm init -y >/dev/null && npm i -q --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 >/dev/null)

start() {
  # The database is chosen by DATABASE_URL alone (here its _FILE variant, so the password stays out of `docker inspect`).
  local dbenv=(); [ "$DB" = sqlite ] || dbenv=(-v "$WORK/secret/dburl:/run/secrets/dburl:ro" -e DATABASE_URL_FILE=/run/secrets/dburl)
  docker run -d --name $NAME --network $NET --network-alias reelforge -p 127.0.0.1:$PORT:4321 --shm-size=1g "${HARD[@]}" \
    -v $VOL:/data -v "$WORK/secret/key:/run/secrets/key:ro" -e REELFORGE_BOOTSTRAP_KEY_FILE=/run/secrets/key "${dbenv[@]}" \
    -v "$WORK/secret/secretkey:/run/secrets/secretkey:ro" -e REELFORGE_SECRET_KEY_FILE=/run/secrets/secretkey \
    -v "$WORK/config/reelforge.yaml:/config/reelforge.yaml:ro" -e REELFORGE_CONFIG=/config/reelforge.yaml \
    "${LIC_ENV[@]}" -e REELFORGE_AUDIT_SINKS=stdout,otlp -e REELFORGE_AUDIT_OTLP_ENDPOINT=http://otel:4318/v1/logs \
    -e REELFORGE_ALLOWED_HOSTS=reelforge,reelforge:4321 "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' $NAME)" = healthy ] && return; sleep 2; done
  docker logs $NAME; echo "server did not become healthy"; exit 1
}
client() { docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -w /c \
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
echo "== OpenTelemetry Collector (container \"otel\", $OTEL_IMAGE)"
docker run -d --name $OTEL --network $NET --network-alias otel -v "$WORK/otel/config.yaml:/etc/otelcol/config.yaml:ro" "$OTEL_IMAGE" --config /etc/otelcol/config.yaml >/dev/null
for _ in $(seq 1 30); do logs_have $OTEL 'Everything is ready' && break; sleep 1; done
logs_have $OTEL 'Everything is ready' || { docker logs $OTEL; echo "✘ the collector did not start"; exit 1; }
echo "== seed a v0.1 data directory"
docker run --rm -v $VOL:/data -v "$WORK/client:/c:ro" -w /c -e KEY="$KEY" -e PLAIN_V01="$PLAIN_V01" -e SAMPLE=sample-reel.json "$CLIENT_IMAGE" \
  sh -c 'node seed-v01.mjs && chown -R 10001:10001 /data'
start
echo "== database and one-time v0.1 import"
docker logs $NAME 2>&1 | grep -E '\[reelforge\] (database|imported|applying)' | sed 's/^/   /'
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
echo "ALL DOCKER E2E CHECKS PASSED (DB=$DB, EDITION=$EDITION, HARDENED=$HARDENED)"
