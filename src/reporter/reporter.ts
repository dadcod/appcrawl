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
    s === "critical" ? "#ef4444" : s === "major" ? "#f59e0b" : "#60a5fa";

  const formatTimestamp = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const issueCards = report.issues
    .map(
      (issue, idx) => `
      <div class="issue-card" style="border-left-color:${severityColor(issue.severity)}">
        <div class="issue-header">
          <span class="severity-pill" style="background:${severityColor(issue.severity)}">${issue.severity.toUpperCase()}</span>
          <span class="issue-title">${esc(issue.description)}</span>
          <span class="issue-step">Step ${issue.step}</span>
        </div>
        <div class="issue-body">
          <div class="issue-detail"><span class="issue-label">Expected</span><span>${esc(issue.expected)}</span></div>
          <div class="issue-detail"><span class="issue-label">Actual</span><span>${esc(issue.actual)}</span></div>
        </div>
        ${screenshots.has(issue.step) ? `<img src="data:image/png;base64,${screenshots.get(issue.step)}" class="issue-screenshot" data-lightbox="issue-${idx}" alt="Screenshot at step ${issue.step}" />` : ""}
      </div>`,
    )
    .join("\n");

  const timelineSteps = report.actions
    .map((action) => {
      const params = Object.entries(action.params)
        .map(([k, v]) => `<span class="arg-key">${esc(k)}</span>=<span class="arg-val">${esc(JSON.stringify(v))}</span>`)
        .join(", ");
      const issue = report.issues.find((i) => i.step === action.step);
      const isFailure = /^failed?[: ]/i.test(action.result);
      const stateClass = issue ? "step--issue" : isFailure ? "step--failure" : "";
      const img = screenshots.has(action.step)
        ? `<img src="data:image/png;base64,${screenshots.get(action.step)}" class="step-screenshot" loading="lazy" alt="Step ${action.step}" data-lightbox="step-${action.step}" />`
        : `<div class="step-screenshot step-screenshot--missing">no screenshot</div>`;
      return `
        <div class="step ${stateClass}">
          <div class="step-number">${action.step}</div>
          <div class="step-content">
            <div class="step-action"><span class="step-tool">${esc(action.tool)}</span>(${params || '<span class="arg-val">—</span>'})</div>
            <div class="step-result">${esc(action.result)}</div>
          </div>
          <div class="step-img">${img}</div>
        </div>`;
    })
    .join("\n");

  const testResult = report.summary.testResult;
  const statusBadge = testResult
    ? `<span class="status-badge status-badge--${testResult.status}">${testResult.status === "pass" ? "Passed" : "Failed"}</span>`
    : report.summary.issuesFound > 0
      ? `<span class="status-badge status-badge--warning">${report.summary.issuesFound} Issue${report.summary.issuesFound === 1 ? "" : "s"}</span>`
      : `<span class="status-badge status-badge--clean">Clean Run</span>`;

  const durationLabel =
    report.duration >= 60
      ? `${Math.floor(report.duration / 60)}m ${report.duration % 60}s`
      : `${report.duration}s`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Skirmish Report — ${esc(report.bundleId)}</title>
<style>
  :root {
    --bg: #0b0d10;
    --bg-elev: #14171c;
    --bg-elev-2: #1b1f26;
    --border: #262b33;
    --border-strong: #323843;
    --text: #e6e8eb;
    --text-dim: #9ba1a9;
    --text-subtle: #6b7280;
    --accent: #a78bfa;
    --pass: #34d399;
    --fail: #f87171;
    --warn: #fbbf24;
    --info: #60a5fa;
    --radius: 10px;
    --radius-lg: 14px;
    --shadow: 0 1px 2px rgba(0,0,0,0.35), 0 4px 12px rgba(0,0,0,0.25);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 1120px; margin: 0 auto; padding: 2.5rem 2rem 4rem; }

  /* ---- Header ---- */
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; margin-bottom: 2rem; }
  .brand { display: flex; align-items: center; gap: 0.75rem; color: var(--text-dim); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
  .brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  h1 { font-size: 1.65rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text); margin-top: 0.25rem; }
  .title-sub { color: var(--text-dim); font-size: 0.9rem; margin-top: 0.25rem; font-weight: 400; }
  .status-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.9rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em; }
  .status-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status-badge--pass { background: rgba(52, 211, 153, 0.12); color: var(--pass); }
  .status-badge--fail { background: rgba(248, 113, 113, 0.12); color: var(--fail); }
  .status-badge--warning { background: rgba(251, 191, 36, 0.12); color: var(--warn); }
  .status-badge--clean { background: rgba(52, 211, 153, 0.12); color: var(--pass); }

  /* ---- Meta strip ---- */
  .meta-strip { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: 1rem 1.25rem; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1.5rem; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font-size: 0.7rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .meta-value { font-size: 0.88rem; color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
  .meta-value code { font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 0.82rem; background: var(--bg-elev-2); padding: 1px 6px; border-radius: 4px; }

  /* ---- Goal banner ---- */
  .goal { padding: 0.9rem 1.2rem; background: linear-gradient(135deg, rgba(167, 139, 250, 0.1), rgba(167, 139, 250, 0.03)); border: 1px solid rgba(167, 139, 250, 0.25); border-radius: var(--radius); margin-bottom: 1.5rem; color: var(--text); }
  .goal-label { color: var(--accent); font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-right: 0.5rem; }

  /* ---- Stats grid ---- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 2.5rem; }
  .stat { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.25rem; }
  .stat-label { font-size: 0.72rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 0.35rem; }
  .stat-value { font-size: 1.85rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1; }
  .stat--issues .stat-value { color: var(--warn); }
  .stat--issues.stat--clean .stat-value { color: var(--pass); }

  /* ---- Section ---- */
  h2 { font-size: 0.85rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em; margin: 2.5rem 0 1rem; display: flex; align-items: center; gap: 0.6rem; }
  h2::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* ---- Issues ---- */
  .issue-card { background: var(--bg-elev); border: 1px solid var(--border); border-left: 3px solid var(--info); border-radius: var(--radius); padding: 1.1rem 1.25rem; margin-bottom: 0.75rem; }
  .issue-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
  .severity-pill { color: #0b0d10; font-size: 0.68rem; font-weight: 800; letter-spacing: 0.06em; padding: 3px 8px; border-radius: 4px; }
  .issue-title { font-size: 0.95rem; font-weight: 600; color: var(--text); flex: 1; }
  .issue-step { font-size: 0.75rem; color: var(--text-subtle); font-variant-numeric: tabular-nums; }
  .issue-body { display: grid; gap: 0.5rem; }
  .issue-detail { display: grid; grid-template-columns: 80px 1fr; gap: 0.75rem; font-size: 0.85rem; color: var(--text-dim); }
  .issue-label { color: var(--text-subtle); font-weight: 600; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.06em; padding-top: 2px; }
  .issue-screenshot { max-width: 220px; border-radius: 8px; margin-top: 1rem; border: 1px solid var(--border); cursor: zoom-in; display: block; transition: opacity 0.15s; }
  .issue-screenshot:hover { opacity: 0.85; }
  .no-issues { padding: 1.25rem 1.5rem; background: rgba(52, 211, 153, 0.05); border: 1px solid rgba(52, 211, 153, 0.2); border-radius: var(--radius); color: var(--pass); font-size: 0.9rem; font-weight: 500; }

  /* ---- Timeline ---- */
  .timeline { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .step { display: grid; grid-template-columns: 42px 1fr 108px; gap: 1rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); align-items: center; transition: background 0.1s; }
  .step:last-child { border-bottom: none; }
  .step:hover { background: var(--bg-elev-2); }
  .step--issue { background: rgba(251, 191, 36, 0.04); border-left: 3px solid var(--warn); padding-left: calc(1.25rem - 3px); }
  .step--failure { background: rgba(248, 113, 113, 0.03); }
  .step-number { font-size: 0.72rem; font-weight: 700; color: var(--text-subtle); background: var(--bg-elev-2); border: 1px solid var(--border); width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
  .step-content { min-width: 0; }
  .step-action { font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 0.82rem; color: var(--text); word-break: break-word; }
  .step-tool { color: var(--accent); font-weight: 600; }
  .arg-key { color: var(--text-dim); }
  .arg-val { color: var(--info); }
  .step-result { font-size: 0.8rem; color: var(--text-dim); margin-top: 0.3rem; word-break: break-word; }
  .step--issue .step-result { color: var(--warn); }
  .step--failure .step-result { color: var(--fail); }
  .step-img { justify-self: end; }
  .step-screenshot { width: 96px; max-height: 200px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; display: block; transition: transform 0.15s, border-color 0.15s; }
  .step-screenshot:hover { border-color: var(--border-strong); transform: translateY(-1px); }
  .step-screenshot--missing { width: 96px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: var(--text-subtle); background: var(--bg-elev-2); border: 1px dashed var(--border); }

  /* ---- Lightbox ---- */
  .lightbox { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.88); display: none; align-items: center; justify-content: center; z-index: 100; padding: 2rem; cursor: zoom-out; backdrop-filter: blur(4px); }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
  .lightbox-close { position: absolute; top: 1.5rem; right: 1.5rem; color: #fff; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); width: 36px; height: 36px; border-radius: 50%; font-size: 1.1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .lightbox-close:hover { background: rgba(255,255,255,0.2); }

  /* ---- Footer ---- */
  .footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--text-subtle); font-size: 0.78rem; display: flex; justify-content: space-between; align-items: center; }
  .footer a { color: var(--text-dim); text-decoration: none; }
  .footer a:hover { color: var(--text); }

  @media (max-width: 720px) {
    .container { padding: 1.5rem 1rem 3rem; }
    .header { flex-direction: column; align-items: flex-start; gap: 1rem; }
    .step { grid-template-columns: 36px 1fr; }
    .step-img { grid-column: 1 / -1; justify-self: start; margin-top: 0.25rem; }
    .issue-detail { grid-template-columns: 1fr; gap: 0.2rem; }
  }
</style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div>
        <div class="brand"><span class="brand-dot"></span>Skirmish</div>
        <h1>Test Report</h1>
        <div class="title-sub">${esc(report.bundleId)} · ${esc(report.mode)} mode</div>
      </div>
      ${statusBadge}
    </header>

    <div class="meta-strip">
      <div class="meta-item"><span class="meta-label">Bundle</span><span class="meta-value"><code>${esc(report.bundleId)}</code></span></div>
      <div class="meta-item"><span class="meta-label">Model</span><span class="meta-value"><code>${esc(report.model)}</code></span></div>
      <div class="meta-item"><span class="meta-label">Mode</span><span class="meta-value">${esc(report.mode)}</span></div>
      <div class="meta-item"><span class="meta-label">Duration</span><span class="meta-value">${durationLabel}</span></div>
      <div class="meta-item"><span class="meta-label">Started</span><span class="meta-value">${esc(formatTimestamp(report.timestamp))}</span></div>
    </div>

    ${report.instruction ? `<div class="goal"><span class="goal-label">Goal</span>${esc(report.instruction)}</div>` : ""}

    <div class="stats">
      <div class="stat"><div class="stat-label">Actions</div><div class="stat-value">${report.summary.totalActions}</div></div>
      <div class="stat"><div class="stat-label">Screens</div><div class="stat-value">${report.summary.screensVisited}</div></div>
      <div class="stat stat--issues ${report.summary.issuesFound === 0 ? "stat--clean" : ""}"><div class="stat-label">Issues</div><div class="stat-value">${report.summary.issuesFound}</div></div>
      <div class="stat"><div class="stat-label">Duration</div><div class="stat-value">${durationLabel}</div></div>
    </div>

    <h2>Issues</h2>
    ${report.issues.length > 0 ? issueCards : '<div class="no-issues">No issues found — clean run.</div>'}

    <h2>Timeline</h2>
    <div class="timeline">${timelineSteps}</div>

    <footer class="footer">
      <div>Generated by Skirmish · ${esc(formatTimestamp(report.timestamp))}</div>
      <div>${report.summary.totalActions} actions · ${durationLabel}</div>
    </footer>
  </div>

  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" aria-label="Close">×</button>
    <img src="" alt="" />
  </div>

  <script>
    (function() {
      const lightbox = document.getElementById('lightbox');
      const lightboxImg = lightbox.querySelector('img');
      const closeBtn = lightbox.querySelector('.lightbox-close');

      function open(src, alt) {
        lightboxImg.src = src;
        lightboxImg.alt = alt || '';
        lightbox.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function close() {
        lightbox.classList.remove('open');
        lightboxImg.src = '';
        document.body.style.overflow = '';
      }

      document.querySelectorAll('[data-lightbox]').forEach(function(img) {
        img.addEventListener('click', function() { open(img.src, img.alt); });
      });
      lightbox.addEventListener('click', function(e) {
        if (e.target === lightbox || e.target === closeBtn) close();
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && lightbox.classList.contains('open')) close();
      });
    })();
  </script>
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
