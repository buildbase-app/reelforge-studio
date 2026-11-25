#!/usr/bin/env bash
# Set up and run the studio and the store site side by side (docs/DEVELOPMENT.md#both-repos).
#
#   scripts/dev/both.sh [PARENT_DIR] [options]
#
# PARENT_DIR (default: the folder that holds this studio checkout) gets two checkouts:
#   PARENT_DIR/reelforge-studio                  buildbase-app/reelforge-studio
#   PARENT_DIR/reelforge-selling-public-site     buildbase-app/reelforge-selling-public-site
# Missing ones are cloned; existing ones are fast-forwarded when clean (never reset or stashed).
# Then each repo's setup runs, and `pnpm dev:all` (studio) and the site's dev server run together
# with [studio] / [site] prefixes. Ctrl-C stops both. The site's own scripts (`npm run setup`,
# `npm run dev:all`) are used when it has them, else `npm install` and `npm run dev`.
#
# Options:
#   --studio-port N   studio port (default 4321)
#   --site-port N     site port (default 3000; sign-in through BuildBase works on 3000 only)
#   --no-update       do not fetch or pull              --skip-setup    do not run the setups
#   --setup-only      set up, do not start              -h, --help
# Environment: STUDIO_REPO_URL, SITE_REPO_URL, STUDIO_BRANCH, SITE_BRANCH (clone sources),
#   STUDIO_SETUP_ARGS (extra `pnpm dev:setup` flags, e.g. "--postgres").
#
# The site gets STUDIO_REPO_DIR (the studio checkout; its MCP tool list reads
# docs/public/mcp/tools.md there) and STUDIO_URL (the running studio).
#
# Windows: run it in WSL2 (recommended) or Git Bash; native PowerShell has no equivalent yet:
# run `pnpm dev:setup; pnpm dev:all` in the studio and `npm run setup; npm run dev:all` in the
# site, in two terminals.
set -euo pipefail

STUDIO_PORT=4321 SITE_PORT=3000 UPDATE=1 SETUP=1 START=1 PARENT=
while [ $# -gt 0 ]; do
  case "$1" in
    --studio-port) STUDIO_PORT=$2; shift 2 ;;
    --site-port) SITE_PORT=$2; shift 2 ;;
    --no-update) UPDATE=0; shift ;;
    --skip-setup) SETUP=0; shift ;;
    --setup-only) START=0; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
    *) PARENT=$1; shift ;;
  esac
done

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PARENT=${PARENT:-$(dirname "$HERE")}
mkdir -p "$PARENT"
PARENT=$(cd "$PARENT" && pwd)
STUDIO="$PARENT/reelforge-studio"
SITE="$PARENT/reelforge-selling-public-site"
STUDIO_REPO_URL=${STUDIO_REPO_URL:-https://github.com/buildbase-app/reelforge-studio.git}
SITE_REPO_URL=${SITE_REPO_URL:-https://github.com/buildbase-app/reelforge-selling-public-site.git}

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "$1 is required: $2" >&2; exit 1; }; }
need git "install Git"
need node "install Node 22 (nvm install 22)"
need npm "it ships with Node"
command -v pnpm >/dev/null || { echo "pnpm not found: run \`corepack enable\`" >&2; exit 1; }

# Clone, or fast-forward a clean checkout. Never discards local work.
sync_repo() { # dir url branch
  local dir=$1 url=$2 branch=$3
  if [ ! -d "$dir/.git" ] && [ ! -f "$dir/.git" ]; then
    say "clone $url -> $dir"
    git clone ${branch:+--branch "$branch"} "$url" "$dir"
  elif [ "$UPDATE" = 1 ]; then
    say "update $dir"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      echo "local changes: not updating (commit or stash them to update)"
    elif ! git -C "$dir" symbolic-ref -q HEAD >/dev/null; then
      echo "detached HEAD: not updating"
    else
      git -C "$dir" pull --ff-only || echo "could not fast-forward: left as it is"
    fi
  fi
}
sync_repo "$STUDIO" "$STUDIO_REPO_URL" "${STUDIO_BRANCH:-}"
sync_repo "$SITE" "$SITE_REPO_URL" "${SITE_BRANCH:-}"

# A script name in a package.json, without jq.
has_script() { node -e 'process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)' "$1/package.json" "$2"; }

port_free() { node -e 'const s=require("net").createServer().once("error",()=>process.exit(1)).listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$1"; }
for p in "$STUDIO_PORT:studio:--studio-port" "$SITE_PORT:site:--site-port"; do
  IFS=: read -r port what flag <<<"$p"
  if ! port_free "$port"; then
    alt=$port; while ! port_free "$alt"; do alt=$((alt + 1)); done
    echo "port $port ($what) is in use: stop what uses it (lsof -i :$port), or pass $flag $alt" >&2
    exit 1
  fi
done

export STUDIO_REPO_DIR=$STUDIO STUDIO_URL="http://127.0.0.1:$STUDIO_PORT"

if [ "$SETUP" = 1 ]; then
  say "studio setup"
  if has_script "$STUDIO" dev:setup; then
    # shellcheck disable=SC2086
    (cd "$STUDIO" && pnpm dev:setup --port "$STUDIO_PORT" ${STUDIO_SETUP_ARGS:-})
  else
    echo "this studio checkout has no dev:setup yet: pnpm install only"
    (cd "$STUDIO" && pnpm install --frozen-lockfile)
  fi
  say "site setup"
  if has_script "$SITE" setup; then
    (cd "$SITE" && npm run setup)
  else
    echo "the site has no setup script yet: npm install"
    (cd "$SITE" && npm install)
  fi
fi

[ "$START" = 1 ] || { say "set up; start with: scripts/dev/both.sh $PARENT --no-update --skip-setup"; exit 0; }

STUDIO_CMD="pnpm dev:all --port $STUDIO_PORT"
has_script "$STUDIO" dev:all || STUDIO_CMD="pnpm dev"
# The site's dev:all (npm run setup / npm run dev:all) runs on 3000, the redirect URL registered for
# BuildBase sign-in; another port runs plain `next dev` (pages work, sign-in does not).
if [ "$SITE_PORT" = 3000 ] && has_script "$SITE" dev:all; then SITE_CMD="npm run dev:all"
else SITE_CMD="npm run dev -- --port $SITE_PORT"; [ "$SITE_PORT" = 3000 ] || echo "note: BuildBase sign-in on the site needs port 3000"; fi

say "starting: studio ($STUDIO_CMD) on $STUDIO_PORT, site ($SITE_CMD) on $SITE_PORT"
# Each side in its own process group (set -m), so one signal stops all of its processes.
set -m
pids=()
(cd "$STUDIO" && RENDERWELD_PORT=$STUDIO_PORT exec $STUDIO_CMD) 2>&1 | awk '{ print "[studio] " $0; fflush() }' &
pids+=("$(jobs -p %%)")
(cd "$SITE" && PORT=$SITE_PORT exec $SITE_CMD) 2>&1 | awk '{ print "[site]   " $0; fflush() }' &
pids+=("$(jobs -p %%)")

stopped=0
stop_all() {
  [ "$stopped" = 1 ] && return; stopped=1
  echo; echo "== stopping"
  for pg in "${pids[@]}"; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  for _ in $(seq 1 100); do
    alive=0; for pg in "${pids[@]}"; do kill -0 -- "-$pg" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && break; sleep 0.1
  done
  for pg in "${pids[@]}"; do kill -KILL -- "-$pg" 2>/dev/null || true; done
}
trap 'stop_all; exit 0' INT TERM
trap stop_all EXIT
echo "studio: $STUDIO_URL (MCP $STUDIO_URL/mcp, dashboard $STUDIO_URL/dashboard/)   site: http://localhost:$SITE_PORT   Ctrl-C stops both"
# Stop both when either side exits.
while :; do
  for pg in "${pids[@]}"; do kill -0 -- "-$pg" 2>/dev/null || { echo "a dev server exited"; exit 1; }; done
  sleep 1
done
