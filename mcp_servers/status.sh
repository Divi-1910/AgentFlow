#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="${ROOT_DIR}/.runtime/pids"

show_status() {
  local name="$1"
  local port="$2"
  local pid_file="${PID_DIR}/${name}.pid"
  local pid="-"
  local process_state="stopped"
  local port_state="closed"

  if [[ -f "${pid_file}" ]]; then
    pid="$(<"${pid_file}")"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
      process_state="running"
    else
      process_state="stale-pid"
    fi
  fi

  local listeners
  listeners="$(ss -ltnH "sport = :${port}")"
  if [[ -n "${listeners}" ]]; then
    port_state="listening"
  fi

  printf '%-22s pid=%-8s process=%-10s port=%s (%s)\n' \
    "${name}" "${pid}" "${process_state}" "${port}" "${port_state}"
}

show_status sequential-thinking 8101
show_status fetch 8102
show_status python-sandbox 8103
show_status math-utilities 8104
show_status open-meteo 8105

