#!/bin/bash
# Build, push to Zot registry, and restart the nanoclaw k3s deployment.
# Requires: Docker with 102.209.85.138:30406 in insecure-registries,
#           kubectl configured against the remote k3s cluster.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSH_REGISTRY="102.209.85.138:30406"
K3S_IMAGE="102.209.85.138:5000/nanoclaw:latest"
PUSH_IMAGE="${PUSH_REGISTRY}/nanoclaw:latest"

echo "Building nanoclaw image..."
docker build -t "$PUSH_IMAGE" "$REPO_ROOT"

echo "Pushing to Zot registry at ${PUSH_REGISTRY}..."
docker push "$PUSH_IMAGE"

echo "Restarting k3s deployment..."
kubectl rollout restart deployment/nanoclaw -n default
kubectl rollout status deployment/nanoclaw -n default

echo "Done. Running image: ${K3S_IMAGE}"
