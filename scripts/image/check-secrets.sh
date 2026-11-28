#!/usr/bin/env bash
# No secrets in the image (D-042): its build history, its configuration and its files.
#
#   scripts/image/check-secrets.sh reelforge-studio:release
#   EXTRA_CA=/path/to/build-proxy-ca.crt scripts/image/check-secrets.sh IMAGE
#
# 1. `docker history --no-trunc`: no build argument or command that carries a
#    password, token, key or proxy credentials (Docker leaves its predefined
#    proxy args such as HTTPS_PROXY out of the history unless the Dockerfile
#    declares them, and it does not).
# 2. The image config: no environment variable with a secret-looking name that
#    has a value.
# 3. The filesystem: no private keys, API tokens (GitHub, AWS, Anthropic,
#    OpenAI, Slack, ElevenLabs-style), RenderWeld API keys (rf_...), .env or
#    credential files; the build's extra CA (a --secret mount) is not in a layer.
set -euo pipefail
IMAGE=${1:?usage: check-secrets.sh IMAGE}
fail=0
bad() { echo "✘ $1"; [ -n "${2:-}" ] && sed 's/^/     /' <<< "$2" | head -10; fail=1; }
ok() { echo "✔ $1"; }
# Tokens start at a word boundary; a PEM header only counts with key material after it (below).
TOKEN_RE='(^|[^A-Za-z0-9_])((ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}|rf_[A-Za-z0-9_-]{20,})'
PEM_RE='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
SECRET_RE="$TOKEN_RE|$PEM_RE"

echo "== $IMAGE: build history"
history=$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE")
hits=$(grep -Eio '([A-Z_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIALS?)[A-Z_]*=[^ ]+)|((https?|socks5?)://[^/ :@]+:[^/ @]+@[^ ]+)|((HTTPS?|ALL|NO)_PROXY=[^ ]+)' <<< "$history" | grep -Evi '=(\$|"\$|$)|_FILE=' || true)
[ -z "$hits" ] && ok "no secret-looking arguments, proxy settings or credentials in docker history" || bad "secret-looking values in docker history" "$hits"
hits=$(grep -Eo "$SECRET_RE" <<< "$history" || true)
[ -z "$hits" ] && ok "no tokens or keys in docker history" || bad "tokens or keys in docker history" "$hits"
grep -q 'mount=type=secret' <<< "$history" && ok "the build CA came in as a --secret mount (not a layer)" || true

echo "== $IMAGE: image config"
envs=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE")
hits=$(grep -Ei '^[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL|_KEY)[A-Z0-9_]*=.+' <<< "$envs" | grep -Ev '^[A-Z0-9_]*_FILE=' || true)
[ -z "$hits" ] && ok "no secret-named environment variables with values" || bad "secret-named environment variables in the image config" "$hits"
hits=$(grep -Ei '^(HTTPS?|ALL)_PROXY=' <<< "$envs" || true)
[ -z "$hits" ] && ok "no proxy settings baked into the environment" || bad "proxy settings in the image environment" "$hits"

echo "== $IMAGE: filesystem"
# grep runs inside the image (as root, read-only), over every regular file of the
# runtime's own trees; /proc, /sys and /dev are not part of the image.
scan() {
  docker run --rm --network none --user 0 --entrypoint sh "$IMAGE" -c "$1"
}
files=$(scan 'find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -type f \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "id_rsa*" -o -name "id_ed25519*" -o -name ".npmrc" -o -name ".netrc" -o -name ".git-credentials" -o -name "credentials.json" -o -name "secrets.json" \) -print' \
  | grep -Ev '^/(etc/ssl|usr/share/ca-certificates|usr/lib/ssl|etc/ca-certificates)/' || true)
[ -z "$files" ] && ok "no .env, key, certificate or credential files outside the system CA store" || bad "credential-like files in the image" "$files"
ROOTS='/app /root /home /tmp /data /etc /opt /usr/local'
# Prisma inlines its query compilers as base64 (random text that can look like a token).
hits=$(scan "grep -rIEl --exclude='*wasm-base64*' '$TOKEN_RE' $ROOTS 2>/dev/null" || true)
[ -z "$hits" ] && ok "no API tokens or RenderWeld keys (rf_...) in $ROOTS" || bad "API tokens found" "$hits"
# Libraries that parse PEM contain the header as a string; a key file has base64 key material on the next line.
hits=$(scan "grep -rIEl '$PEM_RE' $ROOTS 2>/dev/null | while read -r f; do grep -A1 -E '$PEM_RE' \"\$f\" | grep -Eq '^[A-Za-z0-9+/]{40,}=*\$' && echo \"\$f\"; done" || true)
[ -z "$hits" ] && ok "no private keys in $ROOTS" || bad "private keys found" "$hits"
for d in /root/.ccr /run/secrets /root/.npm /root/.cache /pnpm; do
  scan "test ! -e $d" && ok "no $d" || bad "$d exists in the image"
done
if [ -n "${EXTRA_CA:-}" ] && [ -f "$EXTRA_CA" ]; then
  # The build's CA bundle (a --secret mount) usually repeats public roots that Debian
  # ships too; the certificates that matter are the ones the image's own store lacks
  # (e.g. a proxy's interception CA). None of them may be anywhere in the image.
  tmp=$(mktemp -d)
  docker run --rm --entrypoint cat "$IMAGE" /etc/ssl/certs/ca-certificates.crt > "$tmp/store.pem"
  awk -v d="$tmp" '/-----BEGIN CERTIFICATE-----/{n++; f=d "/c" n ".pem"} n{print > f}' "$EXTRA_CA"
  : > "$tmp/patterns"
  for c in "$tmp"/c*.pem; do
    line=$(grep -v -- '-----' "$c" | sed -n '3p')
    [ -n "$line" ] && ! grep -qF -- "$line" "$tmp/store.pem" && echo "$line" >> "$tmp/patterns"
  done
  n=$(wc -l < "$tmp/patterns")
  found=$(docker run --rm --network none --user 0 -v "$tmp/patterns:/run/rfscan/patterns:ro" --entrypoint sh "$IMAGE" \
    -c "grep -rIlF -f /run/rfscan/patterns / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=run 2>/dev/null | head -5" || true)
  rm -rf "$tmp"
  [ -z "$found" ] && ok "none of the $n build-only CA certificates from $EXTRA_CA is in the image" || bad "a build-only CA certificate is in the image" "$found"
fi
[ "$fail" = 0 ] && echo "NO SECRETS FOUND ($IMAGE)" || { echo "SECRETS CHECK FAILED ($IMAGE)"; exit 1; }
