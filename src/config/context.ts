import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

export interface AppContext {
  name: string;
  bundleId: string;
  description: string;
  screens: ScreenInfo[];
  testIds: string[];
  credentials: { email?: string; password?: string } | null;
  notes: string[];
  setup: string[];
}

interface ScreenInfo {
  name: string;
  description: string;
}

const CONFIG_FILENAME = "skirmish.config.json";

export function loadAppContext(bundleId: string, appDir?: string): AppContext {
  // 1. Try loading manual config
  const configPath = resolve(CONFIG_FILENAME);
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      return {
        name: raw.name ?? bundleId,
        bundleId,
        description: raw.description ?? "",
        screens: raw.screens ?? [],
        testIds: raw.testIds ?? [],
        credentials: raw.credentials ?? null,
        notes: raw.notes ?? [],
        setup: raw.setup ?? [],
      };
    } catch {
      // Invalid config, fall through to auto-discovery
    }
  }

  // 2. Auto-discover from codebase
  if (appDir) {
    return discoverFromCodebase(bundleId, appDir);
  }

  // 3. Minimal context
  return {
    name: bundleId,
    bundleId,
    description: "",
    screens: [],
    testIds: [],
    credentials: null,
    notes: [],
    setup: [],
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

export function generateConfigTemplate(ctx: AppContext): string {
  return JSON.stringify(
    {
      name: ctx.name,
      description: ctx.description || "Describe your app here",
      screens: ctx.screens.length > 0
        ? ctx.screens
        : [{ name: "ExampleScreen", description: "Describe this screen" }],
      testIds: ctx.testIds.length > 0 ? ctx.testIds : ["example-test-id"],
      credentials: { email: "test@example.com", password: "password123" },
      notes: [
        "Add any notes about the app that would help the AI tester",
        "e.g. 'The paywall appears after the 3rd story creation'",
      ],
    },
    null,
    2,
  );
}
