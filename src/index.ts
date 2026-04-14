#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { resolve } from "node:path";
import { loadAppContext, contextToPrompt } from "./config/context.js";
import { runInit, runJiraSetup } from "./config/init.js";

// Load .env file if present
try {
  const envPath = resolve(import.meta.dirname, "../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // No .env file, that's fine
}
import { MaestroDriver, checkMaestroInstalled } from "./driver/maestro.js";
import { ensureDevice } from "./driver/device-manager.js";
import type { Platform } from "./driver/types.js";
import { runAgentLoop } from "./agent/loop.js";
import { generateReport, printConsoleSummary, computeExitCode } from "./reporter/reporter.js";
import { DEFAULTS } from "./config/defaults.js";
import { getLicenseStatus, saveLicense, checkAndConsumeUsage } from "./license/license.js";

const program = new Command();

program
  .name("appcrawl")
  .description("AI-powered app testing. Let an LLM explore and test your mobile or web app.")
  .version("0.1.0");

program
  .command("explore")
  .description("Autonomously explore the app, visiting screens and finding bugs")
  .option("--app <bundleId>", "App bundle ID — overrides config.<platform>.bundleId")
  .option("--app-dir <path>", "Path to app source code for auto-discovery")
  .option("--platform <platform>", "Target platform: ios, android, or web")
  .option("--url <url>", "URL to test (web platform only)")
  .option("--device <name>", "Device/simulator/AVD name (default: first available)")
  .option("--install <path>", "Path to .app/.apk to install before running")
  .option("--max-steps <n>", "Maximum exploration steps", String(DEFAULTS.maxSteps))
  .option("--step-delay <ms>", "Delay between steps in ms (default: 2000)", String(DEFAULTS.stepDelay))
  .option("--model <model>", "LLM model to use", DEFAULTS.model)
  .option("--verbose", "Enable verbose logging", false)
  .option("--ci", "CI mode: no auto-open, emit junit.xml, exit code reflects pass/fail", false)
  .action(async (opts) => {
    await runCommand("explore", opts);
  });

program
  .command("run <instruction>")
  .description("Run a steered test with a natural language instruction")
  .option("--app <bundleId>", "App bundle ID — overrides config.<platform>.bundleId")
  .option("--app-dir <path>", "Path to app source code for auto-discovery")
  .option("--platform <platform>", "Target platform: ios, android, or web")
  .option("--url <url>", "URL to test (web platform only)")
  .option("--device <name>", "Device/simulator/AVD name (default: first available)")
  .option("--install <path>", "Path to .app/.apk to install before running")
  .option("--max-steps <n>", "Maximum steps", String(DEFAULTS.steeredMaxSteps))
  .option("--step-delay <ms>", "Delay between steps in ms (default: 2000)", String(DEFAULTS.stepDelay))
  .option("--model <model>", "LLM model to use", DEFAULTS.model)
  .option("--verbose", "Enable verbose logging", false)
  .option("--ci", "CI mode: no auto-open, emit junit.xml, exit code reflects pass/fail", false)
  .action(async (instruction: string, opts) => {
    await runCommand("steered", opts, instruction);
  });

program
  .command("init")
  .description("Interactive setup — generates appcrawl.config.json")
  .option("--app <bundleId>", "Non-interactive: bundle ID")
  .option("--app-dir <path>", "Non-interactive: path to app source code")
  .option("--platform <platform>", "Non-interactive: ios, android, or both")
  .option("--yes", "Non-interactive mode — use defaults and flags only", false)
  .action(async (opts) => {
    await runInit({
      bundleId: opts.app,
      appDir: opts.appDir ? resolve(opts.appDir) : undefined,
      platform: opts.platform,
      nonInteractive: opts.yes,
    });
  });

// Separate subcommand for adding Jira to an existing config without
// re-running the full init flow. Five lines of prompts, writes back.
program
  .command("jira")
  .description("Manage Jira integration for this project")
  .addCommand(
    new Command("setup")
      .description("Interactively add or update the Jira config block")
      .action(async () => {
        await runJiraSetup();
      }),
  );

program
  .command("suite <path>")
  .description("Run a suite of tests from a YAML file or directory")
  .option("--platform <platform>", "Target platform: ios, android, or web", "ios")
  .option("--url <url>", "Base URL for web tests (overrides test app field)")
  .option("--device <name>", "Device/simulator/AVD name")
  .option("--model <model>", "LLM model to use", DEFAULTS.model)
  .option("--step-delay <ms>", "Delay between steps in ms", String(DEFAULTS.stepDelay))
  .option("--parallel <n>", "Run N tests in parallel (web only)", "1")
  .option("--notify-slack <url>", "Post results to Slack incoming webhook URL")
  .option("--notify-webhook <url>", "POST results JSON to any webhook URL")
  .option("--verbose", "Enable verbose logging", false)
  .option("--ci", "CI mode: no auto-open, exit code reflects pass/fail", false)
  .action(async (suitePath: string, opts) => {
    const { loadSuite } = await import("./suite/suite.js");

    const suite = loadSuite(suitePath);
    console.log(`Loaded ${suite.tests.length} test(s) from ${suite.sourcePath}\n`);

    if (suite.tests.length === 0) {
      console.log("No tests to run.");
      return;
    }

    // License check — one slot per suite run, not per test
    const usage = checkAndConsumeUsage();
    if (!usage.allowed) {
      console.error(`Free tier limit reached: ${usage.used}/${usage.limit} runs used today.`);
      console.error(`Resets at ${usage.resetAt}.`);
      process.exit(2);
    }

    const platform = (opts.platform as Platform) ?? "ios";
    const stepDelay = parseInt(opts.stepDelay, 10);
    const parallel = Math.max(1, parseInt(opts.parallel, 10) || 1);

    if (platform === "web") {
      await runWebSuite(suite, opts, platform, stepDelay, parallel);
    } else {
      await runMobileSuite(suite, opts, platform, stepDelay);
    }
  });

program
  .command("dashboard")
  .description("Generate a static HTML dashboard indexing all reports")
  .option("--dir <path>", "Reports directory", DEFAULTS.reportDir)
  .option("--out <path>", "Output HTML file path")
  .action(async (opts) => {
    const { generateDashboard } = await import("./reporter/dashboard.js");
    const dest = generateDashboard(opts.dir, opts.out ? resolve(opts.out) : undefined);
    console.log(`Dashboard generated: ${dest}`);
    if (!opts.out) {
      const { exec: execCb } = await import("node:child_process");
      execCb(`open "${dest}"`);
      console.log("Opened in browser.");
    }
  });

program
  .command("baseline <report-dir>")
  .description("Save screenshots from a report as the visual regression baseline")
  .option("--name <name>", "Baseline name (default: derived from report dir)")
  .action(async (reportDir: string, opts) => {
    const { existsSync } = await import("node:fs");
    const screenshotDir = resolve(reportDir, "screenshots");
    if (!existsSync(screenshotDir)) {
      console.error(`No screenshots found in ${screenshotDir}`);
      process.exit(2);
    }
    const { saveBaseline } = await import("./visual/diff.js");
    const name = opts.name ?? reportDir.split("/").pop() ?? "default";
    const dest = saveBaseline(screenshotDir, name);
    const { readdirSync } = await import("node:fs");
    const count = readdirSync(dest).filter((f: string) => f.endsWith(".png")).length;
    console.log(`Saved ${count} screenshots as baseline "${name}"`);
    console.log(`Location: ${dest}`);
  });

program
  .command("visual-diff")
  .description("Compare current screenshots against a saved baseline")
  .requiredOption("--baseline <dir>", "Path to baseline screenshots directory")
  .requiredOption("--current <dir>", "Path to current run's screenshots directory")
  .option("--threshold <pct>", "Max allowed pixel diff percentage (default: 0.5)", "0.5")
  .option("--out <dir>", "Output directory for diff images")
  .option("--ci", "Exit with code 1 if any visual regressions found", false)
  .action(async (opts) => {
    const { compareScreenshots, printDiffReport } = await import("./visual/diff.js");
    const threshold = parseFloat(opts.threshold) / 100;
    const outDir = opts.out ? resolve(opts.out) : resolve(opts.current, "../visual-diffs");
    const report = await compareScreenshots(
      resolve(opts.baseline),
      resolve(opts.current),
      outDir,
      threshold,
    );
    printDiffReport(report);
    if (opts.ci && report.failed > 0) {
      process.exit(1);
    }
  });

program
  .command("extract")
  .description("Extract replayable test definitions from an explore session report")
  .requiredOption("--from <path>", "Path to report.json from a previous run")
  .option("--model <model>", "LLM model for smarter extraction (optional — omit for free mechanical extraction)")
  .option("--out <dir>", "Output directory for generated test files")
  .action(async (opts) => {
    const { existsSync } = await import("node:fs");
    const reportPath = resolve(opts.from);
    if (!existsSync(reportPath)) {
      console.error(`Report not found: ${reportPath}`);
      process.exit(2);
    }

    const { extractTests } = await import("./extract/extract.js");

    let model: import("ai").LanguageModel | undefined;
    if (opts.model) {
      const { resolveModel } = await import("./config/defaults.js");
      const { provider, modelId } = resolveModel(opts.model);
      // Dynamic import of the right provider
      switch (provider) {
        case "openai": {
          const { createOpenAI } = await import("@ai-sdk/openai");
          model = createOpenAI()(modelId);
          break;
        }
        case "google": {
          const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
          model = createGoogleGenerativeAI()(modelId);
          break;
        }
        case "anthropic":
        default: {
          const { createAnthropic } = await import("@ai-sdk/anthropic");
          model = createAnthropic()(modelId);
          break;
        }
      }
    }

    console.log(`Extracting tests from: ${reportPath}`);
    if (model) {
      console.log(`Using LLM: ${opts.model}`);
    } else {
      console.log("Using mechanical extraction (pass --model for smarter results)");
    }
    console.log("");

    const result = await extractTests(reportPath, {
      model,
      outDir: opts.out ? resolve(opts.out) : undefined,
    });

    if (result.tests.length === 0) {
      console.log("No meaningful test flows found in this session.");
      return;
    }

    console.log(`Extracted ${result.tests.length} test(s):\n`);
    for (const test of result.tests) {
      console.log(`  ${test.name}`);
      console.log(`    Goal: ${test.goal}`);
      if (test.assertions.length > 0) {
        console.log(`    Assert: ${test.assertions.join(", ")}`);
      }
      console.log("");
    }

    if (result.yamlPath) {
      console.log(`Saved to: ${result.yamlPath}`);
      console.log(`\nReplay with: appcrawl suite ${result.yamlPath}`);
    }
  });

const license = program
  .command("license")
  .description("Manage your AppCrawl license key");

license
  .command("show")
  .description("Show current license status")
  .action(() => {
    const status = getLicenseStatus();
    if (status.tier === "pro") {
      console.log(`Tier:    Pro`);
      console.log(`Email:   ${status.email}`);
      console.log(`Expires: ${status.expiresAt?.toISOString().slice(0, 10)}`);
      console.log(`Source:  ${status.source === "env" ? "APPCRAWL_LICENSE env var" : "~/.appcrawl/license"}`);
    } else {
      console.log(`Tier:    Free (${5} runs/day)`);
      if (status.reason) {
        console.log(`Note:    License found but invalid — ${status.reason}`);
      }
      console.log(`\nUpgrade to Pro: https://appcrawl.dev/buy`);
    }
  });

license
  .command("set <key>")
  .description("Save a license key to ~/.appcrawl/license")
  .action((key: string) => {
    try {
      const status = saveLicense(key);
      console.log(`License saved.`);
      console.log(`  Email:   ${status.email}`);
      console.log(`  Expires: ${status.expiresAt?.toISOString().slice(0, 10)}`);
    } catch (e: unknown) {
      console.error(`Failed to save license: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  });

program
  .command("doctor")
  .description("Check that all prerequisites are installed and configured")
  .action(async () => {
    console.log("Checking prerequisites...\n");

    // Check Maestro
    const maestro = await checkMaestroInstalled();
    console.log(
      maestro.installed
        ? "[OK] Maestro"
        : `[MISSING] Maestro\n${maestro.message}`,
    );

    const { execSync } = await import("node:child_process");

    // iOS: simctl for simulator + xcrun presence
    try {
      execSync("xcrun simctl help", { encoding: "utf-8", stdio: "pipe" });
      const output = execSync("xcrun simctl list devices booted", {
        encoding: "utf-8",
      });
      const hasBooted = output
        .split("\n")
        .some((l) => l.includes("(Booted)"));
      if (hasBooted) {
        const match = output.match(/\s+(.+?)\s+\(([A-F0-9-]+)\)\s+\(Booted\)/);
        console.log(
          match
            ? `[OK] iOS Simulator: ${match[1]}`
            : "[OK] iOS Simulator is booted",
        );
      } else {
        console.log("[  ] iOS Simulator: none booted (appcrawl will auto-boot one)");
      }
    } catch {
      console.log("[  ] iOS / Xcode not installed (skip if targeting Android)");
    }

    // Android: adb + connected devices
    try {
      const output = execSync("adb devices", { encoding: "utf-8", stdio: "pipe" });
      const connected = output
        .split("\n")
        .slice(1)
        .filter((l) => /\s+device\s*$/.test(l));
      if (connected.length > 0) {
        console.log(`[OK] Android: ${connected.length} device(s) connected`);
      } else {
        // Check for AVDs available to auto-boot
        try {
          const avds = execSync("emulator -list-avds", { encoding: "utf-8", stdio: "pipe" })
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          if (avds.length > 0) {
            console.log(`[  ] Android: no device connected, ${avds.length} AVD(s) available (appcrawl will auto-boot)`);
          } else {
            console.log("[  ] Android: no devices and no AVDs (create one in Android Studio)");
          }
        } catch {
          console.log("[  ] Android: adb found but emulator CLI missing");
        }
      }
    } catch {
      console.log("[  ] Android: adb not installed (skip if targeting iOS)");
    }

    // Check API keys / providers
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    console.log(hasAnthropic ? "[OK] ANTHROPIC_API_KEY" : "[  ] ANTHROPIC_API_KEY");
    console.log(hasOpenAI ? "[OK] OPENAI_API_KEY" : "[  ] OPENAI_API_KEY");
    console.log(hasGoogle ? "[OK] GOOGLE_GENERATIVE_AI_API_KEY" : "[  ] GOOGLE_GENERATIVE_AI_API_KEY");
    console.log(hasOpenRouter ? "[OK] OPENROUTER_API_KEY" : "[  ] OPENROUTER_API_KEY");

    // Check Ollama
    try {
      const { execSync } = await import("node:child_process");
      execSync("ollama list", { timeout: 5_000, encoding: "utf-8" });
      console.log("[OK] Ollama (local models — free, no API key needed)");
    } catch {
      console.log("[  ] Ollama (not running — optional, for local models)");
    }

    // License status
    const licStatus = getLicenseStatus();
    if (licStatus.tier === "pro") {
      console.log(`[OK] License: Pro (expires ${licStatus.expiresAt?.toISOString().slice(0, 10)})`);
    } else {
      console.log(`[  ] License: Free tier (5 runs/day) — appcrawl license set <key>`);
    }

    if (!hasAnthropic && !hasOpenAI && !hasGoogle && !hasOpenRouter) {
      console.log("\nYou need at least one provider. Options:");
      console.log("  - GOOGLE_GENERATIVE_AI_API_KEY  (free at aistudio.google.com)");
      console.log("  - OPENROUTER_API_KEY            (free tier at openrouter.ai)");
      console.log("  - ollama                        (free, local — ollama.com)");
      console.log("  - ANTHROPIC_API_KEY             (paid API credits)");
      console.log("  - OPENAI_API_KEY                (paid API credits)");
    }

    console.log("\nUsage examples:");
    console.log("  appcrawl explore --app com.example.app --model gemini-2.0-flash");
    console.log("  appcrawl explore --app com.example.app --model openrouter:anthropic/claude-sonnet-4");
    console.log("  appcrawl explore --app com.example.app --model ollama:llava");
    console.log("\nDone.");
  });

type SuiteResult = { name: string; status: "pass" | "fail" | "error"; reason: string };

async function runSingleTest(
  test: import("./suite/suite.js").SuiteTest,
  testNum: number,
  totalTests: number,
  driver: import("./driver/types.js").DeviceDriver,
  opts: { model: string; verbose: boolean; stepDelay: number; systemPrompt?: string },
): Promise<SuiteResult> {
  const bundleId = test.app;
  if (!bundleId) {
    return { name: test.name, status: "error", reason: "No app bundle ID / URL" };
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  TEST ${testNum}/${totalTests}: ${test.name}`);
  console.log(`  App: ${bundleId}`);
  console.log(`  Goal: ${test.goal}`);
  console.log(`${"=".repeat(60)}\n`);

  let instruction = test.goal;
  if (test.assertions.length > 0) {
    instruction += `. Then verify: ${test.assertions.map((a) => `"${a}" is visible`).join(", ")}`;
  }

  const maxSteps = test.maxSteps ?? DEFAULTS.steeredMaxSteps;
  const reportDir = resolve(DEFAULTS.reportDir);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(reportDir, `suite-${runId}-test-${testNum}`);
  const screenshotDir = resolve(runDir, "screenshots");

  try {
    const result = await runAgentLoop({
      driver,
      bundleId,
      mode: "steered",
      instruction,
      maxSteps,
      stepDelay: opts.stepDelay,
      model: opts.model,
      verbose: opts.verbose,
      screenshotDir,
      systemPrompt: opts.systemPrompt,
    });

    printConsoleSummary(result.state, "steered");
    await generateReport(result.state, {
      mode: "steered",
      instruction,
      bundleId,
      model: opts.model,
      runDir,
    });

    const status = result.state.testResult?.status ?? "fail";
    const reason = result.state.testResult?.reason ?? "Did not complete";
    return { name: test.name, status, reason };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: test.name, status: "error", reason: msg };
  }
}

async function printSuiteResults(
  results: SuiteResult[],
  ci: boolean,
  notify?: { slackUrl?: string; webhookUrl?: string; model?: string; platform?: string },
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  SUITE RESULTS");
  console.log(`${"=".repeat(60)}`);
  for (const r of results) {
    const icon = r.status === "pass" ? "[PASS]" : r.status === "fail" ? "[FAIL]" : "[ERR] ";
    console.log(`  ${icon} ${r.name}`);
    if (r.status !== "pass") {
      console.log(`         ${r.reason}`);
    }
  }
  const passed = results.filter((r) => r.status === "pass").length;
  const hasFailure = results.some((r) => r.status !== "pass");
  console.log(`\n  ${passed}/${results.length} passed`);
  console.log(`${"=".repeat(60)}`);

  // Send notifications
  if (notify?.slackUrl || notify?.webhookUrl) {
    const { notifySlack, notifyWebhook } = await import("./notify/notify.js");
    const payload = {
      suiteResults: results,
      passed,
      failed: results.length - passed,
      total: results.length,
      model: notify.model,
      platform: notify.platform,
    };

    if (notify.slackUrl) {
      try {
        await notifySlack(notify.slackUrl, payload);
        console.log("Slack notification sent.");
      } catch (e: unknown) {
        console.error(`Slack notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (notify.webhookUrl) {
      try {
        await notifyWebhook(notify.webhookUrl, payload);
        console.log("Webhook notification sent.");
      } catch (e: unknown) {
        console.error(`Webhook notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (ci && hasFailure) {
    process.exit(1);
  }
}

async function runMobileSuite(
  suite: import("./suite/suite.js").Suite,
  opts: { device?: string; model: string; stepDelay: string; verbose: boolean; ci?: boolean; notifySlack?: string; notifyWebhook?: string },
  platform: Platform,
  stepDelay: number,
): Promise<void> {
  const maestro = await checkMaestroInstalled();
  if (!maestro.installed) {
    console.error(maestro.message);
    process.exit(2);
  }

  const firstBundleId = suite.tests.find((t) => t.app)?.app ?? "";
  const { deviceId } = await ensureDevice({
    platform,
    deviceName: opts.device,
    bundleId: firstBundleId,
    verbose: opts.verbose,
  });

  const driver = new MaestroDriver({ platform, deviceId });
  console.log("Connecting to Maestro MCP...");
  await driver.connect();
  console.log("Connected.\n");

  const results: SuiteResult[] = [];
  for (let i = 0; i < suite.tests.length; i++) {
    const r = await runSingleTest(
      suite.tests[i], i + 1, suite.tests.length, driver,
      { model: opts.model, verbose: opts.verbose, stepDelay },
    );
    results.push(r);
  }

  await driver.cleanup();
  await printSuiteResults(results, opts.ci ?? false, {
    slackUrl: opts.notifySlack, webhookUrl: opts.notifyWebhook,
    model: opts.model, platform: platform as string,
  });
}

async function runWebSuite(
  suite: import("./suite/suite.js").Suite,
  opts: { url?: string; model: string; stepDelay: string; verbose: boolean; ci?: boolean; notifySlack?: string; notifyWebhook?: string },
  _platform: Platform,
  stepDelay: number,
  parallel: number,
): Promise<void> {
  const { PlaywrightDriver } = await import("./driver/playwright.js");
  const { steeredWebPrompt } = await import("./agent/prompts.js");

  if (parallel <= 1) {
    // Sequential — single browser
    const driver = new PlaywrightDriver({ headless: opts.ci ?? false });
    console.log("Launching browser...");
    await driver.connect();
    console.log("Browser ready.\n");

    const results: SuiteResult[] = [];
    for (let i = 0; i < suite.tests.length; i++) {
      const test = suite.tests[i];
      if (opts.url) test.app = opts.url;
      const prompt = steeredWebPrompt(test.goal);
      const r = await runSingleTest(
        test, i + 1, suite.tests.length, driver,
        { model: opts.model, verbose: opts.verbose, stepDelay, systemPrompt: prompt },
      );
      results.push(r);
    }

    await driver.cleanup();
    await printSuiteResults(results, opts.ci ?? false, {
      slackUrl: opts.notifySlack, webhookUrl: opts.notifyWebhook,
      model: opts.model, platform: "web",
    });
  } else {
    // Parallel — multiple browser instances
    console.log(`Running ${suite.tests.length} tests with ${parallel} parallel workers\n`);

    const results: SuiteResult[] = new Array(suite.tests.length);
    let nextIndex = 0;

    const worker = async (workerId: number): Promise<void> => {
      const driver = new PlaywrightDriver({ headless: opts.ci ?? false });
      await driver.connect();

      while (nextIndex < suite.tests.length) {
        const idx = nextIndex++;
        const test = suite.tests[idx];
        if (opts.url) test.app = opts.url;
        const prompt = steeredWebPrompt(test.goal);

        console.log(`[Worker ${workerId}] Starting: ${test.name}`);
        const r = await runSingleTest(
          test, idx + 1, suite.tests.length, driver,
          { model: opts.model, verbose: opts.verbose, stepDelay, systemPrompt: prompt },
        );
        results[idx] = r;
        console.log(`[Worker ${workerId}] ${r.status.toUpperCase()}: ${test.name}`);
      }

      await driver.cleanup();
    };

    const workers = Array.from(
      { length: Math.min(parallel, suite.tests.length) },
      (_, i) => worker(i + 1),
    );
    await Promise.all(workers);

    await printSuiteResults(results, opts.ci ?? false, {
      slackUrl: opts.notifySlack, webhookUrl: opts.notifyWebhook,
      model: opts.model, platform: "web",
    });
  }
}

async function runCommand(
  mode: "explore" | "steered",
  opts: {
    app?: string;
    url?: string;
    appDir?: string;
    platform?: string;
    device?: string;
    install?: string;
    maxSteps: string;
    stepDelay: string;
    model: string;
    verbose: boolean;
    ci?: boolean;
  },
  instruction?: string,
): Promise<void> {
  const maxSteps = parseInt(opts.maxSteps, 10);
  if (isNaN(maxSteps) || maxSteps < 1) {
    console.error("--max-steps must be a positive number");
    process.exit(2);
  }

  const stepDelay = parseInt(opts.stepDelay, 10);
  if (isNaN(stepDelay) || stepDelay < 0) {
    console.error("--step-delay must be a non-negative number (ms)");
    process.exit(2);
  }

  // License / usage gate (consumes one free-tier slot on success)
  const usage = checkAndConsumeUsage();
  if (!usage.allowed) {
    console.error(
      `Free tier limit reached: ${usage.used}/${usage.limit} runs used today.`,
    );
    console.error(`Resets at ${usage.resetAt}.`);
    console.error(`\nUpgrade to Pro for unlimited runs: https://appcrawl.dev/buy`);
    process.exit(2);
  }
  if (usage.tier === "free") {
    console.log(`[free tier] ${usage.used}/${usage.limit} runs used today`);
  }

  // Decide the target platform
  let platform: Platform;
  if (opts.platform) {
    const p = opts.platform.toLowerCase();
    if (p !== "ios" && p !== "android" && p !== "web") {
      console.error(`--platform must be "ios", "android", or "web", got "${p}"`);
      process.exit(2);
    }
    platform = p as Platform;
  } else if (opts.url) {
    // --url implies web platform
    platform = "web";
  } else {
    // Mobile platform resolution
    const appDir = opts.appDir ? resolve(opts.appDir) : undefined;
    const peek = loadAppContext(opts.app, appDir);
    if (peek.platform) {
      platform = peek.platform;
    } else if (peek.declaredPlatforms.length === 1) {
      platform = peek.declaredPlatforms[0];
    } else if (peek.declaredPlatforms.length === 2) {
      console.error(
        "Both 'ios' and 'android' blocks found in appcrawl.config.json — pass --platform ios or --platform android to choose one.",
      );
      process.exit(2);
    } else {
      platform = "ios";
    }
  }

  // ---- Web platform path ----
  if (platform === "web") {
    await runWebCommand(mode, opts, maxSteps, stepDelay, instruction);
    return;
  }

  // ---- Mobile platform path ----
  // Validate prerequisites first — don't burn a free-tier slot on a broken setup.
  const maestro = await checkMaestroInstalled();
  if (!maestro.installed) {
    console.error(maestro.message);
    process.exit(2);
  }

  const appDir = opts.appDir ? resolve(opts.appDir) : undefined;
  const ctx = loadAppContext(opts.app, appDir, platform);
  const appContext = contextToPrompt(ctx);

  if (ctx.screens.length > 0 || ctx.testIds.length > 0) {
    console.log(`App context: ${ctx.screens.length} screens, ${ctx.testIds.length} testIDs loaded`);
  }

  const deviceName = opts.device ?? ctx.deviceName;
  const installPath = opts.install ?? ctx.installPath;
  const bundleId = ctx.bundleId;
  if (!bundleId) {
    console.error(
      `No bundle id found. Pass --app <bundleId>, or add \"${platform}\": { \"bundleId\": \"...\" } to appcrawl.config.json.`,
    );
    process.exit(2);
  }

  let deviceId: string;
  let deviceLabel: string;
  try {
    const device = await ensureDevice({
      platform,
      deviceName,
      installPath: installPath ? resolve(installPath) : undefined,
      bundleId,
      verbose: opts.verbose,
    });
    deviceId = device.deviceId;
    deviceLabel = `${device.deviceName}${device.bootedByUs ? " (booted by appcrawl)" : ""}`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Device setup failed: ${msg}`);
    process.exit(2);
  }

  if (ctx.setup.length > 0) {
    console.log(`Running ${ctx.setup.length} setup hook(s)...`);
    const { execSync } = await import("node:child_process");
    for (const cmd of ctx.setup) {
      try {
        execSync(cmd, { encoding: "utf-8", timeout: 30_000, stdio: "pipe" });
        console.log(`  [OK] ${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  [WARN] Setup hook failed: ${msg.split("\n")[0]}`);
      }
    }
  }

  const reportDir = resolve(DEFAULTS.reportDir);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(reportDir, runId);
  const screenshotDir = resolve(runDir, "screenshots");

  const driver = new MaestroDriver({ platform, deviceId });

  console.log(`\nAppCrawl v0.1.0`);
  console.log(`Mode:       ${mode}`);
  console.log(`Platform:   ${platform}`);
  console.log(`Device:     ${deviceLabel}`);
  console.log(`App:        ${bundleId}`);
  console.log(`Model:      ${opts.model}`);
  console.log(`Max steps:  ${maxSteps}`);
  console.log(`Step delay: ${stepDelay}ms`);
  if (instruction) {
    console.log(`Goal:       ${instruction}`);
  }
  console.log("");

  try {
    console.log("Connecting to Maestro MCP...");
    await driver.connect();
    console.log("Connected.\n");

    const result = await runAgentLoop({
      driver,
      bundleId,
      mode,
      instruction,
      maxSteps,
      stepDelay,
      model: opts.model,
      verbose: opts.verbose,
      screenshotDir,
      appContext,
    });

    printConsoleSummary(result.state, mode);

    const { jsonPath, htmlPath, junitPath } = await generateReport(result.state, {
      mode,
      instruction: instruction ?? null,
      bundleId,
      model: opts.model,
      runDir,
      jira: ctx.jira,
    });

    console.log(`Reports saved:`);
    console.log(`  JSON:  ${jsonPath}`);
    console.log(`  HTML:  ${htmlPath}`);
    console.log(`  JUnit: ${junitPath}`);

    if (!opts.ci) {
      const { exec: execCb } = await import("node:child_process");
      execCb(`open "${htmlPath}"`);
      console.log("\nReport opened in browser.");
    }

    await driver.cleanup();

    if (opts.ci) {
      const code = computeExitCode(result.state);
      process.exit(code);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nFatal error: ${msg}`);
    await driver.cleanup();
    process.exit(2);
  }
}

async function runWebCommand(
  mode: "explore" | "steered",
  opts: {
    app?: string;
    url?: string;
    model: string;
    verbose: boolean;
    ci?: boolean;
  },
  maxSteps: number,
  stepDelay: number,
  instruction?: string,
): Promise<void> {
  const url = opts.url ?? opts.app;
  if (!url) {
    console.error("Web platform requires --url <url> or --app <url>");
    process.exit(2);
  }

  const { PlaywrightDriver } = await import("./driver/playwright.js");
  const { exploreWebPrompt, steeredWebPrompt } = await import("./agent/prompts.js");

  const reportDir = resolve(DEFAULTS.reportDir);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(reportDir, runId);
  const screenshotDir = resolve(runDir, "screenshots");

  const driver = new PlaywrightDriver({ headless: opts.ci ?? false });

  const webSystemPrompt =
    mode === "explore"
      ? exploreWebPrompt()
      : steeredWebPrompt(instruction ?? "Explore the web app");

  console.log(`\nAppCrawl v0.1.0`);
  console.log(`Mode:       ${mode}`);
  console.log(`Platform:   web`);
  console.log(`URL:        ${url}`);
  console.log(`Model:      ${opts.model}`);
  console.log(`Max steps:  ${maxSteps}`);
  console.log(`Step delay: ${stepDelay}ms`);
  if (instruction) {
    console.log(`Goal:       ${instruction}`);
  }
  console.log("");

  try {
    console.log("Launching browser...");
    await driver.connect();
    console.log("Browser ready.\n");

    const result = await runAgentLoop({
      driver,
      bundleId: url,
      mode,
      instruction,
      maxSteps,
      stepDelay,
      model: opts.model,
      verbose: opts.verbose,
      screenshotDir,
      systemPrompt: webSystemPrompt,
    });

    printConsoleSummary(result.state, mode);

    const { jsonPath, htmlPath, junitPath } = await generateReport(result.state, {
      mode,
      instruction: instruction ?? null,
      bundleId: url,
      model: opts.model,
      runDir,
    });

    console.log(`Reports saved:`);
    console.log(`  JSON:  ${jsonPath}`);
    console.log(`  HTML:  ${htmlPath}`);
    console.log(`  JUnit: ${junitPath}`);

    if (!opts.ci) {
      const { exec: execCb } = await import("node:child_process");
      execCb(`open "${htmlPath}"`);
      console.log("\nReport opened in browser.");
    }

    await driver.cleanup();

    if (opts.ci) {
      const code = computeExitCode(result.state);
      process.exit(code);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\nFatal error: ${msg}`);
    await driver.cleanup();
    process.exit(2);
  }
}

program.parse();
