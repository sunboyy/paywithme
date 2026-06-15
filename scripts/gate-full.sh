#!/usr/bin/env bash
# Full gate — run at a phase boundary before the human review/merge pause.
# Fast gate + Playwright e2e.
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/gate.sh

if [ ! -f package.json ]; then
  echo "[gate-full] No package.json yet (pre-scaffold). Skipping e2e."
  exit 0
fi

if pnpm run | grep -qE "^[[:space:]]*test:e2e([[:space:]]|$)"; then
  echo "[gate-full] pnpm test:e2e"
  pnpm run test:e2e
else
  echo "[gate-full] (skip) no 'test:e2e' script defined"
fi

echo "[gate-full] full gate OK"
