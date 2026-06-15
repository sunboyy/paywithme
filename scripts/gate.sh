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

# Detect whether a pnpm script is defined in package.json.
script_present() {
  pnpm run | grep -qE "^[[:space:]]*$1([[:space:]]|$)"
}

# Assert a required script exists, then run it. Once package.json exists these
# scripts are a hard contract — a missing one is a failure, not a silent skip.
require_script() {
  local script="$1"
  if ! script_present "${script}"; then
    echo "[gate] ERROR: required script '${script}' is missing from package.json." >&2
    echo "[gate] The fast gate requires the scripts wired by task 1.14:" >&2
    echo "[gate]   lint, format:check, check, test:unit" >&2
    exit 1
  fi
  echo "[gate] pnpm ${script}"
  pnpm run "${script}"
}

require_script lint
require_script format:check
require_script check        # svelte-check / tsc typecheck
require_script test:unit

echo "[gate] fast gate OK"
