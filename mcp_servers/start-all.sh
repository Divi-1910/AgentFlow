#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_DIR="${ROOT_DIR}/upstream"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
PID_DIR="${RUNTIME_DIR}/pids"
LOG_DIR="${RUNTIME_DIR}/logs"
MATH_OUTPUT_DIR="${RUNTIME_DIR}/math-outputs"
START_TIMEOUT_SECONDS="${MCP_START_TIMEOUT_SECONDS:-120}"

PROXY_BIN="${UPSTREAM_DIR}/mcp-proxy/.venv/bin/mcp-proxy"
SEQUENTIAL_BIN="${UPSTREAM_DIR}/modelcontextprotocol-servers/src/sequentialthinking/dist/index.js"
FETCH_BIN="${UPSTREAM_DIR}/modelcontextprotocol-servers/src/fetch/.venv/bin/mcp-server-fetch"
PYTHON_SANDBOX_BIN="${UPSTREAM_DIR}/mcp-run-python/.venv/bin/mcp-run-python"
DENO_BIN_DIR="${RUNTIME_DIR}/deno/bin"
MATH_BIN="${UPSTREAM_DIR}/math-mcp/.venv/bin/math-mcp"
OPEN_METEO_BIN="${UPSTREAM_DIR}/open-meteo-mcp/dist/index.js"

port_is_listening() {
  local port="$1"
  local listeners
  listeners="$(ss -ltnH "sport = :${port}")"
  [[ -n "${listeners}" ]]
}

require_file() {
  if [[ ! -e "$1" ]]; then
    echo "Missing required local dependency: $1" >&2
    echo "Run ${ROOT_DIR}/setup.sh first." >&2
    exit 1
  fi
}

start_one() {
  local name="$1"
  local port="$2"
  shift 2

  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"

  if port_is_listening "${port}"; then
    echo "Cannot start ${name}: port ${port} is already in use." >&2
    exit 1
  fi

  if [[ -f "${pid_file}" ]]; then
    local existing_pid
    existing_pid="$(<"${pid_file}")"
    if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && kill -0 "${existing_pid}" 2>/dev/null; then
      echo "${name} already has a live managed process (PID ${existing_pid})." >&2
      exit 1
    fi
    rm -f "${pid_file}"
  fi

  printf '\n[%s] starting %s on 127.0.0.1:%s\n' \
    "$(date --iso-8601=seconds)" "${name}" "${port}" >>"${log_file}"

  nohup setsid "$@" >>"${log_file}" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "${pid}" >"${pid_file}"

  local attempts=$((START_TIMEOUT_SECONDS * 2))
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if port_is_listening "${port}"; then
      echo "Started ${name}: http://127.0.0.1:${port}/mcp (PID ${pid})"
      return
    fi

    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "${name} exited before opening port ${port}." >&2
      tail -n 30 "${log_file}" >&2
      rm -f "${pid_file}"
      exit 1
    fi

    sleep 0.5
  done

  echo "${name} did not open port ${port} within ${START_TIMEOUT_SECONDS}s." >&2
  kill -TERM -- "-${pid}" 2>/dev/null || true
  rm -f "${pid_file}"
  exit 1
}

require_file "${PROXY_BIN}"
require_file "${SEQUENTIAL_BIN}"
require_file "${FETCH_BIN}"
require_file "${PYTHON_SANDBOX_BIN}"
require_file "${DENO_BIN_DIR}/deno"
require_file "${MATH_BIN}"
require_file "${OPEN_METEO_BIN}"

mkdir -p "${PID_DIR}" "${LOG_DIR}" "${MATH_OUTPUT_DIR}"

start_one sequential-thinking 8101 \
  "${PROXY_BIN}" \
  --host 127.0.0.1 \
  --port 8101 \
  --stateless \
  -- \
  node "${SEQUENTIAL_BIN}"

start_one fetch 8102 \
  "${PROXY_BIN}" \
  --host 127.0.0.1 \
  --port 8102 \
  --stateless \
  -- \
  "${FETCH_BIN}"

start_one python-sandbox 8103 \
  env "PATH=${DENO_BIN_DIR}:${PATH}" \
  "${PROXY_BIN}" \
  --host 127.0.0.1 \
  --port 8103 \
  --stateless \
  -- \
  "${PYTHON_SANDBOX_BIN}" stdio

start_one math-utilities 8104 \
  env \
  MCP_TRANSPORT=streamable-http \
  MCP_HOST=127.0.0.1 \
  MCP_PORT=8104 \
  "MCP_OUTPUT_DIR=${MATH_OUTPUT_DIR}" \
  "${MATH_BIN}"

start_one open-meteo 8105 \
  env \
  -u API_KEY \
  TRANSPORT=http \
  HOST=127.0.0.1 \
  PORT=8105 \
  node "${OPEN_METEO_BIN}"

echo
echo "All local MCP servers are listening."
echo "Logs: ${LOG_DIR}"

