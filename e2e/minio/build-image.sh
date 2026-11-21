#!/usr/bin/env bash
# Builds a MinIO server image for the storage e2e (issue #27) from MinIO's official
# source (github.com/minio/minio, AGPL-3.0; a test fixture only, never shipped).
# Used when no MinIO image can be pulled: MinIO stopped publishing images on
# Docker Hub / quay.io in late 2025, and mirror.gcr.io has none.
#
#   e2e/minio/build-image.sh [image-tag]     default reelforge-e2e/minio:source
#   MINIO_VERSION=<go module version>        default the last upstream commit (2026-02-12)
#
# Needs Go (>= 1.24) on the host, or Docker to build it in the golang image.
set -euo pipefail
TAG=${1:-reelforge-e2e/minio:source}
VERSION=${MINIO_VERSION:-v0.0.0-20260212201848-7aac2a2c5b7c}
BASE=${MINIO_BASE_IMAGE:-mirror.gcr.io/library/debian:bookworm-slim}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if command -v go >/dev/null; then
  GOBIN="$WORK" CGO_ENABLED=0 GOFLAGS=-trimpath go install "github.com/minio/minio@$VERSION"
else
  docker run --rm --network host -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY -e CGO_ENABLED=0 -e GOBIN=/out -v "$WORK:/out" \
    mirror.gcr.io/library/golang:1.24-bookworm go install "github.com/minio/minio@$VERSION"
fi
printf 'FROM %s\nCOPY minio /usr/local/bin/minio\nENTRYPOINT ["/usr/local/bin/minio"]\nCMD ["server", "/data"]\n' "$BASE" > "$WORK/Dockerfile"
docker build -q -t "$TAG" "$WORK" >/dev/null
echo "$TAG"
