#!/usr/bin/env bash
# Validate the K8s baseline without a cluster.
#   scripts/ops/validate-k8s.sh
# Requires kubectl; uses kubeconform when installed (CI downloads it).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
kubectl kustomize ops/k8s > /tmp/tapeci-k8s-rendered.yaml
if command -v kubeconform >/dev/null 2>&1; then
  kubeconform -strict -summary -ignore-missing-schemas /tmp/tapeci-k8s-rendered.yaml
else
  echo "kubeconform not installed; kubectl kustomize render passed"
fi
