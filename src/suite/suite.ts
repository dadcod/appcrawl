import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * A single test case loaded from a YAML suite file.
 */
export interface SuiteTest {
  name: string;
  app: string;
  goal: string;
  assertions: string[];
  /** Which platform to target (default: inherit from CLI) */
  platform?: "ios" | "android";
  maxSteps?: number;
}

/**
 * A loaded test suite — one or more tests from a YAML file or directory.
 */
export interface Suite {
  tests: SuiteTest[];
  sourcePath: string;
}

interface RawSuiteFile {
  tests?: Array<{
    name?: string;
    app?: string;
    goal?: string;
    assertions?: string[];
    platform?: string;
    maxSteps?: number;
  }>;
  // Single-test shorthand (no `tests:` wrapper)
  name?: string;
  app?: string;
  goal?: string;
  assertions?: string[];
  platform?: string;
  maxSteps?: number;
}

/**
 * Load a test suite from a YAML file or a directory of YAML files.
 *
 * Supports:
 *   - Single file: `tests.yaml`
 *   - Directory: `tests/` (loads all .yaml/.yml files)
 *   - Single-test shorthand (no `tests:` wrapper)
 *   - Multi-test format (`tests:` array)
 */
export function loadSuite(path: string): Suite {
  const resolved = resolve(path);

  if (!existsSync(resolved)) {
    throw new Error(`Suite not found: ${resolved}`);
  }

  const stat = statSync(resolved);

  if (stat.isDirectory()) {
    return loadDirectory(resolved);
  }

  return loadFile(resolved);
}

function loadFile(filePath: string): Suite {
  const content = readFileSync(filePath, "utf-8");
  const raw: RawSuiteFile = parseYaml(content);

  if (!raw) {
    throw new Error(`Empty or invalid YAML: ${filePath}`);
  }

  const tests: SuiteTest[] = [];

  if (raw.tests && Array.isArray(raw.tests)) {
    // Multi-test format
    for (const t of raw.tests) {
      tests.push(parseTest(t, filePath));
    }
  } else if (raw.goal) {
    // Single-test shorthand
    tests.push(parseTest(raw as Partial<Record<string, unknown>>, filePath));
  } else {
    throw new Error(
      `No tests found in ${filePath}. Expected a "tests:" array or a top-level "goal:" field.`,
    );
  }

  return { tests, sourcePath: filePath };
}

function loadDirectory(dirPath: string): Suite {
  const files = readdirSync(dirPath)
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      return ext === ".yaml" || ext === ".yml";
    })
    .sort();

  if (files.length === 0) {
    throw new Error(`No .yaml/.yml files found in ${dirPath}`);
  }

  const allTests: SuiteTest[] = [];
  for (const file of files) {
    const suite = loadFile(join(dirPath, file));
    allTests.push(...suite.tests);
  }

  return { tests: allTests, sourcePath: dirPath };
}

function parseTest(
  raw: Partial<Record<string, unknown>>,
  source: string,
): SuiteTest {
  const goal = raw.goal as string | undefined;
  if (!goal) {
    throw new Error(`Test missing "goal:" field in ${source}`);
  }

  return {
    name: (raw.name as string) ?? goal.slice(0, 60),
    app: (raw.app as string) ?? "",
    goal,
    assertions: Array.isArray(raw.assertions)
      ? (raw.assertions as string[])
      : [],
    platform: raw.platform as "ios" | "android" | undefined,
    maxSteps: typeof raw.maxSteps === "number" ? raw.maxSteps : undefined,
  };
}
