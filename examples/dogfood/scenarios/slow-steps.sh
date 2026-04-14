#!/usr/bin/env bash
# Slow step delay: 5000ms between steps.
# Simulates an app with heavy animations, splash screens, or slow
# network calls where you need the UI to fully settle before
# screenshotting.
#
# 15 steps × 5s delay = ~75s of idle wait alone, plus LLM latency.
# Total run time should be 3–5 minutes.
#
# This also tests whether the agent's "wait" tool is redundant
# when the step delay is already long — it shouldn't need to call
# wait() if 5s is enough.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPCRAWL="${SCRIPT_DIR}/../../../dist/index.js"

echo "=== Slow steps — 5000ms delay, 15 steps ==="

node "$APPCRAWL" explore \
  --app com.apple.mobilecal \
  --platform ios \
  --max-steps 15 \
  --step-delay 5000 \
  --model "${APPCRAWL_MODEL:-gemini-2.0-flash}" \
  --verbose
