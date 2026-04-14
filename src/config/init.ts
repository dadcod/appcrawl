import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  intro,
  outro,
  text,
  select,
  confirm,
  isCancel,
  cancel,
  note,
  log,
} from "@clack/prompts";
import { loadAppContext, serializeConfig, type ConfigDraft } from "./context.js";

const CONFIG_FILENAME = "appcrawl.config.json";

interface InitOptions {
  bundleId?: string;
  appDir?: string;
  platform?: string;
  nonInteractive: boolean;
}

/**
 * `appcrawl init` entry point.
 *
 * Two modes:
 *   - Interactive (default): Q&A with @clack/prompts. Walks the user
 *     through platform(s), app source, LLM provider hint, Jira, and
 *     per-platform bundleId / install path / device.
 *   - Non-interactive (--yes): uses flags + source-code discovery to
 *     dump a template, same behavior as before. Keeps CI / scripted
 *     setups working.
 */
export async function runInit(opts: InitOptions): Promise<void> {
  if (opts.nonInteractive) {
    await runNonInteractive(opts);
    return;
  }
  await runInteractive(opts);
}

async function runNonInteractive(opts: InitOptions): Promise<void> {
  if (!opts.bundleId) {
    console.error("--app <bundleId> is required with --yes");
    process.exit(2);
  }
  const ctx = loadAppContext(
    opts.bundleId,
    opts.appDir ? resolve(opts.appDir) : undefined,
  );
  // Delegate to the legacy template-generator for the --yes path. It
  // emits the flat shape the user can hand-edit; the new platform
  // blocks are only added via the interactive flow below.
  const { generateConfigTemplate } = await import("./context.js");
  const config = generateConfigTemplate(ctx);
  writeFileSync(CONFIG_FILENAME, config);
  console.log(`Generated ${CONFIG_FILENAME}`);
  console.log(
    `  Discovered ${ctx.screens.length} screens, ${ctx.testIds.length} testIDs`,
  );
}

async function runInteractive(opts: InitOptions): Promise<void> {
  intro("appcrawl init");

  // Refuse to clobber an existing file without explicit permission.
  // Users who want a fresh config can delete it first.
  if (existsSync(CONFIG_FILENAME)) {
    const overwrite = await confirm({
      message: `${CONFIG_FILENAME} already exists. Overwrite?`,
      initialValue: false,
    });
    if (isCancel(overwrite) || !overwrite) {
      cancel("Aborted — existing config kept.");
      process.exit(0);
    }
  }

  // ---- Platform selection ----
  const platformChoice = await select({
    message: "Which platforms will you test?",
    options: [
      { value: "ios", label: "iOS only" },
      { value: "android", label: "Android only" },
      { value: "both", label: "Both iOS and Android" },
    ],
    initialValue: opts.platform === "both" ? "both" : opts.platform ?? "ios",
  });
  if (isCancel(platformChoice)) return bail();

  const doIos = platformChoice === "ios" || platformChoice === "both";
  const doAndroid =
    platformChoice === "android" || platformChoice === "both";

  // ---- Shared: app source dir (drives screen/testID discovery) ----
  const appDirAnswer = await text({
    message:
      "Path to your app source (optional — used to auto-discover screens and testIDs)",
    placeholder: "./mobile",
    initialValue: opts.appDir ?? "",
  });
  if (isCancel(appDirAnswer)) return bail();
  const appDir = appDirAnswer.trim() ? resolve(appDirAnswer.trim()) : undefined;

  // Pre-load discovery so we can show the count immediately and reuse
  // the screen/testID lists in the final config.
  let discoveredScreens: Array<{ name: string; description: string }> = [];
  let discoveredTestIds: string[] = [];
  let discoveredName: string | undefined;
  if (appDir) {
    const ctx = loadAppContext(opts.bundleId ?? "", appDir);
    discoveredScreens = ctx.screens;
    discoveredTestIds = ctx.testIds;
    discoveredName = ctx.name && ctx.name !== opts.bundleId ? ctx.name : undefined;
    if (discoveredScreens.length > 0 || discoveredTestIds.length > 0) {
      log.info(
        `Discovered ${discoveredScreens.length} screens, ${discoveredTestIds.length} testIDs from ${appDir}`,
      );
    }
  }

  // ---- Per-platform blocks ----
  const draft: ConfigDraft = {};
  if (discoveredName) draft.name = discoveredName;
  if (discoveredScreens.length > 0) draft.screens = discoveredScreens;
  if (discoveredTestIds.length > 0) draft.testIds = discoveredTestIds;

  if (doIos) {
    const bundleId = await text({
      message: "iOS — bundle ID",
      placeholder: "com.example.app",
      initialValue: opts.bundleId ?? "",
      validate: (v) => (v && v.trim() ? undefined : "Required"),
    });
    if (isCancel(bundleId)) return bail();

    const install = await text({
      message: "iOS — path to .app bundle (optional)",
      placeholder: "build/Build/Products/Debug-iphonesimulator/YourApp.app",
      initialValue: "",
    });
    if (isCancel(install)) return bail();

    const device = await text({
      message: "iOS — simulator name (optional, default: first available)",
      placeholder: "iPhone 15",
      initialValue: "",
    });
    if (isCancel(device)) return bail();

    draft.ios = {
      bundleId: bundleId.trim(),
      install: install.trim() || undefined,
      device: device.trim() || undefined,
    };
  }

  if (doAndroid) {
    const bundleId = await text({
      message: "Android — application ID",
      placeholder: "com.example.app.debug",
      initialValue: opts.bundleId ?? "",
      validate: (v) => (v && v.trim() ? undefined : "Required"),
    });
    if (isCancel(bundleId)) return bail();

    const install = await text({
      message: "Android — path to .apk (optional)",
      placeholder: "app/build/outputs/apk/debug/app-debug.apk",
      initialValue: "",
    });
    if (isCancel(install)) return bail();

    const device = await text({
      message: "Android — AVD name (optional, default: first available)",
      placeholder: "Pixel_6_API_34",
      initialValue: "",
    });
    if (isCancel(device)) return bail();

    draft.android = {
      bundleId: bundleId.trim(),
      install: install.trim() || undefined,
      device: device.trim() || undefined,
    };
  }

  // ---- Jira (optional) ----
  const wantsJira = await confirm({
    message: "Add Jira integration? (adds 'Create Jira issue' button to reports)",
    initialValue: false,
  });
  if (isCancel(wantsJira)) return bail();
  if (wantsJira) {
    const jira = await promptJira();
    if (!jira) return bail();
    draft.jira = jira;
  }

  // ---- Write ----
  writeFileSync(CONFIG_FILENAME, serializeConfig(draft));

  const parts: string[] = [];
  if (doIos) parts.push("iOS");
  if (doAndroid) parts.push("Android");
  note(
    [
      `Wrote ${CONFIG_FILENAME} (${parts.join(" + ")})`,
      "",
      "Next steps:",
      "  appcrawl doctor        # verify prerequisites",
      doIos && doAndroid
        ? "  appcrawl explore --platform ios    # or --platform android"
        : "  appcrawl explore       # run the AI tester",
    ]
      .filter(Boolean)
      .join("\n"),
    "Config ready",
  );
  outro("Done.");
}

/**
 * Add or update only the Jira block of an existing config. Lets users
 * who already ran init adopt Jira later without re-answering the whole
 * questionnaire.
 */
export async function runJiraSetup(): Promise<void> {
  intro("appcrawl jira setup");

  if (!existsSync(CONFIG_FILENAME)) {
    cancel(`No ${CONFIG_FILENAME} found. Run 'appcrawl init' first.`);
    process.exit(2);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILENAME, "utf-8"));
  } catch (e) {
    cancel(`${CONFIG_FILENAME} is not valid JSON — aborting.`);
    process.exit(2);
  }

  const jira = await promptJira();
  if (!jira) return bail();

  raw.jira = jira;
  writeFileSync(CONFIG_FILENAME, JSON.stringify(raw, null, 2) + "\n");

  note(
    `Updated ${CONFIG_FILENAME}. Future reports will render a 'Create Jira issue' button pointed at ${jira.url}.`,
    "Jira configured",
  );
  outro("Done.");
}

async function promptJira(): Promise<
  | { url: string; project?: string; issueType?: string }
  | null
> {
  const url = await text({
    message: "Jira base URL",
    placeholder: "https://acme.atlassian.net",
    validate: (v) => {
      const trimmed = (v ?? "").trim();
      if (!trimmed) return "Required";
      if (!/^https?:\/\//.test(trimmed)) return "Must start with http:// or https://";
      return undefined;
    },
  });
  if (isCancel(url)) return null;

  const project = await text({
    message: "Jira project key (e.g. APP, WEB) — leave blank to pick at create time",
    placeholder: "APP",
    initialValue: "",
  });
  if (isCancel(project)) return null;

  const issueType = await text({
    message: "Default issue type",
    placeholder: "Bug",
    initialValue: "Bug",
  });
  if (isCancel(issueType)) return null;

  return {
    url: url.trim().replace(/\/$/, ""),
    project: project.trim() || undefined,
    issueType: issueType.trim() || "Bug",
  };
}

function bail(): void {
  cancel("Aborted.");
  process.exit(0);
}
