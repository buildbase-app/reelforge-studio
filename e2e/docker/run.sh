#!/usr/bin/env bash
# Docker end-to-end acceptance (issue #16): builds the image, runs the server,
# then drives it from a SEPARATE container on a Docker network (an agent on
# "another machine"): MCP journey, auth/scope/validation negatives, Host/Origin
# checks, and a restart that must keep projects, keys and renders.
#
#   e2e/docker/run.sh                 # build + test
#   IMAGE=reelforge-studio:dev SKIP_BUILD=1 e2e/docker/run.sh
#   CLAUDE=1 e2e/docker/run.sh        # also: headless Claude Code makes a reel over MCP only
#
# Extra docker build args (proxy, CA secret, BASE_IMAGE mirror) go in BUILD_ARGS.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=${IMAGE:-reelforge-studio:e2e}
CLIENT_IMAGE=${CLIENT_IMAGE:-node:22-bookworm-slim}
NET=rf-e2e-net VOL=rf-e2e-data NAME=rf-e2e-server PORT=${PORT:-4321}
WORK=$(mktemp -d); chmod 755 "$WORK"
trap 'docker rm -f $NAME >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; docker volume rm $VOL >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

[ "${SKIP_BUILD:-}" = 1 ] || docker build ${BUILD_ARGS:-} -t "$IMAGE" .

KEY=rf_$(openssl rand -hex 24)
mkdir -p "$WORK/secret" "$WORK/out" "$WORK/client"
printf %s "$KEY" > "$WORK/secret/key"
# The server runs as UID 10001: a *_FILE secret must be readable by it.
chown 10001 "$WORK/secret/key" 2>/dev/null || chmod 644 "$WORK/secret/key"
chmod 777 "$WORK/out"
cp e2e/docker/*.mjs examples/sample-reel.json "$WORK/client/"
(cd "$WORK/client" && npm init -y >/dev/null && npm i -q --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 >/dev/null)

start() {
  docker run -d --name $NAME --network $NET --network-alias reelforge -p 127.0.0.1:$PORT:4321 --shm-size=1g \
    -v $VOL:/data -v "$WORK/secret/key:/run/secrets/key:ro" -e REELFORGE_BOOTSTRAP_KEY_FILE=/run/secrets/key \
    -e REELFORGE_ALLOWED_HOSTS=reelforge,reelforge:4321 "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' $NAME)" = healthy ] && return; sleep 2; done
  docker logs $NAME; echo "server did not become healthy"; exit 1
}
client() { docker run --rm --network $NET -v "$WORK/client:/c:ro" -v "$WORK/out:/out" -w /c \
  -e URL=http://reelforge:4321/mcp -e KEY="$KEY" -e SAMPLE=sample-reel.json "$CLIENT_IMAGE" node "$@"; }

docker network create $NET >/dev/null; docker volume create $VOL >/dev/null
start
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

if [ "${CLAUDE:-}" = 1 ]; then
  echo "== headless Claude Code, MCP only"
  umask 077; printf '{"mcpServers":{"reelforge":{"type":"http","url":"http://127.0.0.1:%s/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$PORT" "$KEY" > "$WORK/mcp.json"
  claude -p "You are connected to a ReelForge video studio through the 'reelforge' MCP server. Make a 15 to 20 second vertical reel with 3 tips for writing better product hooks. Plan the scenes, engines, templates, per-scene timing and theme yourself, render it, wait for it to finish, and reply with the project id, job id, render id, duration, frame count and download URL. Use only the reelforge tools." \
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --allowedTools mcp__reelforge --max-turns 40 < /dev/null
fi
echo "ALL DOCKER E2E CHECKS PASSED"
