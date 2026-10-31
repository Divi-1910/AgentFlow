#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="${ROOT_DIR}/.runtime/pids"

stop_one() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"

  if [[ ! -f "${pid_file}" ]]; then
    echo "${name}: not managed"
    return
  fi

  local pid
  pid="$(<"${pid_file}")"
  if [[ ! "${pid}" =~ ^[0-9]+$ ]]; then
    echo "${name}: invalid PID file; removing it" >&2
    rm -f "${pid_file}"
    return
  fi

  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "${name}: stale PID ${pid}; removing PID file"
    rm -f "${pid_file}"
    return
  fi

  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true

  for ((attempt = 1; attempt <= 20; attempt++)); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${pid_file}"
      echo "${name}: stopped"
      return
    fi
    sleep 0.25
  done

  echo "${name}: did not stop gracefully; forcing managed process group ${pid}" >&2
  kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  rm -f "${pid_file}"
}

stop_one sequential-thinking
stop_one fetch
stop_one python-sandbox
stop_one math-utilities
stop_one open-meteo

