import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentState } from "../agent/state.js";
import type { Report } from "./types.js";

export async function generateReport(
  state: AgentState,
  options: {
    mode: "explore" | "steered";
    instruction: string | null;
    bundleId: string;
    model: string;
    runDir: string;
  },
): Promise<{ jsonPath: string; mdPath: string; htmlPath: string; junitPath: string }> {
  const dir = options.runDir;
  await mkdir(dir, { recursive: true });

  const report = buildReport(state, options);

  const jsonPath = join(dir, "report.json");
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  const mdPath = join(dir, "report.md");
  await writeFile(mdPath, renderMarkdown(report));

  const htmlPath = join(dir, "report.html");
  await writeFile(htmlPath, await renderHtml(report, dir));

  const junitPath = join(dir, "junit.xml");
  await writeFile(junitPath, renderJunit(report));

  return { jsonPath, mdPath, htmlPath, junitPath };
}

/**
 * Exit code convention for CI mode:
 *   0 = all tests passed, no issues
 *   1 = test failed or critical/major issues found
 *   2 = infrastructure error (Maestro, simulator, API key)
 *
 * Minor issues alone don't fail the run — they're informational.
 */
export function computeExitCode(state: AgentState): number {
  if (state.testResult?.status === "fail") return 1;
  const blocking = state.issues.filter(
    (i) => i.severity === "critical" || i.severity === "major",
  );
  if (blocking.length > 0) return 1;
  return 0;
}

function buildReport(
  state: AgentState,
  options: {
    mode: "explore" | "steered";
    instruction: string | null;
    bundleId: string;
    model: string;
  },
): Report {
  return {
    timestamp: new Date().toISOString(),
    duration: Math.round((Date.now() - state.startTime) / 1000),
    mode: options.mode,
    instruction: options.instruction,
    bundleId: options.bundleId,
    model: options.model,
    summary: {
      screensVisited: state.screens.size,
      totalActions: state.actions.length,
      issuesFound: state.issues.length,
      testResult: state.testResult,
    },
    screens: Array.from(state.screens.entries()).map(([name, info]) => ({
      name,
      visitCount: info.visitCount,
    })),
    issues: state.issues,
    actions: state.actions,
  };
}

function renderMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push("# Skirmish Test Report");
  lines.push("");
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Duration:** ${report.duration}s`);
  lines.push(`**Mode:** ${report.mode}`);
  if (report.instruction) {
    lines.push(`**Goal:** ${report.instruction}`);
  }
  lines.push(`**App:** ${report.bundleId}`);
  lines.push(`**Model:** ${report.model}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Screens visited: ${report.summary.screensVisited}`);
  lines.push(`- Total actions: ${report.summary.totalActions}`);
  lines.push(`- Issues found: ${report.summary.issuesFound}`);
  if (report.summary.testResult) {
    const r = report.summary.testResult;
    lines.push(`- **Result: ${r.status.toUpperCase()}** — ${r.reason}`);
  }
  lines.push("");

  // Issues
  if (report.issues.length > 0) {
    lines.push("## Issues");
    lines.push("");
    for (const issue of report.issues) {
      const icon =
        issue.severity === "critical"
          ? "!!!"
          : issue.severity === "major"
            ? "!!"
            : "!";
      lines.push(`### [${icon} ${issue.severity.toUpperCase()}] ${issue.description}`);
      lines.push("");
      lines.push(`- **Step:** ${issue.step}`);
      lines.push(`- **Expected:** ${issue.expected}`);
      lines.push(`- **Actual:** ${issue.actual}`);
      if (issue.screenshotPath) {
        lines.push(`- **Screenshot:** ${issue.screenshotPath}`);
      }
      lines.push("");
    }
  }

  // Screens
  if (report.screens.length > 0) {
    lines.push("## Screens Visited");
    lines.push("");
    lines.push("| Screen | Visits |");
    lines.push("|--------|--------|");
    for (const screen of report.screens) {
      lines.push(`| ${screen.name} | ${screen.visitCount} |`);
    }
    lines.push("");
  }

  // Action log
  lines.push("## Action Log");
  lines.push("");
  for (const action of report.actions) {
    const params = Object.entries(action.params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`${action.step}. **${action.tool}**(${params}) — ${action.result}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function renderHtml(report: Report, runDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  // Load screenshots as base64
  const screenshots: Map<number, string> = new Map();
  for (const action of report.actions) {
    const imgPath = join(runDir, "screenshots", `step-${action.step}.png`);
    try {
      const buf = await readFile(imgPath);
      screenshots.set(action.step, buf.toString("base64"));
    } catch {
      // Screenshot not available
    }
  }

  const severityColor = (s: string) =>
    s === "critical" ? "#ef4444" : s === "major" ? "#f59e0b" : "#3b82f6";

  const issueCards = report.issues
    .map(
      (issue) => `
      <div class="issue-card" style="border-left: 4px solid ${severityColor(issue.severity)}">
        <div class="issue-header">
          <span class="severity" style="background:${severityColor(issue.severity)}">${issue.severity.toUpperCase()}</span>
          <span>${issue.description}</span>
        </div>
        <div class="issue-detail"><strong>Expected:</strong> ${esc(issue.expected)}</div>
        <div class="issue-detail"><strong>Actual:</strong> ${esc(issue.actual)}</div>
        <div class="issue-detail"><strong>Step:</strong> ${issue.step}</div>
        ${screenshots.has(issue.step) ? `<img src="data:image/png;base64,${screenshots.get(issue.step)}" class="issue-screenshot" />` : ""}
      </div>`,
    )
    .join("\n");

  const timelineSteps = report.actions
    .map((action) => {
      const params = Object.entries(action.params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      const hasIssue = report.issues.some((i) => i.step === action.step);
      const img = screenshots.has(action.step)
        ? `<img src="data:image/png;base64,${screenshots.get(action.step)}" class="step-screenshot" loading="lazy" />`
        : "";
      return `
        <div class="step ${hasIssue ? "step-issue" : ""}">
          <div class="step-number">${action.step}</div>
          <div class="step-content">
            <div class="step-action"><strong>${esc(action.tool)}</strong>(${esc(params)})</div>
            <div class="step-result">${esc(action.result)}</div>
          </div>
          <div class="step-img">${img}</div>
        </div>`;
    })
    .join("\n");

  const resultBadge = report.summary.testResult
    ? `<span class="badge ${report.summary.testResult.status === "pass" ? "badge-pass" : "badge-fail"}">${report.summary.testResult.status.toUpperCase()}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Skirmish Report — ${esc(report.bundleId)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: #fff; }
  h2 { font-size: 1.3rem; margin: 2rem 0 1rem; color: #fff; border-bottom: 1px solid #333; padding-bottom: 0.5rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 2rem; }
  .meta span { margin-right: 1.5rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat { background: #1a1a1a; border-radius: 12px; padding: 1.2rem; text-align: center; }
  .stat-value { font-size: 2rem; font-weight: 700; color: #fff; }
  .stat-label { font-size: 0.8rem; color: #888; margin-top: 0.3rem; }
  .issue-card { background: #1a1a1a; border-radius: 8px; padding: 1rem 1.2rem; margin-bottom: 1rem; }
  .issue-header { font-weight: 600; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
  .severity { color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .issue-detail { font-size: 0.9rem; color: #aaa; margin-top: 0.3rem; }
  .issue-screenshot { max-width: 200px; border-radius: 8px; margin-top: 0.8rem; border: 1px solid #333; }
  .step { display: flex; align-items: flex-start; gap: 1rem; padding: 0.8rem 0; border-bottom: 1px solid #1a1a1a; }
  .step-issue { background: #1a1208; border-radius: 6px; padding: 0.8rem; }
  .step-number { background: #222; color: #888; font-size: 0.8rem; font-weight: 700; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .step-content { flex: 1; min-width: 0; }
  .step-action { font-size: 0.9rem; }
  .step-result { font-size: 0.85rem; color: #888; margin-top: 0.2rem; }
  .step-img { flex-shrink: 0; }
  .step-screenshot { width: 120px; border-radius: 8px; border: 1px solid #333; cursor: pointer; transition: transform 0.2s; }
  .step-screenshot:hover { transform: scale(2.5); position: relative; z-index: 10; }
  .badge { font-size: 0.8rem; font-weight: 700; padding: 4px 12px; border-radius: 6px; }
  .badge-pass { background: #166534; color: #4ade80; }
  .badge-fail { background: #7f1d1d; color: #f87171; }
  .no-issues { color: #4ade80; font-size: 0.95rem; padding: 1rem; background: #0a1a0a; border-radius: 8px; }
</style>
</head>
<body>
  <h1>Skirmish Test Report ${resultBadge}</h1>
  <div class="meta">
    <span>${esc(report.bundleId)}</span>
    <span>${report.mode} mode</span>
    <span>${report.model}</span>
    <span>${report.duration}s</span>
    <span>${report.timestamp}</span>
  </div>
  ${report.instruction ? `<p style="color:#a78bfa; margin-bottom:1.5rem"><strong>Goal:</strong> ${esc(report.instruction)}</p>` : ""}

  <div class="summary">
    <div class="stat"><div class="stat-value">${report.summary.totalActions}</div><div class="stat-label">Actions</div></div>
    <div class="stat"><div class="stat-value">${report.summary.screensVisited}</div><div class="stat-label">Screens</div></div>
    <div class="stat"><div class="stat-value" style="color:${report.summary.issuesFound > 0 ? "#f59e0b" : "#4ade80"}">${report.summary.issuesFound}</div><div class="stat-label">Issues</div></div>
    <div class="stat"><div class="stat-value">${report.duration}s</div><div class="stat-label">Duration</div></div>
  </div>

  <h2>Issues</h2>
  ${report.issues.length > 0 ? issueCards : '<div class="no-issues">No issues found</div>'}

  <h2>Timeline</h2>
  ${timelineSteps}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JUnit XML for CI pipeline integration. Each issue becomes a
 * <failure>; a failed mark_complete becomes a failed testcase;
 * a clean run emits a single passing testcase.
 */
function renderJunit(report: Report): string {
  const suiteName = `skirmish.${report.mode}`;
  const testName = report.instruction
    ? report.instruction.slice(0, 80)
    : `explore ${report.bundleId}`;
  const blocking = report.issues.filter(
    (i) => i.severity === "critical" || i.severity === "major",
  );
  const failed =
    report.summary.testResult?.status === "fail" || blocking.length > 0;
  const failures = failed ? 1 : 0;
  const tests = 1;

  const failureBody = failed
    ? [
        report.summary.testResult?.status === "fail"
          ? `Test marked fail: ${report.summary.testResult.reason}`
          : "",
        ...blocking.map(
          (i) =>
            `[${i.severity}] ${i.description}\n  expected: ${i.expected}\n  actual: ${i.actual}\n  step: ${i.step}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";

  const failureNode = failed
    ? `      <failure message="${esc(
        report.summary.testResult?.reason ?? `${blocking.length} blocking issue(s)`,
      )}"><![CDATA[${failureBody}]]></failure>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="skirmish" tests="${tests}" failures="${failures}" time="${report.duration}">
  <testsuite name="${esc(suiteName)}" tests="${tests}" failures="${failures}" time="${report.duration}" timestamp="${report.timestamp}">
    <testcase classname="${esc(suiteName)}" name="${esc(testName)}" time="${report.duration}">
${failureNode}    </testcase>
  </testsuite>
</testsuites>
`;
}

export function printConsoleSummary(state: AgentState, mode: string): void {
  console.log("\n" + "=".repeat(50));
  console.log("  SKIRMISH TEST REPORT");
  console.log("=".repeat(50));

  const duration = Math.round((Date.now() - state.startTime) / 1000);
  console.log(`  Mode:     ${mode}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  Actions:  ${state.actions.length}`);
  console.log(`  Screens:  ${state.screens.size}`);
  console.log(`  Issues:   ${state.issues.length}`);

  if (state.testResult) {
    const icon = state.testResult.status === "pass" ? "[PASS]" : "[FAIL]";
    console.log(`  Result:   ${icon} ${state.testResult.reason}`);
  }

  if (state.issues.length > 0) {
    console.log("\n  Issues:");
    for (const issue of state.issues) {
      console.log(`    [${issue.severity.toUpperCase()}] ${issue.description}`);
    }
  }

  console.log("=".repeat(50) + "\n");
}
