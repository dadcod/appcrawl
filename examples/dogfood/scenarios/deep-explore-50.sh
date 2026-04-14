#!/usr/bin/env bash
# Long exploration: 50 steps through Settings.
# Tests whether the agent can explore broadly without getting stuck
# in loops or exhausting its action space.
#
# What to watch for:
#   - Does it visit 10+ unique screens?
#   - Does it get stuck tapping the same thing repeatedly?
#   - Does it navigate back when it hits a dead end?
#   - Does the LLM context/cost stay reasonable over 50 calls?
#   - Do screenshots accumulate correctly (50 PNGs)?

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Deep explore — 50 steps through Settings ==="

node "$APPCRAWL" explore \
  --app com.apple.Preferences \
  --platform ios \
  --max-steps 50 \
  --step-delay 2000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
