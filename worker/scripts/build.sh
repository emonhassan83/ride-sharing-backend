#!/usr/bin/env bash
set -euo pipefail

echo "[build] Cleaning dist..."
rm -rf dist

echo "[build] Compiling TypeScript..."
npx tsc --project tsconfig.json

echo "[build] Resolving path aliases..."
npx tsc-alias --project tsconfig.json

echo "[build] Done → dist/"