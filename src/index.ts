#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { resolve } from "node:path";
import { loadAppContext, contextToPrompt, generateConfigTemplate } from "./config/context.js";

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
import { runAgentLoop } from "./agent/loop.js";
import { generateReport, printConsoleSummary, computeExitCode } from "./reporter/reporter.js";
import { DEFAULTS } from "./config/defaults.js";
import { getLicenseStatus, saveLicense, checkAndConsumeUsage } from "./license/license.js";

const program = new Command();

program
  .name("skirmish")
  .description("AI-powered mobile app testing. Let an LLM explore and test your iOS app.")
  .version("0.1.0");

program
  .command("explore")
  .description("Autonomously explore the app, visiting screens and finding bugs")
  .requiredOption("--app <bundleId>", "App bundle ID (e.g. com.example.app)")
  .option("--app-dir <path>", "Path to app source code for auto-discovery")
  .option("--max-steps <n>", "Maximum exploration steps", String(DEFAULTS.maxSteps))
  .option("--model <model>", "LLM model to use", DEFAULTS.model)
  .option("--verbose", "Enable verbose logging", false)
  .option("--ci", "CI mode: no auto-open, emit junit.xml, exit code reflects pass/fail", false)
  .action(async (opts) => {
    await runCommand("explore", opts);
  });

program
  .command("run <instruction>")
  .description("Run a steered test with a natural language instruction")
  .requiredOption("--app <bundleId>", "App bundle ID (e.g. com.example.app)")
  .option("--app-dir <path>", "Path to app source code for auto-discovery")
  .option("--max-steps <n>", "Maximum steps", String(DEFAULTS.steeredMaxSteps))
  .option("--model <model>", "LLM model to use", DEFAULTS.model)
  .option("--verbose", "Enable verbose logging", false)
  .option("--ci", "CI mode: no auto-open, emit junit.xml, exit code reflects pass/fail", false)
  .action(async (instruction: string, opts) => {
    await runCommand("steered", opts, instruction);
  });

program
  .command("init")
  .description("Scan app source code and generate a skirmish.config.json")
  .requiredOption("--app <bundleId>", "App bundle ID")
  .requiredOption("--app-dir <path>", "Path to app source code")
  .action(async (opts) => {
    const ctx = loadAppContext(opts.app, resolve(opts.appDir));
    const config = generateConfigTemplate(ctx);
    const { writeFileSync } = await import("node:fs");
    writeFileSync("skirmish.config.json", config);
    console.log("Generated skirmish.config.json");
    console.log(`  Discovered ${ctx.screens.length} screens, ${ctx.testIds.length} testIDs`);
    console.log("\nEdit the file to add descriptions, credentials, and notes.");
  });

const license = program
  .command("license")
  .description("Manage your Skirmish license key");

license
  .command("show")
  .description("Show current license status")
  .action(() => {
    const status = getLicenseStatus();
    if (status.tier === "pro") {
      console.log(`Tier:    Pro`);
      console.log(`Email:   ${status.email}`);
      console.log(`Expires: ${status.expiresAt?.toISOString().slice(0, 10)}`);
      console.log(`Source:  ${status.source === "env" ? "SKIRMISH_LICENSE env var" : "~/.skirmish/license"}`);
    } else {
      console.log(`Tier:    Free (${5} runs/day)`);
      if (status.reason) {
        console.log(`Note:    License found but invalid — ${status.reason}`);
      }
      console.log(`\nUpgrade to Pro: https://skirmish.dev/buy`);
    }
  });

license
  .command("set <key>")
  .description("Save a license key to ~/.skirmish/license")
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

    // Check for booted simulator
    if (maestro.installed) {
      try {
        const { execSync } = await import("node:child_process");
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
              ? `[OK] Simulator: ${match[1]} (${match[2]})`
              : "[OK] Simulator is booted",
          );
        } else {
          console.log("[MISSING] No booted simulator. Run: open -a Simulator");
        }
      } catch {
        console.log("[WARN] Could not check simulator status");
      }
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
      console.log(`[  ] License: Free tier (5 runs/day) — skirmish license set <key>`);
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
    console.log("  skirmish explore --app com.example.app --model gemini-2.0-flash");
    console.log("  skirmish explore --app com.example.app --model openrouter:anthropic/claude-sonnet-4");
    console.log("  skirmish explore --app com.example.app --model ollama:llava");
    console.log("\nDone.");
  });

async function runCommand(
  mode: "explore" | "steered",
  opts: {
    app: string;
    appDir?: string;
    maxSteps: string;
    model: string;
    verbose: boolean;
    ci?: boolean;
  },
  instruction?: string,
): Promise<void> {
  // Validate prerequisites first — don't burn a free-tier slot on a
  // broken setup.
  const maestro = await checkMaestroInstalled();
  if (!maestro.installed) {
    console.error(maestro.message);
    // Exit 2 = infrastructure problem (distinct from test failure in CI)
    process.exit(2);
  }

  const maxSteps = parseInt(opts.maxSteps, 10);
  if (isNaN(maxSteps) || maxSteps < 1) {
    console.error("--max-steps must be a positive number");
    process.exit(2);
  }

  // License / usage gate (consumes one free-tier slot on success)
  const usage = checkAndConsumeUsage();
  if (!usage.allowed) {
    console.error(
      `Free tier limit reached: ${usage.used}/${usage.limit} runs used today.`,
    );
    console.error(`Resets at ${usage.resetAt}.`);
    console.error(`\nUpgrade to Pro for unlimited runs: https://skirmish.dev/buy`);
    process.exit(2);
  }
  if (usage.tier === "free") {
    console.log(`[free tier] ${usage.used}/${usage.limit} runs used today`);
  }

  // Load app context
  const appDir = opts.appDir ? resolve(opts.appDir) : undefined;
  const ctx = loadAppContext(opts.app, appDir);
  const appContext = contextToPrompt(ctx);

  if (ctx.screens.length > 0 || ctx.testIds.length > 0) {
    console.log(`App context: ${ctx.screens.length} screens, ${ctx.testIds.length} testIDs loaded`);
  }

  // Run setup hooks
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

  const driver = new MaestroDriver();

  console.log(`\nSkirmish v0.1.0`);
  console.log(`Mode:       ${mode}`);
  console.log(`App:        ${opts.app}`);
  console.log(`Model:      ${opts.model}`);
  console.log(`Max steps:  ${maxSteps}`);
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
      bundleId: opts.app,
      mode,
      instruction,
      maxSteps,
      model: opts.model,
      verbose: opts.verbose,
      screenshotDir,
      appContext,
    });

    printConsoleSummary(result.state, mode);

    const { jsonPath, htmlPath, junitPath } = await generateReport(result.state, {
      mode,
      instruction: instruction ?? null,
      bundleId: opts.app,
      model: opts.model,
      runDir,
    });

    console.log(`Reports saved:`);
    console.log(`  JSON:  ${jsonPath}`);
    console.log(`  HTML:  ${htmlPath}`);
    console.log(`  JUnit: ${junitPath}`);

    if (!opts.ci) {
      // Auto-open HTML report in browser
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
