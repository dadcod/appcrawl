# Running AppCrawl in CI

AppCrawl is designed to work the same on your laptop as it does in CI: you
give it a bundle id and optionally an app binary, it boots a device if
none is running, runs the exploration, and writes reports.

## How it exits

AppCrawl follows standard Unix exit-code conventions so CI can make
pass/fail decisions without parsing logs:

| Exit code | Meaning                                                                         |
|-----------|---------------------------------------------------------------------------------|
| `0`       | Clean run: no blocking issues, no test failures                                 |
| `1`       | Test failure: at least one `critical`/`major` issue, or `mark_complete("fail")` |
| `2`       | Infrastructure error: Maestro missing, device setup failed, license invalid    |

Use `--ci` to enable CI mode:
- No auto-opening the HTML report in a browser
- `junit.xml` is always emitted alongside `report.json` and `report.html`
- Exit code reflects pass/fail (outside CI mode it's always 0 on normal runs)

## What gets written to disk

Every run produces a timestamped directory under `./appcrawl-reports/`:

```
appcrawl-reports/2025-01-15T12-34-56-789Z/
├── report.json       # machine-readable (actions, issues, screens, timing)
├── report.html       # human-readable with embedded screenshots
├── junit.xml         # for CI consumers (dorny/test-reporter, etc.)
└── screenshots/
    ├── step-1.png
    ├── step-2.png
    └── ...
```

Upload the whole directory as a build artifact so developers can click
through what the agent saw when a test fails.

## Required setup

Every CI job needs:
1. **Maestro** (bundles the device bridge used by AppCrawl)
2. **Java 17+** (Maestro is JVM-based)
3. **Node 22+** to run AppCrawl itself
4. **A device or simulator/emulator** — AppCrawl auto-boots one if none is running
5. **An LLM API key** as an env var (e.g. `ANTHROPIC_API_KEY`)

## The files in this directory

- `github-actions-ios.yml` — macOS runner, xcodebuild, auto-booted iPhone simulator
- `github-actions-android.yml` — Ubuntu runner + KVM, reactivecircus/android-emulator-runner

Both are starting points — adjust the build step for your project and the
bundle id / app binary path for your app. The appcrawl invocation itself
is the same command you'd run locally, just with `--ci` added.

## Local parity

You can reproduce the CI run locally by running the same command the
workflow runs. AppCrawl auto-detects the already-running device on your
laptop, and auto-boots a new one if not. There's no "CI harness" — `--ci`
only changes output behavior (no browser auto-open, exit code matters).

```bash
# Same command that runs in CI:
appcrawl explore --app com.example.app --platform ios --install build/YourApp.app --ci
```

## Cost per run

AppCrawl uses whatever LLM you bring. A 30-step exploration typically
costs **$0.05–$0.50** depending on the model:

- `gemini-2.0-flash` — ~$0.02/run (free tier covers ~20 runs/day)
- `claude-sonnet-4-5` — ~$0.30/run
- `gpt-4o` — ~$0.20/run

AppCrawl itself has zero per-run cost — you bring your own API key.
