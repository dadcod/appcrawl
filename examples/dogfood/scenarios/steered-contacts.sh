#!/usr/bin/env bash
# Steered test: create a contact with specific details.
# Tests complex form-filling with multi-field validation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Steered: Create a contact in Contacts app ==="

node "$APPCRAWL" run \
  "Open Contacts, tap the + button to add a new contact. Fill in first name 'Test', last name 'User', phone number '555-0100'. Save the contact. Then search for 'Test User' and verify it appears in the list." \
  --app com.apple.MobileAddressBook \
  --platform ios \
  --max-steps 25 \
  --step-delay 2000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
