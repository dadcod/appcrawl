#!/usr/bin/env bash
# Steered test: navigate to a specific setting and toggle it.
# Tests goal-directed behavior with natural language instruction.
#
# Good test because:
#   - Requires multi-step navigation (Settings → Display → Dark Mode)
#   - Agent must find and interact with a toggle
#   - Clear pass/fail criteria
#   - Tests the "mark_complete" flow

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Steered: Find and toggle Dark Mode in Settings ==="

node "$APPCRAWL" run \
  "Open Settings, navigate to Display & Brightness, and toggle the Dark Mode appearance. Verify the appearance changed." \
  --app com.apple.Preferences \
  --platform ios \
  --max-steps 20 \
  --step-delay 2000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
