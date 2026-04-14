#!/usr/bin/env bash
# Explore the built-in iOS Contacts app.
# Tests form-filling, create/edit/delete flows, and alert dialogs.
#
# Good test because:
#   - "Add Contact" is a complex multi-field form
#   - Swipe-to-delete interaction
#   - Confirmation alerts ("Delete Contact?")
#   - Search with keyboard input
#   - Empty state handling (no contacts yet on a fresh simulator)
#
# Expected: agent should create a contact, browse it, possibly delete it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== iOS Contacts — 25-step explore ==="

node "$APPCRAWL" explore \
  --app com.apple.MobileAddressBook \
  --platform ios \
  --max-steps 25 \
  --step-delay 2000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
