#!/usr/bin/env bash
set -euo pipefail

# Build script: creates the XPI exactly from the readable source files.
# Requirements: zip (infozip)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

OUT="mobile-interceptor.xpi"

# Clean previous build
rm -f "$OUT"

# Create XPI
zip -r "$OUT" \
  manifest.json \
  background.js \
  ui/ \
  icons/

echo "[OK] Built: $OUT"
echo "Contents:"
zipinfo -1 "$OUT" | sed -n '1,200p'
