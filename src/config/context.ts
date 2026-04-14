import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Platform } from "../driver/types.js";

/**
 * Runtime config resolved for a single appcrawl run.
 *
 * The file on disk (`appcrawl.config.json`) supports a shared top-level
 * block plus optional `ios` / `android` overrides, but once a run starts
 * we collapse that down to a single AppContext for a specific platform.
 * Resolution order for `bundleId`, `deviceName`, `installPath`, `setup`:
 *   1. CLI flag (handled in index.ts)
 *   2. `config.<platform>.X`
 *   3. `config.X`    (shared fallback)
 *   4. default / undefined
 */
export interface AppContext {
  name: string;
  bundleId: string;
  description: string;
  screens: ScreenInfo[];
  testIds: string[];
  credentials: { email?: string; password?: string } | null;
  notes: string[];
  setup: string[];
  platform?: Platform;
  deviceName?: string;
  installPath?: string;
  jira?: JiraConfig;
  /** Delay between steps in ms. */
  stepDelay?: number;
  /** Which platform blocks the file declares. Used to decide whether
   *  platform is ambiguous when no --platform flag is passed. */
  declaredPlatforms: Platform[];
}

export interface JiraConfig {
  url: string;
  project?: string;
  issueType?: string;
}

interface ScreenInfo {
  name: string;
  description: string;
}

interface PlatformBlock {
  bundleId?: string;
  install?: string;
  device?: string;
  setup?: string[];
}

interface RawConfig {
  name?: string;
  description?: string;
  screens?: ScreenInfo[];
  testIds?: string[];
  credentials?: { email?: string; password?: string } | null;
  notes?: string[];
  setup?: string[];
  platform?: Platform;
  device?: string;
  install?: string;
  jira?: JiraConfig;
  stepDelay?: number;
  ios?: PlatformBlock;
  android?: PlatformBlock;
}

const CONFIG_FILENAME = "appcrawl.config.json";

/**
 * Load config + resolve against a target platform. If `platform` is
 * omitted we return an unresolved context (platform-specific fields
 * left undefined); the caller is responsible for asking the user.
 *
 * `declaredPlatforms` tells the caller which platform blocks exist
 * so it can auto-pick the single one or error loudly on ambiguity.
 */
export function loadAppContext(
  bundleId: string | undefined,
  appDir?: string,
  platform?: Platform,
): AppContext {
  const configPath = resolve(CONFIG_FILENAME);
  if (existsSync(configPath)) {
    try {
      const raw: RawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      // If the caller passed an explicit bundleId via --app, check whether
      // the config file is actually *for* that app. If none of the bundleIds
      // in the config match, skip the file so we don't pollute an unrelated
      // run with irrelevant screens/testIDs/setup hooks.
      if (bundleId && !configMatchesBundleId(raw, bundleId)) {
        // Config exists but is for a different app — ignore it.
      } else {
        return resolveContext(raw, bundleId, platform);
      }
    } catch {
      // Invalid config, fall through to auto-discovery
    }
  }

  if (appDir) {
    return discoverFromCodebase(bundleId ?? "", appDir);
  }

  return emptyContext(bundleId ?? "");
}

/**
 * Check whether a config file is relevant for the given bundleId.
 * When the caller passed an explicit `--app`, we only load the config
 * if it declares a matching bundleId somewhere (platform blocks or name
 * that looks like the same app). Configs with zero declared bundleIds
 * are NOT loaded when an explicit `--app` is given — there's no way
 * to confirm they belong to the same app.
 */
function configMatchesBundleId(raw: RawConfig, bundleId: string): boolean {
  const declared: string[] = [];
  if (raw.ios?.bundleId) declared.push(raw.ios.bundleId);
  if (raw.android?.bundleId) declared.push(raw.android.bundleId);
  return declared.length > 0 && declared.includes(bundleId);
}

function resolveContext(
  raw: RawConfig,
  cliBundleId: string | undefined,
  platform: Platform | undefined,
): AppContext {
  const declared: Platform[] = [];
  if (raw.ios) declared.push("ios");
  if (raw.android) declared.push("android");

  const block: PlatformBlock | undefined = platform
    ? platform === "ios"
      ? raw.ios
      : raw.android
    : undefined;

  // Resolution chain: CLI flag wins (explicit user override) → platform
  // block → empty. If none yield a bundleId, the caller must error.
  const bundleId = cliBundleId ?? block?.bundleId ?? "";
  const deviceName = block?.device ?? raw.device;
  const installPath = block?.install ?? raw.install;
  // Merge setup hooks: shared first, then platform-specific.
  const setup = [...(raw.setup ?? []), ...(block?.setup ?? [])];

  return {
    name: raw.name ?? bundleId,
    bundleId,
    description: raw.description ?? "",
    screens: raw.screens ?? [],
    testIds: raw.testIds ?? [],
    credentials: raw.credentials ?? null,
    notes: raw.notes ?? [],
    setup,
    platform: platform ?? raw.platform,
    deviceName,
    installPath,
    jira: raw.jira,
    stepDelay: raw.stepDelay,
    declaredPlatforms: declared,
  };
}

function emptyContext(bundleId: string): AppContext {
  return {
    name: bundleId,
    bundleId,
    description: "",
    screens: [],
    testIds: [],
    credentials: null,
    notes: [],
    setup: [],
    declaredPlatforms: [],
  };
}

function discoverFromCodebase(bundleId: string, appDir: string): AppContext {
  const screens: ScreenInfo[] = [];
  const testIds: string[] = [];
  let appName = bundleId;
  let description = "";

  // Find navigation types (RootStackParamList)
  const navTypesPath = findFile(appDir, "navigation/types.ts");
  if (navTypesPath) {
    const content = readFileSync(navTypesPath, "utf-8");
    const screenMatches = content.matchAll(/^\s+(\w+)\s*[:{]/gm);
    for (const match of screenMatches) {
      const name = match[1];
      if (name !== "undefined") {
        screens.push({ name, description: "" });
      }
    }
  }

  // Find testIDs by scanning src/
  const srcDir = join(appDir, "src");
  if (existsSync(srcDir)) {
    const testIdSet = new Set<string>();
    scanForTestIds(srcDir, testIdSet);
    testIds.push(...testIdSet);
  }

  // Try to get app name from app.json or app.config.ts
  const appJsonPath = join(appDir, "app.json");
  if (existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(readFileSync(appJsonPath, "utf-8"));
      appName = appJson.expo?.name ?? appJson.name ?? bundleId;
      description = appJson.expo?.description ?? appJson.description ?? "";
    } catch {
      // ignore
    }
  }

  return {
    name: appName,
    bundleId,
    description,
    screens,
    testIds,
    credentials: null,
    notes: [],
    setup: [],
    declaredPlatforms: [],
  };
}

function findFile(baseDir: string, relativePath: string): string | null {
  // Check common locations
  const candidates = [
    join(baseDir, "src", relativePath),
    join(baseDir, relativePath),
    join(baseDir, "app", relativePath),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function scanForTestIds(dir: string, ids: Set<string>): void {
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && entry !== "node_modules" && entry !== ".git") {
          scanForTestIds(fullPath, ids);
        } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
          const content = readFileSync(fullPath, "utf-8");
          const matches = content.matchAll(/testID=["']([^"']+)["']/g);
          for (const match of matches) {
            // Skip dynamic testIDs with template literals
            if (!match[1].includes("$")) {
              ids.add(match[1]);
            }
          }
        }
      } catch {
        // skip inaccessible files
      }
    }
  } catch {
    // skip inaccessible dirs
  }
}

export function contextToPrompt(ctx: AppContext): string {
  const lines: string[] = [];

  lines.push(`## App: ${ctx.name}`);
  if (ctx.description) {
    lines.push(`Description: ${ctx.description}`);
  }
  lines.push(`Bundle ID: ${ctx.bundleId}`);
  lines.push("");

  if (ctx.screens.length > 0) {
    lines.push("## Screens");
    for (const screen of ctx.screens) {
      const desc = screen.description ? ` — ${screen.description}` : "";
      lines.push(`- ${screen.name}${desc}`);
    }
    lines.push("");
  }

  if (ctx.testIds.length > 0) {
    lines.push("## Known Test IDs");
    lines.push("Use these to identify and interact with elements:");
    for (const id of ctx.testIds) {
      lines.push(`- ${id}`);
    }
    lines.push("");
  }

  if (ctx.credentials) {
    lines.push("## Test Credentials");
    if (ctx.credentials.email) lines.push(`Email: ${ctx.credentials.email}`);
    if (ctx.credentials.password) lines.push(`Password: ${ctx.credentials.password}`);
    lines.push("");
  }

  if (ctx.notes.length > 0) {
    lines.push("## Notes");
    for (const note of ctx.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Raw JSON-serializable config shape for writing `appcrawl.config.json`.
 * Kept intentionally narrow — init writes only the fields it was asked
 * about, leaving the rest for the user to add by hand or via follow-up
 * subcommands (`appcrawl jira setup`, etc.).
 */
export interface ConfigDraft {
  name?: string;
  description?: string;
  screens?: ScreenInfo[];
  testIds?: string[];
  credentials?: { email?: string; password?: string };
  notes?: string[];
  jira?: JiraConfig;
  ios?: PlatformBlock;
  android?: PlatformBlock;
}

export function serializeConfig(draft: ConfigDraft): string {
  // Strip undefined keys so the file isn't cluttered with nulls.
  const clean = JSON.parse(JSON.stringify(draft));
  return JSON.stringify(clean, null, 2) + "\n";
}

export function generateConfigTemplate(ctx: AppContext): string {
  const draft: ConfigDraft = {
    name: ctx.name,
    description: ctx.description || "Describe your app here",
    screens:
      ctx.screens.length > 0
        ? ctx.screens
        : [{ name: "ExampleScreen", description: "Describe this screen" }],
    testIds: ctx.testIds.length > 0 ? ctx.testIds : ["example-test-id"],
    credentials: { email: "test@example.com", password: "password123" },
    notes: [
      "Add any notes about the app that would help the AI tester",
      "e.g. 'The paywall appears after the 3rd story creation'",
    ],
  };
  return serializeConfig(draft);
}
