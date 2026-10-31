#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_DIR="${ROOT_DIR}/upstream"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
DENO_INSTALL_DIR="${RUNTIME_DIR}/deno"
DENO_VERSION="v2.9.7"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

clone_if_missing() {
  local repository_url="$1"
  local destination="$2"

  if [[ -d "${destination}/.git" ]]; then
    echo "Using existing checkout: ${destination}"
    return
  fi

  if [[ -e "${destination}" ]]; then
    echo "Cannot clone into non-Git path: ${destination}" >&2
    exit 1
  fi

  git clone --depth 1 "${repository_url}" "${destination}"
}

require_command curl
require_command git
require_command npm
require_command node
require_command setsid
require_command unzip
require_command uv

mkdir -p "${UPSTREAM_DIR}" "${RUNTIME_DIR}"

clone_if_missing \
  "https://github.com/modelcontextprotocol/servers.git" \
  "${UPSTREAM_DIR}/modelcontextprotocol-servers"
clone_if_missing \
  "https://github.com/sparfenyuk/mcp-proxy.git" \
  "${UPSTREAM_DIR}/mcp-proxy"
clone_if_missing \
  "https://github.com/pydantic/mcp-run-python.git" \
  "${UPSTREAM_DIR}/mcp-run-python"
clone_if_missing \
  "https://github.com/codeprimate/math-mcp.git" \
  "${UPSTREAM_DIR}/math-mcp"
clone_if_missing \
  "https://github.com/cmer81/open-meteo-mcp.git" \
  "${UPSTREAM_DIR}/open-meteo-mcp"

if [[ ! -x "${DENO_INSTALL_DIR}/bin/deno" ]]; then
  installer_path="${RUNTIME_DIR}/deno-install.sh"
  curl -fsSL "https://deno.land/install.sh" -o "${installer_path}"
  DENO_INSTALL="${DENO_INSTALL_DIR}" sh "${installer_path}" "${DENO_VERSION}"
fi

echo "Installing the MCP HTTP bridge..."
uv sync --project "${UPSTREAM_DIR}/mcp-proxy" --frozen --no-dev

echo "Installing Sequential Thinking..."
npm ci \
  --prefix "${UPSTREAM_DIR}/modelcontextprotocol-servers" \
  --workspace src/sequentialthinking \
  --include-workspace-root=false
npm run \
  --prefix "${UPSTREAM_DIR}/modelcontextprotocol-servers" \
  build \
  --workspace src/sequentialthinking

echo "Installing Fetch..."
uv sync \
  --project "${UPSTREAM_DIR}/modelcontextprotocol-servers/src/fetch" \
  --frozen \
  --no-dev

echo "Installing Python Sandbox..."
uv sync --project "${UPSTREAM_DIR}/mcp-run-python" --frozen --no-dev
uv run \
  --project "${UPSTREAM_DIR}/mcp-run-python" \
  --frozen \
  --no-dev \
  "${UPSTREAM_DIR}/mcp-run-python/build/build.py"

echo "Installing Math & Utilities..."
uv sync --project "${UPSTREAM_DIR}/math-mcp" --frozen --no-dev

echo "Installing Open-Meteo..."
npm ci --prefix "${UPSTREAM_DIR}/open-meteo-mcp"
npm run --prefix "${UPSTREAM_DIR}/open-meteo-mcp" build

echo
echo "Local MCP dependencies are ready. Run: ${ROOT_DIR}/start-all.sh"
