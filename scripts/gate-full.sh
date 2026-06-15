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

# Once package.json exists, test:e2e is a hard contract (task 1.14) — a missing
# script is a failure, not a silent skip.
if ! pnpm run | grep -qE "^[[:space:]]*test:e2e([[:space:]]|$)"; then
  echo "[gate-full] ERROR: required script 'test:e2e' is missing from package.json." >&2
  echo "[gate-full] The full gate requires the e2e script wired by task 1.14." >&2
  exit 1
fi

echo "[gate-full] pnpm test:e2e"
pnpm run test:e2e

echo "[gate-full] full gate OK"
