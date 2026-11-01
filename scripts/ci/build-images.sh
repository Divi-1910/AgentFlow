#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

image_prefix="${CI_IMAGE_PREFIX:-agentflow-ci}"
image_tag="${CI_IMAGE_TAG:-check}"

export DOCKER_BUILDKIT=1

docker build \
  --file "${repo_root}/backend/Dockerfile" \
  --tag "${image_prefix}-backend:${image_tag}" \
  "${repo_root}/backend"

docker build \
  --file "${repo_root}/backend/Dockerfile.runtime" \
  --tag "${image_prefix}-runtime:${image_tag}" \
  "${repo_root}/backend"
