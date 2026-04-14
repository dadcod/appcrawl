#!/usr/bin/env bash
# Explore the Wikipedia iOS app.
# Requires installing the app first — either build from source
# (github.com/wikimedia/wikipedia-ios) or download from App Store
# on a real device and copy the .app.
#
# Tests:
#   - Search with keyboard input and result selection
#   - Article scrolling and in-page navigation
#   - Tab bar navigation (Explore/Places/Saved/History/Search)
#   - Settings and theme switching
#   - Rich content: images, tables, references
#   - Back/forward navigation within articles
#
# Bundle ID for the App Store version:
#   org.wikimedia.wikipedia
#
# If you built from source, the bundle ID may differ — check
# your Xcode project settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

BUNDLE_ID="${WIKIPEDIA_BUNDLE_ID:-org.wikimedia.wikipedia}"

echo "=== Wikipedia iOS — 30-step explore ==="
echo "Bundle ID: $BUNDLE_ID"
echo "Note: app must be installed on the simulator first."
echo ""

node "$APPCRAWL" explore \
  --app "$BUNDLE_ID" \
  --platform ios \
  --max-steps 30 \
  --step-delay 3000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
