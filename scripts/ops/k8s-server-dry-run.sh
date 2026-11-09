#!/usr/bin/env bash
# Server-side dry-run of the K8s baseline against a real cluster.
#   KUBECONFIG=... scripts/ops/k8s-server-dry-run.sh
# Never applies changes. Exits 2 when no cluster is configured.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
if [ -z "${KUBECONFIG:-}" ] && ! kubectl cluster-info >/dev/null 2>&1; then
  echo "no cluster: set KUBECONFIG (or configure kubectl) to run server-side dry-run" >&2
  exit 2
fi
kubectl kustomize ops/k8s | kubectl apply --dry-run=server -f -
echo "server-side dry-run: OK"
