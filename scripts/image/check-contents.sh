#!/usr/bin/env bash
# Checks what is in a built image, from the list of every file in it
# (docker export | tar -t), and its size against the budget (D-042).
#
#   scripts/image/check-contents.sh reelforge-studio:release
#   SIZE_BUDGET_MB=2300 scripts/image/check-contents.sh IMAGE
#
# Fails when the runtime image carries the repository's tests, docs, e2e or
# tooling, source maps, build-only dependencies (bundlers, test runner) or
# package managers; or misses the licence files, the pre-built engine bundles,
# the built dashboard, tini, Chrome or the release build's build-info.json. Prints the size.
set -euo pipefail
IMAGE=${1:?usage: check-contents.sh IMAGE}
# Uncompressed size of the image (what `docker image inspect` reports), in MB.
SIZE_BUDGET_MB=${SIZE_BUDGET_MB:-2000}
LIST=$(mktemp)
cid=$(docker create "$IMAGE")
trap 'docker rm -f "$cid" >/dev/null 2>&1; rm -f "$LIST"' EXIT
docker export "$cid" | tar -t > "$LIST"
fail=0
bad() { echo "✘ $1"; sed 's/^/     /' <<< "$2" | head -10; fail=1; }
ok() { echo "✔ $1"; }
check_absent() { # description, extended regex
  local hits; hits=$(grep -E "$2" "$LIST" || true)
  if [ -n "$hits" ]; then bad "$1 ($(wc -l <<< "$hits") files)" "$hits"; else ok "$1"; fi
}
check_present() { # description, extended regex
  if grep -Eq "$2" "$LIST"; then ok "$1"; else bad "$1" "(missing: $2)"; fi
}

echo "== $IMAGE: $(wc -l < "$LIST") files"
check_absent "no repository docs, research, e2e, examples, scripts or CI config" \
  '^app/(docs|research|e2e|examples|scripts|deployment|\.github|out|data)/|^app/(AGENTS|CLAUDE|README|LICENSING|COMMERCIAL-LICENSE|TRADEMARK|CONTRIBUTING)\.md$'
check_absent "no test directories or test files of ours" '^app/(apps|packages)/[^/]+/test/|^app/(apps|packages)/.*\.test\.tsx?$'
check_absent "no Prisma tooling (schemas, scripts, config)" '^app/packages/db/(prisma|scripts)/|^app/packages/db/prisma\.config\.ts$'
check_absent "no source maps anywhere" '\.map$'
check_absent "no type declarations in node_modules" '^app/node_modules/.*\.d\.[cm]?ts$'
check_absent "no build-only dependencies (bundlers, test runner, Remotion Studio)" \
  '^app/node_modules/\.pnpm/(@remotion\+bundler|@remotion\+studio|webpack|@rspack|vite|vitest|@motion-canvas\+vite-plugin|@motion-canvas\+ui|@motion-canvas\+2d|mathjax-full|rollup)@'
check_absent "no musl builds of native packages" '^app/node_modules/\.pnpm/[^/]*musl[^/]*/'
check_absent "no package managers (npm, npx, corepack, yarn, pnpm)" '^usr/local/(bin/(npm|npx|corepack|yarn|yarnpkg|pnpm)|lib/node_modules/(npm|corepack)/)|^pnpm/'
check_absent "no .git, .env or npm credentials files" '(^|/)\.git/|(^|/)\.env(\.|$)|(^|/)\.npmrc$'
check_present "LICENSE.md in the image" '^app/LICENSE\.md$'
check_present "NOTICE in the image" '^app/NOTICE$'
check_present "LICENSES/THIRD_PARTY.md in the image" '^app/LICENSES/THIRD_PARTY\.md$'
check_present "pre-built Remotion bundle" '^app/packages/engine-remotion/\.prebuilt/remotion/\.source-hash$'
check_present "pre-built Motion Canvas bundle" '^app/packages/engine-motion-canvas/\.prebuilt/motion-canvas/\.source-hash$'
check_present "built dashboard (D-115)" '^app/apps/dashboard/dist/index\.html$'
check_absent "no dashboard sources or build script (only dist/)" '^app/apps/dashboard/(src|scripts)/|^app/apps/dashboard/build\.ts$'
check_present "Chrome Headless Shell" '^opt/chrome-headless-shell/chrome-headless-shell$'
check_present "tini" '^usr/bin/tini$'
check_present "ffmpeg and ffprobe" '^usr/bin/ffprobe$'

edition=$(docker image inspect -f '{{ index .Config.Labels "app.reelforge.edition" }}' "$IMAGE")
if [ "$edition" = release ]; then
  check_present "release build: build-info.json fixes the licence settings" '^app/packages/core/build-info\.json$'
  info=$(docker run --rm --entrypoint cat "$IMAGE" /app/packages/core/build-info.json)
  grep -q '"licence.mode": "required"' <<< "$info" && ok "release build: licence.mode fixed to required" || bad "release build: licence.mode not fixed to required" "$info"
  sed 's/^/     /' <<< "$info" | grep -E 'serverUrl|orgId|version'
else
  check_absent "dev build: no build-info.json" '^app/packages/core/build-info\.json$'
fi

user=$(docker image inspect -f '{{.Config.User}}' "$IMAGE")
[ "$user" = 10001:10001 ] && ok "runs as UID:GID 10001:10001" || bad "image user is \"$user\", expected 10001:10001" ""
docker image inspect -f '{{json .Config.Entrypoint}}' "$IMAGE" | grep -q tini && ok "tini is the entrypoint" || bad "tini is not the entrypoint" ""
docker image inspect -f '{{json .Config.Healthcheck}}' "$IMAGE" | grep -q healthz && ok "healthcheck on /healthz" || bad "no healthcheck" ""

bytes=$(docker image inspect -f '{{.Size}}' "$IMAGE")
mb=$((bytes / 1024 / 1024))
echo "   size: ${mb} MB uncompressed (budget ${SIZE_BUDGET_MB} MB)"
[ "$mb" -le "$SIZE_BUDGET_MB" ] && ok "within the size budget" || bad "image is ${mb} MB, over the ${SIZE_BUDGET_MB} MB budget (D-042)" ""
[ "$fail" = 0 ] && echo "IMAGE CONTENTS OK ($IMAGE)" || { echo "IMAGE CONTENTS CHECK FAILED ($IMAGE)"; exit 1; }
