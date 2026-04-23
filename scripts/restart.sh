#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.windsurfapi}"
SERVICE_NAME="${SERVICE_NAME:-windsurfpoolapi}"

cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found"
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "❌ systemctl not found"
  exit 1
fi

if [ ! -d "$INSTALL_DIR" ]; then
  echo "❌ install dir not found: $INSTALL_DIR"
  exit 1
fi

echo "📁 Syncing files to $INSTALL_DIR ..."
rm -rf "$INSTALL_DIR/src"
cp -R "$ROOT_DIR/src" "$INSTALL_DIR/"
cp "$ROOT_DIR/package.json" "$INSTALL_DIR/"
cp "$ROOT_DIR/README.md" "$INSTALL_DIR/" 2>/dev/null || true
cp "$ROOT_DIR/CHANGELOG.md" "$INSTALL_DIR/" 2>/dev/null || true
cp "$ROOT_DIR/LICENSE" "$INSTALL_DIR/" 2>/dev/null || true

echo "🔄 Restarting systemd service: $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "📋 Service status"
sudo systemctl --no-pager --full status "$SERVICE_NAME" || true

echo "✅ Done"
echo "   Install dir: $INSTALL_DIR"
echo "   Service: $SERVICE_NAME"
echo "   Logs: sudo journalctl -u $SERVICE_NAME -f"

