#!/usr/bin/env bash
# Schema check of deployment/kubernetes/ (issue #153): kubeconform -strict on the
# raw files and on the kustomize output of the base and of every KEDA overlay.
# KEDA's resources are checked against JSON schemas generated from the CRDs in
# KEDA's pinned release manifest (strict: unknown fields fail).
#
#   e2e/k8s/kubeconform.sh                 # tools are downloaded into $TOOLS (pinned)
#   K8S_SCHEMA_VERSION=1.31.0 KEDA_VERSION=2.21.1 KUBECONFORM_VERSION=0.7.0 KUBECTL_VERSION=1.37.0
set -euo pipefail
cd "$(dirname "$0")/../.."
KUBECONFORM_VERSION=${KUBECONFORM_VERSION:-0.7.0}
KUBECTL_VERSION=${KUBECTL_VERSION:-1.37.0}
KEDA_VERSION=${KEDA_VERSION:-2.21.1}
K8S_SCHEMA_VERSION=${K8S_SCHEMA_VERSION:-1.31.0}
TOOLS=${TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/reelforge-e2e-k8s}
mkdir -p "$TOOLS"
fetch() { [ -s "$TOOLS/$1" ] || { curl -sSfL -o "$TOOLS/$1.part" "$2" && mv "$TOOLS/$1.part" "$TOOLS/$1"; }; }
fetch "kubeconform-$KUBECONFORM_VERSION.tgz" "https://github.com/yannh/kubeconform/releases/download/v$KUBECONFORM_VERSION/kubeconform-linux-amd64.tar.gz"
[ -x "$TOOLS/kubeconform-$KUBECONFORM_VERSION" ] || { tar -xzf "$TOOLS/kubeconform-$KUBECONFORM_VERSION.tgz" -C "$TOOLS" kubeconform && mv "$TOOLS/kubeconform" "$TOOLS/kubeconform-$KUBECONFORM_VERSION"; }
fetch "kubectl-$KUBECTL_VERSION" "https://dl.k8s.io/release/v$KUBECTL_VERSION/bin/linux/amd64/kubectl"; chmod +x "$TOOLS/kubectl-$KUBECTL_VERSION"
fetch "keda-$KEDA_VERSION.yaml" "https://github.com/kedacore/keda/releases/download/v$KEDA_VERSION/keda-$KEDA_VERSION.yaml"
KC="$TOOLS/kubeconform-$KUBECONFORM_VERSION" KUBECTL="$TOOLS/kubectl-$KUBECTL_VERSION"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# CRD -> {kind}_{version}.json (kubeconform's naming), closed objects for -strict.
python3 - "$TOOLS/keda-$KEDA_VERSION.yaml" "$WORK/schemas" <<'PY'
import json, os, sys
import yaml  # PyYAML
os.makedirs(sys.argv[2], exist_ok=True)
def close(s):
    if isinstance(s, dict):
        if s.get("type") == "object" and "properties" in s and "additionalProperties" not in s and not s.get("x-kubernetes-preserve-unknown-fields"):
            s["additionalProperties"] = False
        for v in s.values(): close(v)
    elif isinstance(s, list):
        for v in s: close(v)
n = 0
for doc in yaml.safe_load_all(open(sys.argv[1])):
    if not doc or doc.get("kind") != "CustomResourceDefinition": continue
    kind = doc["spec"]["names"]["kind"].lower()
    for v in doc["spec"]["versions"]:
        schema = v["schema"]["openAPIV3Schema"]; close(schema)
        json.dump(schema, open(os.path.join(sys.argv[2], f"{kind}_{v['name']}.json"), "w")); n += 1
print(f"   {n} KEDA CRD schemas")
PY
LOC=(-schema-location default -schema-location "$WORK/schemas/{{ .ResourceKind }}_{{ .ResourceAPIVersion }}.json")
echo "== kubeconform $KUBECONFORM_VERSION -strict (Kubernetes $K8S_SCHEMA_VERSION schemas, KEDA $KEDA_VERSION CRDs)"
# Raw files (kustomization.yaml files are not Kubernetes objects; patches inside them are checked in the output).
find deployment/kubernetes -name '*.yaml' ! -name kustomization.yaml -print0 | xargs -0 "$KC" -strict -summary -kubernetes-version "$K8S_SCHEMA_VERSION" "${LOC[@]}"
for d in "" keda keda/mysql keda/scaledjob; do
  "$KUBECTL" kustomize "deployment/kubernetes/$d" > "$WORK/out.yaml"
  printf '   kustomize deployment/kubernetes/%-15s ' "$d:"
  "$KC" -strict -summary -kubernetes-version "$K8S_SCHEMA_VERSION" "${LOC[@]}" "$WORK/out.yaml"
done
echo "KUBECONFORM CHECKS PASSED"
