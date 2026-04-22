#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.windsurfpoolapi.pid"
LOG_FILE="$ROOT_DIR/.windsurfpoolapi.log"

cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found"
  exit 1
fi

stop_existing() {
  if [[ -f "$PID_FILE" ]]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "🛑 Stopping existing process: $OLD_PID"
      kill "$OLD_PID" 2>/dev/null || true
      for _ in {1..20}; do
        if ! kill -0 "$OLD_PID" 2>/dev/null; then
          break
        fi
        sleep 0.5
      done
      if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "⚠️ Process did not exit gracefully, forcing stop: $OLD_PID"
        kill -9 "$OLD_PID" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

stop_existing

echo "🚀 Starting WindsurfPoolAPI..."
nohup node src/index.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 2

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "✅ Started successfully"
  echo "   PID: $NEW_PID"
  echo "   Log: $LOG_FILE"
else
  echo "❌ Start failed, check log: $LOG_FILE"
  exit 1
fi
