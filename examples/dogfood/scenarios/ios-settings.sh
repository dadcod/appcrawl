#!/usr/bin/env bash
# Explore the built-in iOS Settings app.
# No install needed — Settings is always present on every simulator.
#
# Good test because:
#   - Deep nested navigation (General → About → Legal → ...)
#   - Toggle switches (boolean state changes)
#   - Search bar at the top
#   - Alerts/modals (e.g. "Reset All Settings")
#   - Scrolling required to reach lower sections
#
# Expected: agent should visit 5+ unique screens, no crashes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== iOS Settings — 30-step explore ==="

node "$APPCRAWL" explore \
  --app com.apple.Preferences \
  --platform ios \
  --max-steps 30 \
  --step-delay 2000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
