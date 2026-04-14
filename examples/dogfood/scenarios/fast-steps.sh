#!/usr/bin/env bash
# Fast step delay: 500ms between steps.
# Tests whether rapid-fire actions cause stale screenshots,
# missed screen transitions, or race conditions in Maestro.
#
# On a simulator with heavy animations, 500ms may be too fast —
# the agent will see the old screen in the screenshot and make
# decisions based on stale state. This is intentional: we want
# to see how gracefully it recovers.
#
# Compare the report from this run against the same app with
# the default 2000ms delay to see if reliability drops.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Fast steps — 500ms delay, 20 steps ==="

node "$APPCRAWL" explore \
  --app com.apple.Preferences \
  --platform ios \
  --max-steps 20 \
  --step-delay 500 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
