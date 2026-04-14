# Dogfooding AppCrawl

Test scenarios for validating AppCrawl against apps you didn't build.
Run these against real simulators to catch edge cases that only appear
outside the happy-path of your own app.

## Prerequisites

- Simulator or emulator booted (AppCrawl auto-boots if needed)
- At least one LLM API key set (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.)
- Maestro installed (`appcrawl doctor` to verify)

## Quick start

```bash
# Run any scenario from this directory:
cd examples/dogfood
bash scenarios/ios-settings.sh
```

## Scenarios

### System apps (no install needed)

| Scenario | Platform | What it tests |
|---|---|---|
| `ios-settings.sh` | iOS | Deep navigation, toggles, search, back-nav |
| `ios-contacts.sh` | iOS | Create/edit/delete flow, form filling, alerts |
| `ios-calendar.sh` | iOS | Date picker interaction, event creation |

### Open-source apps (build or download first)

| Scenario | Platform | App | What it tests |
|---|---|---|---|
| `wikipedia-ios.sh` | iOS | Wikipedia | Search, article nav, tabs, settings |
| `firefox-ios.sh` | iOS | Firefox | Tab management, URL bar, bookmarks |
| `signal-android.sh` | Android | Signal | Onboarding, permissions, empty states |

### Stress tests (longer runs)

| Scenario | Steps | What it tests |
|---|---|---|
| `deep-explore-50.sh` | 50 | Full breadth: can the agent visit 10+ screens without looping? |
| `steered-settings.sh` | 30 | Goal-directed: "find and toggle Dark Mode" |
| `fast-steps.sh` | 20 | `--step-delay 500`: can the agent keep up with fast transitions? |
| `slow-steps.sh` | 15 | `--step-delay 5000`: heavy animations, slow network |

## What to look for

- Agent getting stuck in a loop (tapping the same element repeatedly)
- Tap resolution failures ("Element X not found" when it's visible)
- Screenshot capture failures or blank screenshots
- Accessibility tree returning empty when the screen clearly has content
- Report generation failing on edge cases (zero issues, zero screenshots)
- Step delay affecting reliability (too fast = stale screenshots)
