#!/usr/bin/env bash
# Explore the built-in iOS Calendar app.
# Tests date picker, event creation, and modal interactions.
#
# Good test because:
#   - Date/time pickers (notoriously hard for UI automation)
#   - Event creation form (title, location, all-day toggle, alerts)
#   - Multiple view modes (day/week/month/year)
#   - Navigation between months/years
#   - "Add Calendar" and calendar management
#
# Expected: agent navigates different views, possibly creates an event.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== iOS Calendar — 25-step explore ==="

node "$APPCRAWL" explore \
  --app com.apple.mobilecal \
  --platform ios \
  --max-steps 25 \
  --step-delay 2500 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
