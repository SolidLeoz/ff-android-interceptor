#!/usr/bin/env bash
set -euo pipefail

# Build script: compiles TypeScript into dist and creates the XPI.
# Requirements: zip (infozip), node + npm deps installed

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

OUT="mobile-interceptor.xpi"

# Clean previous build
rm -f "$OUT"

# Build dist
echo "[*] Building dist..."
npm run build

# Lint (requires web-ext: npm i -g web-ext)
if command -v web-ext &>/dev/null; then
  echo "[*] Running web-ext lint..."
  web-ext lint --source-dir="$ROOT_DIR/dist"
else
  echo "[!] web-ext not found, skipping lint"
fi

# Create XPI from dist
cd "$ROOT_DIR/dist"
zip -r "../$OUT" .
cd "$ROOT_DIR"

echo "[OK] Built: $OUT"
echo "Contents:"
zipinfo -1 "$OUT" | sed -n '1,200p'
