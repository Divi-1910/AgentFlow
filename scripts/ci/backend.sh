#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

if [[ -z "${MONGO_TEST_URI:-}" ]]; then
  echo "MONGO_TEST_URI is required because the backend test suite drops its fixed test databases." >&2
  exit 2
fi

cd "${repo_root}/backend"

unformatted="$(gofmt -l .)"
if [[ -n "${unformatted}" ]]; then
  echo "The following Go files are not formatted:" >&2
  printf '%s\n' "${unformatted}" >&2
  exit 1
fi

go mod tidy -diff
go vet ./...
go test -count=1 -timeout=300s ./...
go test -race -count=1 -timeout=300s ./agent ./dispatcher ./handlers ./runtime
go build ./...
