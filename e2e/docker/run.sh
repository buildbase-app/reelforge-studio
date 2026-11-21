#!/usr/bin/env bash
# Docker end-to-end acceptance (issue #16): builds the image, runs the server,
# then drives it from a SEPARATE container on a Docker network (an agent on
# "another machine"): MCP journey, auth/scope/validation negatives, Host/Origin
# checks, and a restart that must keep projects, keys and renders.
#
#   e2e/docker/run.sh                 # build + test
#   IMAGE=reelforge-studio:dev SKIP_BUILD=1 e2e/docker/run.sh
#   CLAUDE=1 e2e/docker/run.sh        # also: headless Claude Code makes a reel over MCP only
#   DB=postgres e2e/docker/run.sh     # database from the compose profile (postgres | mysql); default sqlite
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
NET=rf-e2e-net VOL=rf-e2e-data NAME=rf-e2e-server PORT=${PORT:-4321} PROJECT=rf-e2e
case "$DB" in sqlite|postgres|mysql) ;; *) echo "DB must be sqlite, postgres or mysql"; exit 2 ;; esac
[ "$DB" = sqlite ] || NET=${PROJECT}_default
WORK=$(mktemp -d); chmod 755 "$WORK"
cleanup() {
  docker rm -f $NAME >/dev/null 2>&1 || true
  [ "$DB" = sqlite ] && { docker network rm $NET >/dev/null 2>&1 || true; } || docker compose -p $PROJECT --profile "$DB" down -v >/dev/null 2>&1 || true
  docker volume rm $VOL >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT

[ "${SKIP_BUILD:-}" = 1 ] || docker build ${BUILD_ARGS:-} -t "$IMAGE" .

KEY=rf_$(openssl rand -hex 24)
mkdir -p "$WORK/secret" "$WORK/out" "$WORK/client"
printf %s "$KEY" > "$WORK/secret/key"
DBPASS=$(openssl rand -hex 16)
case "$DB" in
  postgres) printf %s "postgresql://reelforge:$DBPASS@postgres:5432/reelforge" > "$WORK/secret/dburl" ;;
  mysql) printf %s "mysql://reelforge:$DBPASS@mysql:3306/reelforge?allowPublicKeyRetrieval=true" > "$WORK/secret/dburl" ;;
  *) : > "$WORK/secret/dburl" ;;
esac
# The server runs as UID 10001: a *_FILE secret must be readable by it.
for f in key dburl; do chown 10001 "$WORK/secret/$f" 2>/dev/null || chmod 644 "$WORK/secret/$f"; done
chmod 777 "$WORK/out"
cp e2e/docker/*.mjs examples/sample-reel.json "$WORK/client/"
(cd "$WORK/client" && npm init -y >/dev/null && npm i -q --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 >/dev/null)

start() {
  # The database is chosen by DATABASE_URL alone (here its _FILE variant, so the password stays out of `docker inspect`).
  local dbenv=(); [ "$DB" = sqlite ] || dbenv=(-v "$WORK/secret/dburl:/run/secrets/dburl:ro" -e DATABASE_URL_FILE=/run/secrets/dburl)
  docker run -d --name $NAME --network $NET --network-alias reelforge -p 127.0.0.1:$PORT:4321 --shm-size=1g \
    -v $VOL:/data -v "$WORK/secret/key:/run/secrets/key:ro" -e REELFORGE_BOOTSTRAP_KEY_FILE=/run/secrets/key "${dbenv[@]}" \
    -e REELFORGE_ALLOWED_HOSTS=reelforge,reelforge:4321 "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' $NAME)" = healthy ] && return; sleep 2; done
  docker logs $NAME; echo "server did not become healthy"; exit 1
}
client() { docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -w /c \
  -e URL=http://reelforge:4321/mcp -e KEY="$KEY" -e SAMPLE=sample-reel.json "$CLIENT_IMAGE" node "$@"; }

if [ "$DB" = sqlite ]; then
  docker network create $NET >/dev/null
else
  echo "== $DB from the compose profile"
  POSTGRES_PASSWORD=$DBPASS MYSQL_PASSWORD=$DBPASS MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16) \
    docker compose -p $PROJECT --profile "$DB" up -d --wait "$DB"
fi
docker volume create $VOL >/dev/null
echo "== seed a v0.1 data directory"
docker run --rm -v $VOL:/data -v "$WORK/client:/c:ro" -w /c -e KEY="$KEY" -e SAMPLE=sample-reel.json "$CLIENT_IMAGE" \
  sh -c 'node seed-v01.mjs && chown -R 10001:10001 /data'
start
echo "== database and one-time v0.1 import"
docker logs $NAME 2>&1 | grep -E '\[reelforge\] (database|imported|applying)' | sed 's/^/   /'
docker logs $NAME 2>&1 | grep -q "database: ${DB/postgres/postgresql} " && echo "✔ server uses $DB" || { echo "✘ server is not on $DB"; docker logs $NAME; exit 1; }
if [ "$DB" = sqlite ]; then docker exec $NAME test -s /data/reelforge.db && echo "✔ /data/reelforge.db exists"
else docker exec $NAME test ! -e /data/reelforge.db && echo "✔ no SQLite file on the volume"; fi
api() { curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT$1"; }
[ "$(api /v1/projects/legacy-v01/versions)" = '{"versions":[1,2]}' ] && echo "✔ v0.1 project imported with both versions; the imported key works" || { echo "✘ v0.1 import"; api /v1/projects/legacy-v01/versions; exit 1; }
api /v1/projects/legacy-v01 | grep -q '"Made by v0.1, edited"' && echo "✔ current manifest is version 2" || { echo "✘ v0.1 manifest"; exit 1; }
api /v1/themes/legacy-theme | grep -q '"legacy-theme"' && echo "✔ v0.1 theme imported" || { echo "✘ v0.1 theme"; exit 1; }
echo "== MCP journey (separate container)"; client journey.mjs
echo "== ffprobe"; docker run --rm -v "$WORK/out:/o:ro" --entrypoint ffprobe "$IMAGE" -v error -count_frames \
  -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration -of compact /o/docker-e2e.mp4
echo "== auth, scopes, validation"; client neg.mjs
echo "== Host/Origin checks"
mcp() { curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/mcp" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$@" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
[ "$(mcp -H 'Host: evil.example')" = 403 ] && echo "✔ forged Host → 403" || { echo "✘ forged Host not refused"; exit 1; }
[ "$(mcp -H 'Origin: https://evil.example')" = 403 ] && echo "✔ foreign Origin → 403" || { echo "✘ foreign Origin not refused"; exit 1; }
echo "== restart keeps data"
before=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/projects" | md5sum)
docker rm -f $NAME >/dev/null; start
after=$(curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/v1/projects" | md5sum)
[ "$before" = "$after" ] && echo "✔ projects survive a new container on the same volume" || { echo "✘ projects changed after restart"; exit 1; }
docker logs $NAME 2>&1 | grep -q 'imported v0.1' && { echo "✘ v0.1 data imported a second time"; exit 1; } || echo "✔ no second import after the restart"
case "$DB" in
  postgres) n=$(docker compose -p $PROJECT exec -T postgres psql -U reelforge -d reelforge -tAc 'SELECT count(*) FROM "Project"') ;;
  mysql) n=$(docker compose -p $PROJECT exec -T -e MYSQL_PWD=$DBPASS mysql mysql -ureelforge reelforge -N -e 'SELECT count(*) FROM Project') ;;
  *) n=skip ;;
esac
[ "$n" = skip ] || { [ "$n" -ge 2 ] && echo "✔ $n projects are rows in $DB" || { echo "✘ expected projects in $DB, got $n"; exit 1; }; }

if [ "${CLAUDE:-}" = 1 ]; then
  echo "== headless Claude Code, MCP only"
  umask 077; printf '{"mcpServers":{"reelforge":{"type":"http","url":"http://127.0.0.1:%s/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$PORT" "$KEY" > "$WORK/mcp.json"
  claude -p "You are connected to a ReelForge video studio through the 'reelforge' MCP server. Make a 15 to 20 second vertical reel with 3 tips for writing better product hooks. Plan the scenes, engines, templates, per-scene timing and theme yourself, render it, wait for it to finish, and reply with the project id, job id, render id, duration, frame count and download URL. Use only the reelforge tools." \
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --allowedTools mcp__reelforge --max-turns 40 < /dev/null
fi
echo "ALL DOCKER E2E CHECKS PASSED (DB=$DB)"
