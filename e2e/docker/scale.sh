#!/usr/bin/env bash
# Docker e2e for more than one instance (issue #36): one `api` container and two
# `worker` containers of the same (release, hardened) image on PostgreSQL and
# MinIO (S3), driven over MCP from a separate client container that only knows
# the api. Checks (ids in docs/providers/queue-and-scaling.md):
#   - the role guard refuses a worker on SQLite or on local storage, and a bad role (SCL-10)
#   - workers serve only /healthz, /readyz, /metrics (SCL-11)
#   - several renders are spread over both workers, each runs exactly once, the api renders nothing (SCL-12)
#   - a worker killed mid-render (SIGKILL): the job is re-queued after its lease and finished by the other (SCL-13)
#   - cancel_job on the api stops a job running on a worker (SCL-14)
#   - docker stop (SIGTERM) on a busy worker hands its job back; the other finishes it (SCL-15)
#   - storage down: workers stop claiming, /readyz 503, the job waits and runs once MinIO is back (SCL-16)
#   - database down: no crash loop, /readyz 503 with the reason, back to work when it returns (SCL-17)
#   - metrics per role, bounded labels, no secrets in any log (SCL-18)
#
#   SCALE=1 e2e/docker/run.sh                       # same as e2e/docker/scale.sh
#   IMAGE=reelforge-studio:que SKIP_BUILD=1 E2E_PREFIX=que PORT=4335 e2e/docker/scale.sh
# BUILD_ARGS, CLIENT_IMAGE, POSTGRES_IMAGE, MINIO_IMAGE as in run.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=${IMAGE:-reelforge-studio:e2e}
CLIENT_IMAGE=${CLIENT_IMAGE:-node:22-bookworm-slim}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-mirror.gcr.io/library/postgres:17}
MINIO_IMAGE=${MINIO_IMAGE:-mirror.gcr.io/minio/minio}
P=${E2E_PREFIX:-rf-scale}
PORT=${PORT:-4335}
NET=$P-net PG=$P-postgres MINIO=$P-minio LIC=$P-licence API=$P-api W1=$P-w1 W2=$P-w2
LIC_ORG=6b01478bb42d2c444e99fcd8-mocklice
WORK=$(mktemp -d); chmod 755 "$WORK"
cleanup() {
  docker rm -f $API $W1 $W2 $PG $MINIO $LIC $P-neg >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
logs_have() { local c=$1; shift; docker logs "$c" > "$WORK/c.log" 2>&1 || true; grep -q -- "$@" "$WORK/c.log"; }
fail() { echo "✘ $*"; exit 1; }

[ "${SKIP_BUILD:-}" = 1 ] || docker build ${BUILD_ARGS:-} --build-arg REELFORGE_EDITION=release --build-arg LICENCE_SERVER_URL=http://licence:8080 --build-arg LICENCE_ORG_ID=$LIC_ORG -t "$IMAGE" .
echo "== image $IMAGE (edition $(docker image inspect -f '{{ index .Config.Labels "app.reelforge.edition" }}' "$IMAGE")), hardened run flags"
HARD=(--read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g --tmpfs /data:rw,uid=10001,gid=10001,size=2g --cap-drop ALL --security-opt no-new-privileges
  --security-opt "seccomp=$PWD/deployment/seccomp/chrome.json" -e REELFORGE_CHROMIUM_NO_SANDBOX=0 --shm-size=1g)

KEY=rf_$(openssl rand -hex 24) DBPASS=$(openssl rand -hex 16) S3_ID=e2e$(openssl rand -hex 6) S3_SECRET=$(openssl rand -hex 20) S3_BUCKET=reelforge-scale
lkey() { openssl rand -hex 13 | cut -c1-25 | tr 'a-f01' 'A-FGH' | sed 's/.\{5\}/&-/g;s/-$//'; }
LICENCE_KEY=$(lkey)
mkdir -p "$WORK/secret" "$WORK/client" "$WORK/out" "$WORK/mock"
printf %s "$KEY" > "$WORK/secret/key"; printf %s "$S3_ID" > "$WORK/secret/s3id"; printf %s "$S3_SECRET" > "$WORK/secret/s3secret"
printf %s "postgresql://reelforge:$DBPASS@postgres:5432/reelforge" > "$WORK/secret/dburl"; printf %s "$LICENCE_KEY" > "$WORK/secret/licence"
openssl rand -base64 32 > "$WORK/secret/secretkey"
for f in "$WORK"/secret/*; do chown 10001 "$f" 2>/dev/null || chmod 644 "$f"; done
chmod 777 "$WORK/out"
cp e2e/docker/scale.mjs examples/sample-reel.json "$WORK/client/"; cp e2e/mock-licence/server.mjs "$WORK/mock/"; chmod -R a+rX "$WORK/mock" "$WORK/client"
(cd "$WORK/client" && npm init -y >/dev/null && npm i -q --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 @aws-sdk/client-s3@3.1164.0 >/dev/null)

docker network create $NET >/dev/null
echo "== PostgreSQL ($POSTGRES_IMAGE), MinIO, mock licence server"
docker run -d --name $PG --network $NET --network-alias postgres -e POSTGRES_USER=reelforge -e POSTGRES_PASSWORD="$DBPASS" -e POSTGRES_DB=reelforge "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec $PG pg_isready -U reelforge -d reelforge >/dev/null 2>&1 && break; sleep 1; done
if ! docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 && ! docker pull -q "$MINIO_IMAGE" >/dev/null 2>&1; then
  MINIO_IMAGE=reelforge-e2e/minio:source
  docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 || MINIO_IMAGE=$(e2e/minio/build-image.sh)
fi
docker run -d --name $MINIO --network $NET --network-alias minio -e MINIO_ROOT_USER="$S3_ID" -e MINIO_ROOT_PASSWORD="$S3_SECRET" "$MINIO_IMAGE" server /data >/dev/null
minio_ready() { docker run --rm --network $NET "$CLIENT_IMAGE" node -e "fetch('http://minio:9000/minio/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
for _ in $(seq 1 30); do minio_ready && break; sleep 1; done
docker run --rm --network $NET -v "$WORK/client:/c:ro" -w /c -e S3_ID="$S3_ID" -e S3_SECRET="$S3_SECRET" "$CLIENT_IMAGE" node --input-type=module -e "
  import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
  await new S3Client({ endpoint: 'http://minio:9000', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ID, secretAccessKey: process.env.S3_SECRET } }).send(new CreateBucketCommand({ Bucket: '$S3_BUCKET' }));"
docker run -d --name $LIC --network $NET --network-alias licence -v "$WORK/mock:/m:ro" -e ORG_ID=$LIC_ORG \
  -e SEED_KEYS="[{\"key\":\"$LICENCE_KEY\",\"activationLimit\":1}]" "$CLIENT_IMAGE" node /m/server.mjs >/dev/null
echo "✔ postgres, minio ($MINIO_IMAGE, bucket $S3_BUCKET) and the licence mock are up"

COMMON=(--network $NET "${HARD[@]}"
  -v "$WORK/secret:/run/secrets/rf:ro" -e DATABASE_URL_FILE=/run/secrets/rf/dburl -e REELFORGE_SECRET_KEY_FILE=/run/secrets/rf/secretkey
  -e REELFORGE_STORAGE_DRIVER=s3 -e REELFORGE_S3_ENDPOINT=http://minio:9000 -e REELFORGE_S3_BUCKET=$S3_BUCKET -e REELFORGE_S3_FORCE_PATH_STYLE=true
  -e REELFORGE_S3_ACCESS_KEY_ID_FILE=/run/secrets/rf/s3id -e REELFORGE_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/rf/s3secret
  -e REELFORGE_STORAGE_MAX_ATTEMPTS=2 -e REELFORGE_STORAGE_CONNECT_TIMEOUT_SECONDS=3
  -e REELFORGE_LICENCE_KEY_FILE=/run/secrets/rf/licence -e REELFORGE_QUEUE_LEASE_SECONDS=8 -e REELFORGE_QUEUE_POLL_INTERVAL_MS=500 -e REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS=2 -e REELFORGE_DB_CONNECT_TIMEOUT_SECONDS=5)

echo "== role guard (SCL-10)"
expect_refusal() { # name, pattern, docker run args...
  local name=$1 pattern=$2; shift 2
  out=$(timeout 120 docker run --rm --name $P-neg --network $NET "${HARD[@]}" "$@" "$IMAGE" 2>&1) && fail "$name: the container started"
  echo "$out" | grep -q -- "$pattern" && echo "✔ $name: $(echo "$out" | grep -o -- "$pattern[^|\"]*" | head -1 | cut -c1-160)" || { echo "$out" | tail -5; fail "$name: unexpected output"; }
}
expect_refusal "worker on SQLite refused" 'needs a shared database: SQLite' -e REELFORGE_ROLE=worker -e REELFORGE_STORAGE_LOCAL_SHARED=true
expect_refusal "worker on local storage refused" 'needs storage every instance can read' -e REELFORGE_ROLE=worker -v "$WORK/secret:/run/secrets/rf:ro" -e DATABASE_URL_FILE=/run/secrets/rf/dburl
expect_refusal "unknown role refused" 'REELFORGE_ROLE: Invalid option' -e REELFORGE_ROLE=boss
echo "$out" | grep -q "$DBPASS" && fail "the refusal printed the database password" || true

echo "== api container (role api) and two workers (role worker)"
docker run -d --name $API --hostname $P-api --network-alias api -p 127.0.0.1:$PORT:4321 "${COMMON[@]}" -e REELFORGE_ROLE=api \
  -e REELFORGE_BOOTSTRAP_KEY_FILE=/run/secrets/rf/key -e REELFORGE_ALLOWED_HOSTS=api,api:4321 "$IMAGE" >/dev/null
healthy() { for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] && return 0; sleep 2; done; docker logs "$1" | tail -20; fail "$1 did not become healthy"; }
healthy $API
api() { curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT$1"; }
for _ in $(seq 1 30); do api /v1/licence | grep -q '"status":"valid"' && break; sleep 1; done
api /v1/licence | grep -q '"status":"valid"' && echo "✔ licence activated by the api (mock licence server)" || fail "licence not valid: $(api /v1/licence)"
for w in $W1 $W2; do docker run -d --name $w --hostname $w "${COMMON[@]}" -e REELFORGE_ROLE=worker "$IMAGE" >/dev/null; done
healthy $W1; healthy $W2
logs_have $API '"msg":"role: api; job queue: database (worker '"$P-api"'-[0-9a-f]*, enqueues only, never renders)' && echo "✔ api: database queue, enqueues only" || fail "api start-up line"
logs_have $W1 '"msg":"role worker: renders jobs from the database queue' && echo "✔ workers: render from the database queue" || fail "worker start-up line"

echo "== workers serve only health, readiness and metrics (SCL-11)"
wget_() { docker exec "$1" node -e "fetch('http://127.0.0.1:4321$2').then(async r=>{console.log(r.status, (await r.text()).slice(0,${3:-400}))},e=>console.log('ERR',e.message))"; }
r=$(wget_ $W1 /v1/projects); echo "$r" | grep -q '^404 .*this instance is a worker' && echo "✔ worker GET /v1/projects → 404: send REST and MCP calls to an api instance" || fail "worker /v1: $r"
r=$(wget_ $W1 /mcp); echo "$r" | grep -q '^404' && echo "✔ worker /mcp → 404" || fail "worker /mcp: $r"
r=$(wget_ $W1 /readyz 4000); echo "$r" | grep -q '^200 .*"queue":{"status":"ok","required":false,"role":"worker","mode":"database","renders":true' && echo "✔ worker /readyz 200 with queue role worker" || fail "worker readyz: $r"
curl -s "http://127.0.0.1:$PORT/readyz" | grep -q '"role":"api","mode":"database","renders":false' && echo "✔ api /readyz: role api, renders false" || fail "api readyz"

client() { docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -w /c -e URL=http://api:4321/mcp -e KEY="$KEY" -e SAMPLE=sample-reel.json -e PHASE="$1" "$CLIENT_IMAGE" node scale.mjs; }
psql_() { docker exec $PG psql -U reelforge -d reelforge -tAc "$1"; }
client setup

echo "== renders spread over the workers, each once, none on the api (SCL-12)"
JOBS=6 client render
python3 - "$WORK/out/scale-render.json" "$W1" "$W2" <<'PY' || exit 1
import json, sys
jobs, w1, w2 = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
workers = {j["workerId"].rsplit("-", 1)[0] for j in jobs}
ok = workers == {w1, w2} and all(j["attempts"] == 1 for j in jobs)
print(("✔" if ok else "✘") + f" {len(jobs)} jobs on {sorted(workers)}, attempts {[j['attempts'] for j in jobs]}")
sys.exit(0 if ok else 1)
PY
ids=$(python3 -c 'import json,sys; print(",".join("'"'"'"+j["id"]+"'"'"'" for j in json.load(open(sys.argv[1]))))' "$WORK/out/scale-render.json")
runs=$(psql_ "SELECT count(*) FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\" IN ($ids)")
[ "$runs" = 6 ] && echo "✔ the database has exactly one 'running' event per job (6)" || fail "running events: $runs"
onapi=$(psql_ "SELECT count(*) FROM \"Job\" WHERE \"workerId\" LIKE '$P-api%'")
[ "$onapi" = 0 ] && echo "✔ no job was claimed by the api container" || fail "$onapi jobs claimed by the api"
curl -s "http://127.0.0.1:$PORT/metrics" > "$WORK/api-metrics.txt"
grep -q '^reelforge_server_role{reelforge_role="api"} 1' "$WORK/api-metrics.txt" || fail "api role gauge"
grep -Eq '^reelforge_(render_frames_total|jobs_finished_total)\{' "$WORK/api-metrics.txt" && fail "the api container rendered or finished jobs" || echo "✔ api /metrics: role api, no rendered frames, no finished jobs"
# The whole output first (a `| head` would SIGPIPE docker under pipefail).
docker run --rm -v "$WORK/out:/o:ro" --entrypoint ffprobe "$IMAGE" -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames -of compact /o/scale-e2e.mp4 > "$WORK/probe.txt"
sed 's/^/   /' "$WORK/probe.txt"
grep -q 'codec_name=h264|width=1080|height=1920' "$WORK/probe.txt" && echo "✔ the render made on a worker and stored in MinIO is a 1080x1920 H.264 MP4" || fail "ffprobe"

echo "== a worker killed mid-render (SIGKILL) (SCL-13)"
client start
victim=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["workerId"].rsplit("-",1)[0])' "$WORK/out/scale-slow.json")
docker kill $victim >/dev/null && echo "   killed $victim (SIGKILL) while it rendered"
client finish
python3 - "$WORK/out/scale-finish.json" "$victim" <<'PY' || exit 1
import json, sys
j, victim = json.load(open(sys.argv[1])), sys.argv[2]
ok = j["status"] == "succeeded" and j["attempts"] == 2 and not j["workerId"].startswith(victim)
print(("✔" if ok else "✘") + f" re-queued after the lease and finished by {j['workerId']} on attempt {j['attempts']}")
sys.exit(0 if ok else 1)
PY
docker start $victim >/dev/null; healthy $victim; echo "✔ $victim restarted and healthy"

echo "== cancel from the api (SCL-14)"
client cancel

echo "== docker stop (SIGTERM) on a busy worker (SCL-15)"
client start
busy=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["workerId"].rsplit("-",1)[0])' "$WORK/out/scale-slow.json")
docker stop -t 30 $busy >/dev/null
logs_have $busy '"msg":"shutdown: stopped claiming jobs; 0 running job(s) finished, 1 handed back to the queue' && echo "✔ $busy stopped claiming and handed its job back after the 2 s grace" || { tail -5 "$WORK/c.log"; fail "no hand-back line"; }
client finish
python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); sys.exit(0 if j["status"]=="succeeded" and j["attempts"]==1 and not j["workerId"].startswith(sys.argv[2]) else 1)' "$WORK/out/scale-finish.json" "$busy" \
  && echo "✔ the other worker finished it (the hand-back does not count as an attempt)" || fail "after graceful stop: $(cat "$WORK/out/scale-finish.json")"
docker start $busy >/dev/null; healthy $busy

echo "== storage down (SCL-16)"
docker stop $MINIO >/dev/null
for _ in $(seq 1 30); do r=$(wget_ $W1 /readyz 4000); echo "$r" | grep -q '^503' && break; sleep 2; done
echo "$r" | grep -q '^503 .*"storage":"unavailable (s3)' && echo "✔ worker /readyz 503: storage unavailable (s3)" || fail "worker readyz with MinIO down: ${r:0:300}"
# Each worker re-checks its storage at most every 10 s before claiming: wait until both have paused.
for w in $W1 $W2; do for _ in $(seq 1 30); do logs_have $w '"msg":"queue: not claiming jobs: storage (s3) is unavailable' && break; sleep 1; done; done
logs_have $W1 '"msg":"queue: not claiming jobs: storage (s3) is unavailable' && logs_have $W2 '"msg":"queue: not claiming jobs: storage (s3) is unavailable' \
  && echo "✔ both worker logs say why they stopped claiming" || fail "no pause line in a worker log"
client submit
sleep 8
st=$(psql_ "SELECT status FROM \"Job\" WHERE id = '$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$WORK/out/scale-queued.json")'")
[ "$st" = queued ] && echo "✔ the job stays queued while storage is down (workers do not claim and burn attempts)" || fail "job is $st with storage down"
docker start $MINIO >/dev/null; for _ in $(seq 1 30); do minio_ready && break; sleep 1; done
client wait
for _ in $(seq 1 15); do wget_ $W1 /readyz | grep -q '^200' && break; sleep 2; done
wget_ $W1 /readyz | grep -q '^200' && echo "✔ worker /readyz back to 200" || fail "worker not ready after MinIO came back"

echo "== database down (SCL-17)"
docker stop $PG >/dev/null
for _ in $(seq 1 30); do code=$(curl -s -o "$WORK/ready.json" -w '%{http_code}' "http://127.0.0.1:$PORT/readyz"); [ "$code" = 503 ] && break; sleep 2; done
[ "$code" = 503 ] && grep -q '"database":"unreachable' "$WORK/ready.json" && echo "✔ api /readyz 503: database unreachable" || fail "api readyz with the database down: $code $(head -c 300 "$WORK/ready.json")"
sleep 12
r=$(wget_ $W1 /readyz 4000); echo "$r" | grep -q '^503 .*"database":"unreachable' && echo "✔ worker /readyz 503: database unreachable" || fail "worker readyz: ${r:0:300}"
for c in $API $W1 $W2; do [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' $c)" = "true 0" ] || fail "$c is not running"; done
echo "✔ api and workers keep running (no crash loop)"
logs_have $W1 '"msg":"queue: [a-z]* failed (retrying with backoff)' && echo "✔ worker log: $(grep -o '"msg":"queue: [a-z]* failed (retrying with backoff)' "$WORK/c.log" | head -1 | cut -c8-)" || fail "no backoff line in the worker log"
docker start $PG >/dev/null; for _ in $(seq 1 60); do docker exec $PG pg_isready -U reelforge -d reelforge >/dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/readyz")" = 200 ] && break; sleep 2; done
client submit; client wait
echo "✔ after the database came back the api and workers serve and render again"

echo "== metrics and logs (SCL-18)"
docker exec $W1 node -e "fetch('http://127.0.0.1:4321/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))" > "$WORK/w-metrics.txt"
grep -q '^reelforge_server_role{reelforge_role="worker"} 1' "$WORK/w-metrics.txt" && grep -q '^reelforge_jobs_queued [0-9]' "$WORK/w-metrics.txt" && grep -q '^reelforge_jobs_finished_total{' "$WORK/w-metrics.txt" \
  && echo "✔ worker /metrics: role worker, reelforge_jobs_queued, finished jobs" || fail "worker metrics"
grep -h -o '="[^"]*"' "$WORK/w-metrics.txt" "$WORK/api-metrics.txt" | sort -u > "$WORK/labels.txt"
grep -Eq "(job|run|prv|key)_[a-z0-9]{8,}|rf_|$P-" "$WORK/labels.txt" && fail "ids, worker names or keys in metric labels" || echo "✔ bounded metric labels ($(wc -l < "$WORK/labels.txt") distinct values, no ids or worker names)"
for c in $API $W1 $W2; do docker logs $c >> "$WORK/all.log" 2>&1 || true; done
for s in "$KEY" "$DBPASS" "$S3_SECRET" "$(cat "$WORK/secret/secretkey")" "$LICENCE_KEY"; do grep -qF -- "$s" "$WORK/all.log" && fail "a secret is in a container log"; done
echo "✔ no API key, database password, S3 secret, REELFORGE_SECRET_KEY or licence key in any container log ($(wc -l < "$WORK/all.log") lines)"
echo "ALL SCALE E2E CHECKS PASSED (api + 2 workers, PostgreSQL, MinIO, image $IMAGE)"
