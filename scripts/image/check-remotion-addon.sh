#!/usr/bin/env bash
# Checks the Remotion add-on image (deployment/remotion/Dockerfile) built on a release image,
# without rendering: nothing runs that would report a Remotion usage event, and the probe has
# no network at all (#783).
#
#   docker buildx build --builder default -f deployment/remotion/Dockerfile \
#     --build-arg RENDERWELD_IMAGE=reelforge-studio:release -t reelforge-studio:remotion deployment/remotion
#   scripts/image/check-remotion-addon.sh reelforge-studio:remotion
#
# Fails when Remotion is missing from /opt/remotion or at another version than the engine
# expects, when the pre-built bundle is missing or does not match the image's compositions
# (the engine would run Webpack at render time), or when the image no longer runs as 10001.
set -euo pipefail
IMAGE=${1:?usage: check-remotion-addon.sh IMAGE}
fail=0
bad() { echo "✘ $1"; [ -n "${2:-}" ] && sed 's/^/     /' <<< "$2" | tail -15; fail=1; }
ok() { echo "✔ $1"; }
HARD=(--rm --network none --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges)

echo "== $IMAGE"
want=$(sed -n "s/^export const REMOTION_VERSION = '\([^']*\)';$/\1/p" packages/engine-remotion/src/load.ts)
[ -n "$want" ] || { echo "REMOTION_VERSION not found in packages/engine-remotion/src/load.ts"; exit 2; }
user=$(docker image inspect -f '{{.Config.User}}' "$IMAGE")
[ "$user" = 10001:10001 ] && ok "runs as UID:GID 10001:10001" || bad "image user is \"$user\", expected 10001:10001"

versions=$(docker run "${HARD[@]}" --entrypoint node "$IMAGE" -e \
  'for (const p of ["remotion", "@remotion/renderer", "@remotion/bundler"]) console.log(p + "=" + require("/opt/remotion/node_modules/" + p + "/package.json").version)' 2>&1) || true
for p in remotion @remotion/renderer @remotion/bundler; do
  grep -qx "$p=$want" <<< "$versions" && ok "$p $want in /opt/remotion" || bad "$p is not $want in /opt/remotion" "$versions"
done

# The engine's own lookup: with the image's Remotion, bundleCompositions must return the pre-built
# bundle (a matching source hash) instead of building one; the root filesystem is read-only here.
probe=$(docker run "${HARD[@]}" --entrypoint /app/apps/server/node_modules/.bin/tsx "$IMAGE" -e \
  "import('/app/packages/engine-remotion/src/index.ts').then(async (m) => {
     const dir = await m.bundleCompositions('/tmp/rw-cache');
     console.log(dir === m.PREBUILT_REMOTION_DIR ? 'prebuilt ' + dir : 'rebuilt ' + dir);
     console.log('version ' + m.remotionVersion());
   }).catch((e) => { console.error(e); process.exit(1); })" 2>&1) || true
grep -q '^prebuilt ' <<< "$probe" && ok "the engine uses the pre-built Remotion bundle ($(grep '^prebuilt ' <<< "$probe" | cut -d' ' -f2))" \
  || bad "the engine does not use the pre-built Remotion bundle" "$probe"
grep -qx "version $want" <<< "$probe" && ok "the engine finds Remotion $want at RENDERWELD_REMOTION_HOME" || bad "the engine reports another Remotion version" "$probe"

[ "$fail" = 0 ] && echo "REMOTION ADD-ON OK ($IMAGE)" || { echo "REMOTION ADD-ON CHECK FAILED ($IMAGE)"; exit 1; }
