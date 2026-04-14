import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateText, type LanguageModel } from "ai";
import type { Report } from "../reporter/types.js";
import type { ActionRecord } from "../agent/state.js";

/**
 * A single extracted test definition — a replayable steered test
 * derived from an explore session's action trace.
 */
export interface TestDefinition {
  name: string;
  app: string;
  /** Natural-language goal for `appcrawl run` */
  goal: string;
  /** Assertions the test should verify */
  assertions: string[];
  /** The original action indices this test covers */
  sourceSteps: number[];
}

export interface ExtractResult {
  tests: TestDefinition[];
  yamlPath: string | null;
}

/**
 * Read a report JSON and extract replayable test definitions.
 *
 * Two strategies:
 *   1. Mechanical: segment the action trace into screen-to-screen paths,
 *      drop noise (failed taps, loops, errors), emit one test per path.
 *   2. LLM-assisted: feed the cleaned trace to the model and ask it to
 *      identify the interesting test scenarios worth regression-testing.
 *
 * When a model is provided, strategy 2 is used (better quality).
 * Without a model, strategy 1 is used (free, instant).
 */
export async function extractTests(
  reportPath: string,
  options: {
    model?: LanguageModel;
    outDir?: string;
  } = {},
): Promise<ExtractResult> {
  const raw = readFileSync(reportPath, "utf-8");
  const report: Report = JSON.parse(raw);

  const cleaned = cleanActionTrace(report.actions);

  let tests: TestDefinition[];

  if (options.model) {
    tests = await extractWithLLM(report, cleaned, options.model);
  } else {
    tests = extractMechanically(report, cleaned);
  }

  // Write YAML output
  let yamlPath: string | null = null;
  if (tests.length > 0) {
    const outDir = options.outDir ?? join(dirname(reportPath), "extracted-tests");
    mkdirSync(outDir, { recursive: true });
    yamlPath = join(outDir, "tests.yaml");
    writeFileSync(yamlPath, serializeTestsYaml(tests, report));
  }

  return { tests, yamlPath };
}

/**
 * Remove noise from the action trace: failed actions, retries,
 * navigate_back spam, waits, errors. Keep the meaningful interactions.
 */
function cleanActionTrace(actions: ActionRecord[]): ActionRecord[] {
  return actions.filter((a) => {
    // Drop errors and "no action" entries
    if (a.tool === "error" || a.tool === "none") return false;
    // Drop failed actions
    if (a.result.toLowerCase().startsWith("failed")) return false;
    if (a.result.includes("not found")) return false;
    // Drop waits
    if (a.tool === "wait") return false;
    // Keep everything else — even navigate_back (it's meaningful in moderation)
    return true;
  });
}

/**
 * Mechanical extraction: segment actions into logical groups
 * based on screen transitions and emit one test per group.
 */
function extractMechanically(
  report: Report,
  actions: ActionRecord[],
): TestDefinition[] {
  if (actions.length === 0) return [];

  // Group consecutive actions into "flows" separated by navigate_back
  const flows: ActionRecord[][] = [];
  let current: ActionRecord[] = [];

  for (const action of actions) {
    if (action.tool === "navigate_back" && current.length > 0) {
      flows.push(current);
      current = [];
    } else if (action.tool !== "navigate_back") {
      current.push(action);
    }
  }
  if (current.length > 0) flows.push(current);

  // Convert each meaningful flow into a test definition
  const tests: TestDefinition[] = [];
  for (const flow of flows) {
    if (flow.length < 2) continue; // Skip trivial single-action flows

    const steps = describeActions(flow);
    const name = inferTestName(flow);
    const assertions = inferAssertions(flow);

    tests.push({
      name,
      app: report.bundleId,
      goal: steps.join(". ") + ".",
      assertions,
      sourceSteps: flow.map((a) => a.step),
    });
  }

  return deduplicateTests(tests);
}

/**
 * LLM-assisted extraction: send the cleaned trace to the model and
 * ask it to identify regression-worthy test scenarios.
 */
async function extractWithLLM(
  report: Report,
  actions: ActionRecord[],
  model: LanguageModel,
): Promise<TestDefinition[]> {
  const traceText = actions
    .map(
      (a) =>
        `Step ${a.step}: ${a.tool}(${JSON.stringify(a.params)}) → ${a.result}`,
    )
    .join("\n");

  const screenList = report.screens
    .map((s) => `${s.name} (visited ${s.visitCount}x)`)
    .join(", ");

  const issueList =
    report.issues.length > 0
      ? report.issues
          .map((i) => `[${i.severity}] ${i.description}`)
          .join("\n")
      : "None";

  const prompt = `You are analyzing an exploratory test session of a mobile app (${report.bundleId}).

## Session Summary
- Mode: ${report.mode}
- Duration: ${report.duration}s
- Screens visited: ${screenList}
- Issues found: ${issueList}

## Action Trace (cleaned — failed actions already removed)
${traceText}

## Your Task
Extract replayable test definitions from this session. Each test should represent a distinct user flow worth regression-testing.

Guidelines:
- Focus on INTERESTING paths: form submissions, navigation flows, feature interactions
- Skip trivial actions like scrolling with no purpose
- Each test should be self-contained: it should work from a fresh app launch
- Write goals as natural language instructions (for an AI agent to replay)
- Include specific assertions — what should be visible/true after the flow

Respond with a JSON array of test objects. Each object has:
- "name": short test name (e.g. "Create contact with phone number")
- "goal": natural language instruction for the AI agent
- "assertions": array of strings, each a visible-text assertion

Example:
[
  {
    "name": "Add new alarm",
    "goal": "Open the Alarm tab, tap + to create a new alarm, set it for 7:30 AM, save it",
    "assertions": ["7:30 AM", "Alarm"]
  }
]

Return ONLY the JSON array, no markdown fences or explanation.`;

  const result = await generateText({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2000,
  });

  try {
    // Strip markdown code fences if the LLM wrapped the JSON
    let jsonText = result.text.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonText) as Array<{
      name: string;
      goal: string;
      assertions: string[];
    }>;

    return parsed.map((t) => ({
      name: t.name,
      app: report.bundleId,
      goal: t.goal,
      assertions: t.assertions ?? [],
      sourceSteps: [],
    }));
  } catch {
    // LLM returned unparseable JSON — fall back to mechanical
    console.warn("LLM output was not valid JSON, falling back to mechanical extraction");
    return extractMechanically(report, actions);
  }
}

function describeActions(actions: ActionRecord[]): string[] {
  return actions.map((a) => {
    switch (a.tool) {
      case "tap":
        return `Tap "${a.params.element}"`;
      case "tap_coordinates":
        return `Tap at (${a.params.x}, ${a.params.y})`;
      case "tap_and_type":
        return `Tap "${a.params.element}" and type "${a.params.text}"`;
      case "type_text":
        return `Type "${a.params.text}"`;
      case "scroll":
        return `Scroll ${a.params.direction}`;
      case "assert_visible":
        return `Verify "${a.params.text}" is visible`;
      case "report_issue":
        return `Report issue: ${a.params.description}`;
      case "mark_complete":
        return `Mark test as ${a.params.status}`;
      default:
        return `${a.tool}(${JSON.stringify(a.params)})`;
    }
  });
}

function inferTestName(actions: ActionRecord[]): string {
  // Use the first tap target as a rough name
  const firstTap = actions.find(
    (a) => a.tool === "tap" || a.tool === "tap_and_type",
  );
  if (firstTap) {
    const target = (firstTap.params.element as string) ?? "screen";
    const hasType = actions.some((a) => a.tool === "tap_and_type");
    if (hasType) return `Fill form via ${target}`;
    return `Navigate to ${target}`;
  }
  return `Flow from step ${actions[0].step}`;
}

function inferAssertions(actions: ActionRecord[]): string[] {
  const assertions: string[] = [];
  // If there are explicit assert_visible calls, use those
  for (const a of actions) {
    if (a.tool === "assert_visible" && a.params.text) {
      assertions.push(String(a.params.text));
    }
  }
  // If no explicit assertions, suggest asserting the last tapped element
  if (assertions.length === 0) {
    const lastTap = [...actions]
      .reverse()
      .find((a) => a.tool === "tap" || a.tool === "tap_and_type");
    if (lastTap?.params.element) {
      assertions.push(String(lastTap.params.element));
    }
  }
  return assertions;
}

function deduplicateTests(tests: TestDefinition[]): TestDefinition[] {
  const seen = new Set<string>();
  return tests.filter((t) => {
    const key = t.goal.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function serializeTestsYaml(tests: TestDefinition[], report: Report): string {
  const lines: string[] = [];
  lines.push(`# Extracted from: ${report.bundleId}`);
  lines.push(`# Source session: ${report.timestamp}`);
  lines.push(`# Mode: ${report.mode}, ${report.summary.totalActions} actions, ${report.summary.screensVisited} screens`);
  lines.push("");

  lines.push("tests:");
  for (const test of tests) {
    lines.push(`  - name: ${yamlString(test.name)}`);
    lines.push(`    app: ${test.app}`);
    lines.push(`    goal: ${yamlString(test.goal)}`);
    if (test.assertions.length > 0) {
      lines.push(`    assertions:`);
      for (const a of test.assertions) {
        lines.push(`      - ${yamlString(a)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Quote a YAML string value if it contains special characters. */
function yamlString(s: string): string {
  if (
    s.includes(":") ||
    s.includes("#") ||
    s.includes('"') ||
    s.includes("'") ||
    s.includes("\n") ||
    s.startsWith(" ") ||
    s.startsWith("-")
  ) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}
