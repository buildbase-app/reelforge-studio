#!/usr/bin/env bash
# KEDA autoscaling e2e on kind (issue #153): the release image on a one-node
# kind cluster with KEDA (pinned release manifest), PostgreSQL 17, MinIO and
# the mock licence server, deployed with deployment/kubernetes/keda/ (through
# the test overlays in e2e/k8s/scaledobject/ and e2e/k8s/scaledjob/).
# Renders are enqueued over REST through the api only. Checks (ids in
# docs/providers/queue-and-scaling.md):
#   KED-01  nothing queued: KEDA keeps (or takes) the worker Deployment at 0 pods
#   KED-02  JOBS renders (fast template) wake the pool: 0 -> N workers (N > 1, <= maxReplicaCount 4)
#   KED-03  every job succeeded exactly once: attempts 1, one `running` status event each (PostgreSQL)
#   KED-04  the pool goes back to 0 pods after cooldownPeriod
#   KED-05  a worker pod deleted mid-render (grace 0, --force): its job is re-queued and finished by another pod
#   KED-06  ScaledJob variant: one Kubernetes Job per queued render running `worker --once`, > 1 at once,
#           each render once, every Job completes and no worker pod is left
# Timings (time to first claim from zero, scale-up time, back to zero) are printed
# and written to $OUT/timings.json.
#
#   e2e/k8s/keda.sh                                  # build the release image (mock licence baked in) and run
#   SKIP_BUILD=1 e2e/k8s/keda.sh                     # use the existing reelforge-studio:keda-e2e
#   KEEP=1 e2e/k8s/keda.sh                           # keep the cluster afterwards (kind delete cluster --name rf-keda)
#   KEDA_IMAGES=load e2e/k8s/keda.sh                 # kind-load KEDA's images from the local Docker instead of pulling them
#   KEDA_IMAGES=none e2e/k8s/keda.sh                 # no KEDA operator (its images cannot be fetched): KEDA's CRDs only, so the
#                                                    # API server still validates the KEDA objects; the script scales by hand
#                                                    # and the scaling checks and timings (KED-01/02/04, KEDA's part of 06) are NOT run
#   JOBS=20 JOBS_SCALEDJOB=8 e2e/k8s/keda.sh
# BUILD_ARGS (proxy CA secret, --network host), BASE_IMAGE, POSTGRES_IMAGE, MINIO_IMAGE as in e2e/docker/.
# Needs Docker, curl, python3 and node (22) on the host; kind and kubectl are downloaded (pinned) into $TOOLS.
#
# Licence: TEST ONLY. Like e2e/docker/, the release edition is built with the mock
# licence server's URL baked in (http://licence:8080, a Service in the cluster);
# the published image differs by that one layer. Licence keys are random strings
# seeded into the mock, never real keys.
set -euo pipefail
cd "$(dirname "$0")/../.."
KIND_VERSION=${KIND_VERSION:-v0.33.0}
KIND_NODE_IMAGE=${KIND_NODE_IMAGE:-kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5}
KUBECTL_VERSION=${KUBECTL_VERSION:-1.37.0}
KEDA_VERSION=${KEDA_VERSION:-2.21.1}
KEDA_IMAGES=${KEDA_IMAGES:-pull}
IMAGE=reelforge-studio:keda-e2e   # the name in e2e/k8s/settings/kustomization.yaml
POSTGRES_IMAGE=${POSTGRES_IMAGE:-mirror.gcr.io/library/postgres:17}
MINIO_IMAGE=${MINIO_IMAGE:-mirror.gcr.io/minio/minio}
CLUSTER=${CLUSTER:-rf-keda}
JOBS=${JOBS:-20} JOBS_SCALEDJOB=${JOBS_SCALEDJOB:-8} MAX=4 PORT=4340
TOOLS=${TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/reelforge-e2e-k8s}
OUT=${OUT:-$(mktemp -d)}
WORK=$(mktemp -d); chmod 755 "$WORK"
mkdir -p "$TOOLS" "$OUT"
MON_PID=
cleanup() {
  [ -n "$MON_PID" ] && kill "$MON_PID" 2>/dev/null || true
  if [ "${KEEP:-}" = 1 ]; then echo "cluster kept: $KIND delete cluster --name $CLUSTER"; else "$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
fail() { echo "✘ $*"; exit 1; }
now() { date +%s%3N; }

fetch() { [ -s "$TOOLS/$1" ] || { curl -sSfL -o "$TOOLS/$1.part" "$2" && mv "$TOOLS/$1.part" "$TOOLS/$1"; }; }
fetch "kind-$KIND_VERSION" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-linux-amd64"
fetch "kubectl-$KUBECTL_VERSION" "https://dl.k8s.io/release/v$KUBECTL_VERSION/bin/linux/amd64/kubectl"
fetch "keda-$KEDA_VERSION.yaml" "https://github.com/kedacore/keda/releases/download/v$KEDA_VERSION/keda-$KEDA_VERSION.yaml"
chmod +x "$TOOLS/kind-$KIND_VERSION" "$TOOLS/kubectl-$KUBECTL_VERSION"
KIND="$TOOLS/kind-$KIND_VERSION"
k() { "$TOOLS/kubectl-$KUBECTL_VERSION" --context "kind-$CLUSTER" "$@"; }
trap cleanup EXIT

[ "${SKIP_BUILD:-}" = 1 ] || docker build ${BUILD_ARGS:-} ${BASE_IMAGE:+--build-arg BASE_IMAGE=$BASE_IMAGE} --build-arg RENDERWELD_EDITION=release \
  --build-arg LICENCE_SERVER_URL=http://licence:8080 --build-arg LICENCE_ORG_ID=6b01478bb42d2c444e99fcd8-mocklice -t "$IMAGE" .
echo "== image $IMAGE (edition $(docker image inspect -f '{{ index .Config.Labels "app.renderweld.edition" }}' "$IMAGE"), licence server: the in-cluster mock, test only)"
if ! docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 && ! docker pull -q "$MINIO_IMAGE" >/dev/null 2>&1; then
  MINIO_IMAGE=reelforge-e2e/minio:source   # MinIO publishes no images any more (e2e/minio/build-image.sh)
  docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1 || MINIO_IMAGE=$(e2e/minio/build-image.sh)
fi
for i in "$POSTGRES_IMAGE"; do docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null; done

echo "== kind $KIND_VERSION cluster $CLUSTER (one node, $KIND_NODE_IMAGE)"
cat > "$WORK/kind.yaml" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings: [{ containerPort: 30480, hostPort: $PORT, listenAddress: 127.0.0.1 }]
    # Chromium's sandbox: the seccomp profile the worker pods name (deployment/kubernetes/base/worker.yaml).
    extraMounts: [{ hostPath: $PWD/deployment/seccomp/chrome.json, containerPath: /var/lib/kubelet/seccomp/reelforge-chrome.json, readOnly: true }]
EOF
# A cgroup v1 host (some CI sandboxes): the kubelet refuses cgroup v1 by default since Kubernetes 1.35.
[ "$(docker info -f '{{.CgroupVersion}}')" = 1 ] && printf '%s\n' 'kubeadmConfigPatches:' '  - |' '    kind: KubeletConfiguration' '    failCgroupV1: false' >> "$WORK/kind.yaml"
# A sandbox that may not lower oom_score_adj (no CAP_SYS_RESOURCE): runc in the node fails "failed to update
# /proc/self/oom_score_adj"; containerd's restrict_oom_score_adj (what rootless kind uses) avoids it.
sh -c 'echo -1 > /proc/self/oom_score_adj' 2>/dev/null || printf '%s\n' 'containerdConfigPatches:' '  - |-' \
  '    [plugins."io.containerd.grpc.v1.cri"]' '      restrict_oom_score_adj = true' >> "$WORK/kind.yaml"
"$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
"$KIND" create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" --config "$WORK/kind.yaml" --wait 180s
LOAD=("$IMAGE" "$POSTGRES_IMAGE" "$MINIO_IMAGE")
[ "$KEDA_IMAGES" = load ] && LOAD+=($(grep -Eo 'ghcr.io/kedacore/[a-z-]+:[0-9.]+' "$TOOLS/keda-$KEDA_VERSION.yaml" | sort -u))
# Like `kind load docker-image`, but one platform only: pulled multi-arch images hold just the local platform's
# layers, which `ctr import --all-platforms` (what kind runs) rejects.
for i in "${LOAD[@]}"; do
  docker save --platform "linux/$(docker version -f '{{.Server.Arch}}')" "$i" \
    | docker exec -i "$CLUSTER-control-plane" ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null 2>&1
done
echo "✔ cluster up ($(k version -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["serverVersion"]["gitVersion"])')); loaded ${#LOAD[@]} images"

MANUAL=; [ "$KEDA_IMAGES" = none ] && MANUAL=1
if [ -n "$MANUAL" ]; then
  echo "== KEDA $KEDA_VERSION CRDs only (KEDA_IMAGES=none): NO OPERATOR, workers are scaled by hand, scaling is not tested"
  python3 -c 'import sys, yaml; print("---\n".join(yaml.safe_dump(d) for d in yaml.safe_load_all(open(sys.argv[1])) if d and d["kind"] == "CustomResourceDefinition"))' \
    "$TOOLS/keda-$KEDA_VERSION.yaml" | k apply --server-side -f - >/dev/null
  k wait --for=condition=Established crd --all --timeout=60s >/dev/null
  echo "✔ KEDA CRDs established ($(k get crd -o name | grep -c keda.sh))"
else
  echo "== KEDA $KEDA_VERSION (release manifest, server-side apply)"
  k apply --server-side -f "$TOOLS/keda-$KEDA_VERSION.yaml" >/dev/null
  k -n keda wait --for=condition=Available deployment --all --timeout=300s >/dev/null || { k -n keda get pods; fail "KEDA did not become available"; }
  echo "✔ KEDA operator, metrics server and admission webhooks available"
fi
scale_by_hand() { [ -z "$MANUAL" ] || { k -n reelforge scale deployment reelforge-worker --replicas="$1" >/dev/null; echo "   (by hand, no KEDA operator) worker replicas -> $1"; }; }

echo "== PostgreSQL, MinIO, mock licence server; secrets"
DBPASS=$(openssl rand -hex 16) S3_ID=e2e$(openssl rand -hex 6) S3_SECRET=$(openssl rand -hex 20) KEY=rf_$(openssl rand -hex 24)
LICENCE_KEY=$(openssl rand -hex 13 | cut -c1-25 | tr 'a-f01' 'A-FGH' | sed 's/.\{5\}/&-/g;s/-$//')
k apply -f deployment/kubernetes/base/namespace.yaml >/dev/null
k create namespace db >/dev/null; k create namespace minio >/dev/null
for ns in db minio; do k -n $ns create secret generic e2e --from-literal=db-password="$DBPASS" --from-literal=s3-access-key-id="$S3_ID" --from-literal=s3-secret-access-key="$S3_SECRET" >/dev/null; done
k -n reelforge create secret generic e2e-licence --from-literal=seed-keys="[{\"key\":\"$LICENCE_KEY\",\"activationLimit\":1}]" >/dev/null
k -n reelforge create configmap e2e-mock-licence --from-file=server.mjs=e2e/mock-licence/server.mjs >/dev/null
k -n reelforge create secret generic reelforge --from-literal=database-url="postgresql://reelforge:$DBPASS@postgres.db.svc:5432/reelforge" \
  --from-literal=secret-key="$(openssl rand -base64 32)" --from-literal=s3-access-key-id="$S3_ID" --from-literal=s3-secret-access-key="$S3_SECRET" \
  --from-literal=bootstrap-key="$KEY" >/dev/null
sed -e "s#__POSTGRES_IMAGE__#$POSTGRES_IMAGE#; s#__MINIO_IMAGE__#$MINIO_IMAGE#; s#__NODE_IMAGE__#$IMAGE#" e2e/k8s/deps.yaml | k apply -f - >/dev/null
for d in db/postgres minio/minio reelforge/licence; do k -n "${d%/*}" rollout status "deployment/${d#*/}" --timeout=180s >/dev/null \
  || { k -n "${d%/*}" describe pods | tail -15; k -n "${d%/*}" logs "deployment/${d#*/}" --tail=20; fail "$d not ready"; }; done
# The bucket, created with the AWS SDK that ships in the release image.
k -n minio run mkbucket --image="$IMAGE" --image-pull-policy=Never --restart=Never --rm -i --quiet --command \
  --env="S3_ID=$S3_ID" --env="S3_SECRET=$S3_SECRET" -- sh -c "cd /app/packages/core && node --input-type=module -e \"
  import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
  await new S3Client({ endpoint: 'http://minio.minio.svc:9000', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ID, secretAccessKey: process.env.S3_SECRET } }).send(new CreateBucketCommand({ Bucket: 'reelforge-e2e' }));\"" \
  || fail "could not create the bucket"
echo "✔ postgres ($POSTGRES_IMAGE), minio ($MINIO_IMAGE, bucket reelforge-e2e), licence mock ready"
psql_() { k -n db exec deploy/postgres -- psql -U reelforge -d reelforge -tAc "$1"; }

echo "== reelforge: kubectl apply -k e2e/k8s/scaledobject (= deployment/kubernetes/keda/ + test settings)"
k apply -k e2e/k8s/scaledobject >/dev/null
# The other variants as shipped (not the test overlays), validated by the API server against KEDA's CRDs
# (and by KEDA's admission webhook when the operator runs).
for v in keda/mysql keda/scaledjob; do k apply --dry-run=server -k "deployment/kubernetes/$v" >/dev/null || fail "deployment/kubernetes/$v rejected by the API server"; done
echo "✔ deployment/kubernetes/keda/mysql and keda/scaledjob accepted by the API server (server-side dry run)"
k -n reelforge rollout status deployment/reelforge-api --timeout=300s >/dev/null || { k -n reelforge logs deploy/reelforge-api --tail=30; fail "api not ready"; }
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 2; done
client() { PHASE=$1 URL="http://127.0.0.1:$PORT" KEY="$KEY" LICENCE_KEY="$LICENCE_KEY" SAMPLE=examples/sample-reel.json OUT="$OUT" node e2e/k8s/keda.mjs; }
client setup
if [ -z "$MANUAL" ]; then
  k -n reelforge get scaledobject reelforge-worker -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' | grep -q True \
    && echo "✔ ScaledObject Ready (KEDA reaches PostgreSQL with the TriggerAuthentication)" \
    || { k -n reelforge describe scaledobject reelforge-worker | tail -20; fail "ScaledObject not ready"; }
fi

replicas() { k -n reelforge get deploy reelforge-worker -o jsonpath='{.spec.replicas} {.status.readyReplicas}'; }
wait_zero() { # timeout seconds; prints the time it reached 0 pods
  for _ in $(seq 1 "$1"); do
    [ "$(replicas | cut -d' ' -f1)" = 0 ] && [ -z "$(k -n reelforge get pods -l app.kubernetes.io/component=worker -o name)" ] && { now; return 0; }
    sleep 1
  done
  return 1
}
monitor() { while :; do echo "$(now) $(replicas)" >> "$1"; sleep 1; done; }

echo "== KED-01: no jobs -> 0 workers"
scale_by_hand 0
wait_zero 300 >/dev/null || fail "the worker Deployment did not go to 0 pods: $(replicas)"
echo "✔ worker Deployment at 0 pods (${MANUAL:+by hand, }nothing queued)"

echo "== KED-02/03: $JOBS renders through the api, workers 0 -> N"
monitor "$OUT/replicas.log" & MON_PID=$!
scale_by_hand "$MAX"
( for _ in $(seq 1 30); do sleep 3; v=$(psql_ "SELECT COUNT(*)::float / 1 FROM \"Job\" WHERE queue = 'database' AND status IN ('queued', 'running')" 2>/dev/null) && echo "$(now) $v" >> "$OUT/query.log"; done ) &
client burst
python3 - "$OUT" "$MAX" "$JOBS" <<'PY' || exit 1
import json, sys
out, mx, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
b = json.load(open(f"{out}/burst.json"))
reps = [tuple(int(x) if x else 0 for x in (l.split() + ["", ""])[1:3]) for l in open(f"{out}/replicas.log")]
peak = max(r[0] for r in reps); ready = max(r[1] for r in reps)
pods = {j["workerId"].rsplit("-", 1)[0] for j in b["jobs"]}
q = [float(l.split()[1]) for l in open(f"{out}/query.log")] if __import__("os").path.exists(f"{out}/query.log") else []
ok = 1 < peak <= mx and len(pods) > 1 and all(j["attempts"] == 1 for j in b["jobs"])
print(("✔" if ok else "✘") + f" workers scaled 0 -> {peak} (ready {ready}, max {mx}); {n} jobs ran on {len(pods)} pods, attempts {sorted({j['attempts'] for j in b['jobs']})}; KEDA query values seen: {sorted(set(q), reverse=True)[:6]}")
sys.exit(0 if ok else 1)
PY
ids=$(python3 -c 'import json,sys; print(",".join("'"'"'"+j["id"]+"'"'"'" for j in json.load(open(sys.argv[1]))["jobs"]))' "$OUT/burst.json")
runs=$(psql_ "SELECT count(*) FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\" IN ($ids)")
per=$(psql_ "SELECT count(DISTINCT \"jobId\") FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\" IN ($ids)")
[ "$runs" = "$JOBS" ] && [ "$per" = "$JOBS" ] && echo "✔ exactly one 'running' event per job in PostgreSQL ($runs for $JOBS jobs)" || fail "running events: $runs over $per jobs"
psql_ "SELECT (extract(epoch FROM min(at)) * 1000)::bigint FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\" IN ($ids)" > "$OUT/first-claim.txt"

echo "== KED-04: back to 0 after cooldown"
scale_by_hand 0
zero_at=$(wait_zero 600) || fail "workers did not return to 0: $(replicas)"
echo "$zero_at" > "$OUT/zero.txt"
kill "$MON_PID"; MON_PID=
python3 - "$OUT" "$MAX" "${MANUAL:+by hand at the first enqueue (no KEDA operator)}" <<'PY' | tee "$OUT/timings.txt"
import json, sys
out, mx = sys.argv[1], int(sys.argv[2])
b = json.load(open(f"{out}/burst.json")); t0 = b["enqueuedAt"]
reps = [(int(l.split()[0]), *[int(x) if x else 0 for x in (l.split() + ["", ""])[1:3]]) for l in open(f"{out}/replicas.log")]
first = lambda f: next((t for t, s, r in reps if f(s, r)), None)
iso = lambda s: __import__("datetime").datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
last_done = max(iso(j["finishedAt"]) for j in b["jobs"])
claim = int(open(f"{out}/first-claim.txt").read().strip()); zero = int(open(f"{out}/zero.txt").read().strip())
peak = max(s for _, s, _ in reps)
t = {
  "scaler": sys.argv[3] or "KEDA", "jobs": len(b["jobs"]), "max_replicas": mx, "peak_replicas": peak,
  "first_pod_scheduled_s": round((first(lambda s, r: s >= 1) - t0) / 1000, 1),
  "first_pod_ready_s": round((first(lambda s, r: r >= 1) - t0) / 1000, 1),
  "first_claim_s": round((claim - t0) / 1000, 1),
  "peak_replicas_decided_s": round((first(lambda s, r: s >= peak) - t0) / 1000, 1),
  "peak_replicas_ready_s": round(((first(lambda s, r: r >= peak) or t0) - t0) / 1000, 1),
  "all_done_s": round((last_done - t0) / 1000, 1),
  "back_to_zero_after_last_job_s": round((zero - last_done) / 1000, 1),
}
json.dump(t, open(f"{out}/timings.json", "w"))
print("✔ timings (s from the first enqueue): " + ", ".join(f"{k} {v}" for k, v in t.items()))
PY

echo "== KED-05: a worker pod deleted mid-render (grace 0, --force)"
scale_by_hand 2
client start
victim=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["workerId"].rsplit("-",1)[0])' "$OUT/slow.json")
k -n reelforge delete pod "$victim" --grace-period=0 --force >/dev/null 2>&1; echo "   deleted pod $victim while it rendered"
client finish
slow=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$OUT/slow.json")
python3 - "$OUT/finish.json" "$victim" "$(psql_ "SELECT count(*) FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\"='$slow'")" <<'PY' || exit 1
import json, sys
j, victim, runs = json.load(open(sys.argv[1])), sys.argv[2], int(sys.argv[3])
ok = j["status"] == "succeeded" and runs == 2 and not j["workerId"].startswith(victim + "-")
print(("✔" if ok else "✘") + f" re-queued and finished by {j['workerId']} (attempt {j['attempts']}, {runs} 'running' events: one per claim)")
sys.exit(0 if ok else 1)
PY
scale_by_hand 0
wait_zero 600 >/dev/null || fail "workers did not return to 0 after KED-05"
echo "✔ back to 0 workers"

echo "== KED-06: ScaledJob variant (worker --once): kubectl apply -k e2e/k8s/scaledjob"
k -n reelforge delete scaledobject reelforge-worker >/dev/null; k -n reelforge delete deployment/reelforge-worker service/reelforge-worker-metrics pdb/reelforge-worker >/dev/null
k apply -k e2e/k8s/scaledjob >/dev/null
[ -z "$MANUAL" ] && for _ in $(seq 1 60); do k -n reelforge get scaledjob reelforge-worker-once -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' | grep -q True && break; sleep 2; done
[ -n "$MANUAL" ] || k -n reelforge get scaledjob reelforge-worker-once -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' | grep -q True || fail "ScaledJob not ready"
by_hand_jobs() { # what KEDA would create: $MAX Jobs from the ScaledJob's jobTargetRef
  k -n reelforge get scaledjob reelforge-worker-once -o json | python3 -c '
import json, sys
sj, n = json.load(sys.stdin), int(sys.argv[1])
for i in range(n):
    print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": f"reelforge-worker-once-byhand-{i}", "namespace": "reelforge"}, "spec": sj["spec"]["jobTargetRef"]}))
' "$MAX" | k apply -f - >/dev/null
  echo "   (by hand) $MAX Jobs created from the ScaledJob's jobTargetRef"
}
( while :; do echo "$(now) $(k -n reelforge get jobs -o jsonpath='{range .items[*]}{.status.active}{" "}{end}' | wc -w)" >> "$OUT/jobs.log"; sleep 1; done ) & MON_PID=$!
if [ -n "$MANUAL" ]; then JOBS_SCALEDJOB=$MAX; JOBS=$MAX client burst & sleep 3; by_hand_jobs; wait $!; else JOBS=$JOBS_SCALEDJOB client burst; fi
kill "$MON_PID"; MON_PID=
ids=$(python3 -c 'import json,sys; print(",".join("'"'"'"+j["id"]+"'"'"'" for j in json.load(open(sys.argv[1]))["jobs"]))' "$OUT/burst.json")
runs=$(psql_ "SELECT count(*) FROM \"JobEvent\" WHERE type='status' AND message='running' AND \"jobId\" IN ($ids)")
peak=$(awk '$2>m{m=$2} END{print m+0}' "$OUT/jobs.log")
[ "$runs" = "$JOBS_SCALEDJOB" ] && [ "$peak" -gt 1 ] && [ "$peak" -le "$MAX" ] && echo "✔ $JOBS_SCALEDJOB renders, one 'running' event each, up to $peak Kubernetes Jobs at once (max $MAX)" \
  || fail "ScaledJob: $runs running events, peak $peak active Jobs"
for _ in $(seq 1 120); do [ -z "$(k -n reelforge get pods -l app.kubernetes.io/component=worker-once --field-selector=status.phase!=Succeeded,status.phase!=Failed -o name)" ] && break; sleep 2; done
[ -z "$(k -n reelforge get pods -l app.kubernetes.io/component=worker-once --field-selector=status.phase!=Succeeded,status.phase!=Failed -o name)" ] || fail "worker-once pods still running"
k -n reelforge wait --for=condition=Complete job --all --timeout=120s >/dev/null || { k -n reelforge get jobs; fail "a Kubernetes Job did not complete"; }
echo "✔ all $(k -n reelforge get jobs -o name | wc -l) Kubernetes Jobs Complete (exit 0), none failed; no worker pod left running (zero pods)"

echo "== no secret in any pod log"
for p in $(k -n reelforge get pods -o name); do k -n reelforge logs "$p" --all-containers >> "$WORK/all.log" 2>&1 || true; done
for s in "$KEY" "$DBPASS" "$S3_SECRET" "$LICENCE_KEY"; do grep -qF -- "$s" "$WORK/all.log" && fail "a secret is in a pod log"; done
echo "✔ no API key, database password, S3 secret or licence key in $(wc -l < "$WORK/all.log") log lines"
[ -n "$MANUAL" ] && { echo "CHECKS WITHOUT THE KEDA OPERATOR PASSED (KED-03, KED-05, KED-06 job template; scaling by hand: KED-01/02/04 and KEDA's Job creation NOT TESTED; results in $OUT)"; exit 0; }
echo "ALL KEDA E2E CHECKS PASSED (kind $KIND_VERSION, Kubernetes $(k version -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["serverVersion"]["gitVersion"])'), KEDA $KEDA_VERSION, image $IMAGE; results in $OUT)"
