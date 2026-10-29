#!/usr/bin/env bash
# Builds dist/op-scribe-<version>.zip with only the files Chrome needs.
# Tests, tools, docs and repository metadata are never shipped.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(node -p "require('./manifest.json').version")"
out="dist/op-scribe-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json service-worker.js shared content sidepanel icons -x '*.DS_Store'
echo "$out"
unzip -l "$out" | tail -n +4 | awk '{print $4}' | sed '/^$/d'
