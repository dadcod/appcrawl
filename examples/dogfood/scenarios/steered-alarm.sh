#!/usr/bin/env bash
# Steered test: create an alarm in the Clock app.
# Tests time-picker interaction and complex native controls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Steered: Create an alarm in Clock app ==="

node "$APPCRAWL" run \
  "Open the Clock app, go to the Alarm tab, tap + to add a new alarm, set it for 7:30 AM, label it 'Test Alarm', and save. Verify the alarm appears in the list and is enabled." \
  --app com.apple.mobiletimer \
  --platform ios \
  --max-steps 25 \
  --step-delay 2500 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
