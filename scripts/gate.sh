#!/usr/bin/env bash
# Fast gate — run on every task before commit.
# Lint + format check + typecheck + unit tests.
# Degrades gracefully before the project is scaffolded (no package.json yet).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f package.json ]; then
  echo "[gate] No package.json yet (pre-scaffold). Skipping fast gate."
  exit 0
fi

# Helper: run a pnpm script only if it is defined in package.json.
run_if_present() {
  local script="$1"
  if pnpm run | grep -qE "^[[:space:]]*${script}([[:space:]]|$)"; then
    echo "[gate] pnpm ${script}"
    pnpm run "${script}"
  else
    echo "[gate] (skip) no '${script}' script defined"
  fi
}

run_if_present lint
run_if_present format:check
run_if_present check        # svelte-check / tsc typecheck
run_if_present test:unit

echo "[gate] fast gate OK"
