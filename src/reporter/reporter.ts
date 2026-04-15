import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentState } from "../agent/state.js";
import type { Report } from "./types.js";
import type { JiraConfig } from "../config/context.js";

export async function generateReport(
  state: AgentState,
  options: {
    mode: "explore" | "steered";
    instruction: string | null;
    bundleId: string;
    model: string;
    runDir: string;
    jira?: JiraConfig;
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
  await writeFile(htmlPath, await renderHtml(report, dir, options.jira));

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

  lines.push("# AppCrawl Test Report");
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

async function renderHtml(
  report: Report,
  runDir: string,
  jira?: JiraConfig,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  // Load screenshots as base64 — embedded so the HTML is a single shareable file
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

  const durationLabel =
    report.duration >= 60
      ? `${Math.floor(report.duration / 60)}m ${report.duration % 60}s`
      : `${report.duration}s`;

  const testResult = report.summary.testResult;
  const statusBadge = testResult
    ? `<span class="status-badge status-badge--${testResult.status}">${testResult.status === "pass" ? "Passed" : "Failed"}</span>`
    : report.summary.issuesFound > 0
      ? `<span class="status-badge status-badge--warning">${report.summary.issuesFound} Issue${report.summary.issuesFound === 1 ? "" : "s"}</span>`
      : `<span class="status-badge status-badge--clean">Clean Run</span>`;

  // ---- Issue cards ----
  // Flat single-surface layout: header row, expected/actual rows,
  // footer with AI Remediation meta and copy buttons. No nested boxes.
  // Confidence is severity-derived (see computeConfidence) — documented
  // in the tooltip. A real LLM-grounded score would need a per-issue
  // follow-up call.
  const issueCards = report.issues
    .map((issue, idx) => {
      const confidence = computeConfidence(issue, report);
      const shot = screenshots.get(issue.step);
      const copyPayload = JSON.stringify({
        step: issue.step,
        severity: issue.severity,
        description: issue.description,
        expected: issue.expected,
        actual: issue.actual,
      });
      const fixPrompt = buildFixPrompt(issue, report);
      const jiraButton = renderJiraButton(issue, report, jira);
      return `
      <article class="issue" data-severity="${issue.severity}" data-filter="issues ${issue.severity}">
        <div class="issue-main">
          <header class="issue-header">
            <span class="severity-chip severity-chip--${issue.severity}">${issue.severity}</span>
            <h3 class="issue-title">${esc(issue.description)}</h3>
            <a class="issue-step-link" href="#step-${issue.step}">Step ${issue.step} →</a>
          </header>
          <dl class="issue-diff">
            <dt class="diff-label diff-label--expected">Expected</dt>
            <dd class="diff-text">${esc(issue.expected)}</dd>
            <dt class="diff-label diff-label--actual">Actual</dt>
            <dd class="diff-text">${esc(issue.actual)}</dd>
          </dl>
          <footer class="issue-footer">
            <div class="ai-meta" title="Confidence is derived from severity and whether the test was marked failed — not an ML-grounded score.">
              <span class="ai-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                AI Remediation
              </span>
              <span class="ai-dot">·</span>
              <div class="confidence-bar"><div class="confidence-fill" style="width:${confidence}%"></div></div>
              <span class="confidence-value">${confidence}%</span>
            </div>
            <div class="issue-actions">
              <button class="copy-btn" data-copy="${esc(copyPayload)}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy details
              </button>
              ${jiraButton}
              <button class="copy-btn copy-btn--primary" data-copy="${esc(fixPrompt)}" title="Paste into Claude Code, Cursor, Aider, etc. to fix and verify in a loop.">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Copy fix prompt
              </button>
            </div>
          </footer>
        </div>
        ${shot ? `<button class="issue-snapshot" data-lightbox="issue-${idx}" aria-label="Open screenshot for step ${issue.step}"><img src="data:image/png;base64,${shot}" alt="Screenshot at step ${issue.step}" /></button>` : ""}
      </article>`;
    })
    .join("\n");

  // ---- Timeline steps with data-attribs for Cmd+K search and filter chips ----
  const timelineSteps = report.actions
    .map((action) => {
      const params = Object.entries(action.params)
        .map(
          ([k, v]) =>
            `<span class="arg-key">${esc(k)}</span>=<span class="arg-val">${esc(JSON.stringify(v))}</span>`,
        )
        .join(", ");
      const issue = report.issues.find((i) => i.step === action.step);
      const isFailure = /^failed?[: ]/i.test(action.result);
      const category = categorizeAction(action.tool);
      const stateClass = issue ? "step--issue" : isFailure ? "step--failure" : "";
      const filterTags = [
        "all",
        category,
        issue ? "issues" : "",
        isFailure ? "failures" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const searchText = [
        action.tool,
        action.result,
        JSON.stringify(action.params),
        issue?.description ?? "",
      ]
        .join(" ")
        .toLowerCase();
      const img = screenshots.has(action.step)
        ? `<img src="data:image/png;base64,${screenshots.get(action.step)}" class="step-screenshot" loading="lazy" alt="Step ${action.step}" data-lightbox="step-${action.step}" />`
        : `<div class="step-screenshot step-screenshot--missing">no screenshot</div>`;
      return `
        <div class="step ${stateClass}" id="step-${action.step}" data-filter="${filterTags}" data-search="${esc(searchText)}" data-step="${action.step}" data-tool="${esc(action.tool)}">
          <div class="step-number">${action.step}</div>
          <div class="step-content">
            <div class="step-action"><span class="step-tool">${esc(action.tool)}</span>(${params || '<span class="arg-val">—</span>'})</div>
            <div class="step-result">${esc(action.result)}</div>
          </div>
          <div class="step-img">${img}</div>
        </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AppCrawl Report — ${esc(report.bundleId)}</title>
<style>
  :root {
    /* Signal & Depth palette */
    --bg: #0B0E14;                 /* Deep Space */
    --bg-elev: #11151D;
    --bg-elev-2: #161B25;
    --bg-elev-3: #1A2030;
    --border: #1E2530;             /* Steel */
    --border-strong: #2A3240;
    --text: #E8ECF3;
    --text-dim: #8A94A6;
    --text-subtle: #5D6878;
    --pass: #00F5A0;               /* Neon Mint */
    --fail: #FF3D71;               /* Crimson Glow */
    --warn: #FFB347;
    --ai: #0EA5E9;                 /* Sky Blue */
    --ai-bright: #38BDF8;
    --ai-glow: rgba(56, 189, 248, 0.35);
    --radius: 10px;
    --radius-lg: 14px;
    --shadow: 0 1px 2px rgba(0,0,0,0.45), 0 8px 24px rgba(0,0,0,0.4);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', 'Segoe UI', Roboto, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 2.5rem 2rem 4rem; }
  button { font-family: inherit; cursor: pointer; }
  a { color: inherit; }

  /* ---- Header ---- */
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; margin-bottom: 2rem; }
  .brand { display: flex; align-items: center; gap: 0.6rem; color: var(--text-dim); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
  .brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ai); box-shadow: 0 0 12px var(--ai-glow); }
  h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.015em; color: var(--text); margin-top: 0.4rem; }
  .title-sub { color: var(--text-dim); font-size: 0.9rem; margin-top: 0.3rem; font-weight: 400; }
  .status-badge { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.5rem 1rem; border-radius: 999px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  .status-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
  .status-badge--pass, .status-badge--clean { background: rgba(0, 245, 160, 0.1); color: var(--pass); border: 1px solid rgba(0, 245, 160, 0.3); }
  .status-badge--fail { background: rgba(255, 61, 113, 0.1); color: var(--fail); border: 1px solid rgba(255, 61, 113, 0.35); }
  .status-badge--warning { background: rgba(255, 179, 71, 0.08); color: var(--warn); border: 1px solid rgba(255, 179, 71, 0.3); }

  /* ---- Command bar ---- */
  .command-bar { display: flex; gap: 0.75rem; align-items: center; padding: 0.75rem 1rem; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1.25rem; }
  .search-trigger { flex: 1; display: flex; align-items: center; gap: 0.6rem; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 8px; padding: 0.55rem 0.9rem; color: var(--text-subtle); font-size: 0.85rem; text-align: left; transition: border-color 0.15s, background 0.15s; }
  .search-trigger:hover { border-color: var(--border-strong); background: var(--bg-elev-3); color: var(--text-dim); }
  .search-trigger svg { color: var(--text-subtle); flex-shrink: 0; }
  .kbd { margin-left: auto; display: inline-flex; gap: 2px; font-size: 0.72rem; color: var(--text-subtle); }
  .kbd span { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-family: 'SF Mono', Menlo, Monaco, monospace; }

  /* ---- Meta strip ---- */
  .meta-strip { display: flex; flex-wrap: wrap; gap: 1.75rem; padding: 1rem 1.25rem; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1.25rem; }
  .meta-item { display: flex; flex-direction: column; gap: 3px; }
  .meta-label { font-size: 0.68rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
  .meta-value { font-size: 0.88rem; color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
  .meta-value code { font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 0.8rem; background: var(--bg-elev-2); padding: 2px 7px; border-radius: 4px; border: 1px solid var(--border); }

  /* ---- Goal banner ---- */
  .goal { padding: 0.95rem 1.25rem; background: linear-gradient(135deg, rgba(56, 189, 248, 0.12), rgba(56, 189, 248, 0.02)); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: var(--radius); margin-bottom: 1.25rem; color: var(--text); }
  .goal-label { color: var(--ai-bright); font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; margin-right: 0.6rem; }

  /* ---- Stats grid ---- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .stat { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.15rem 1.25rem; transition: border-color 0.15s; }
  .stat:hover { border-color: var(--border-strong); }
  .stat-label { font-size: 0.68rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; margin-bottom: 0.45rem; }
  .stat-value { font-size: 2rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.02em; }
  .stat--issues .stat-value { color: var(--fail); }
  .stat--issues.stat--clean .stat-value { color: var(--pass); }

  /* ---- Filter chips ---- */
  .filter-bar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-bottom: 2rem; }
  .chip { background: var(--bg-elev); border: 1px solid var(--border); color: var(--text-dim); padding: 0.45rem 0.9rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; transition: all 0.15s; display: inline-flex; align-items: center; gap: 0.4rem; letter-spacing: 0.01em; }
  .chip:hover { border-color: var(--border-strong); color: var(--text); background: var(--bg-elev-2); }
  .chip.active { background: var(--text); color: var(--bg); border-color: var(--text); }
  .chip-count { background: rgba(255,255,255,0.1); border-radius: 10px; padding: 1px 6px; font-size: 0.7rem; font-variant-numeric: tabular-nums; }
  .chip.active .chip-count { background: rgba(11, 14, 20, 0.15); }

  /* ---- Section heading ---- */
  h2 { font-size: 0.78rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin: 2.5rem 0 1rem; display: flex; align-items: center; gap: 0.75rem; }
  h2::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* ---- Issues: single flat surface, no nested cards ---- */
  .issue { display: grid; grid-template-columns: 1fr 180px; gap: 1.5rem; background: var(--bg-elev); border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius-lg); margin-bottom: 0.9rem; padding: 1.25rem 1.4rem; align-items: start; }
  .issue[data-severity="critical"], .issue[data-severity="major"] { border-left-color: var(--fail); }
  .issue[data-severity="minor"] { border-left-color: var(--warn); }
  @media (max-width: 780px) { .issue { grid-template-columns: 1fr; } }

  .issue-main { min-width: 0; }

  .issue-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
  .severity-chip { font-size: 0.64rem; font-weight: 800; letter-spacing: 0.1em; padding: 3px 8px; border-radius: 3px; text-transform: uppercase; font-variant-numeric: tabular-nums; }
  .severity-chip--critical, .severity-chip--major { background: rgba(255, 61, 113, 0.14); color: var(--fail); }
  .severity-chip--minor { background: rgba(255, 179, 71, 0.12); color: var(--warn); }
  .issue-title { font-size: 0.98rem; font-weight: 600; color: var(--text); flex: 1; line-height: 1.45; }
  .issue-step-link { font-size: 0.76rem; color: var(--text-subtle); text-decoration: none; font-variant-numeric: tabular-nums; transition: color 0.15s; white-space: nowrap; }
  .issue-step-link:hover { color: var(--ai-bright); }

  /* Expected / Actual as a two-column definition list, no box chrome */
  .issue-diff { display: grid; grid-template-columns: 72px 1fr; column-gap: 1rem; row-gap: 0.45rem; margin-bottom: 1rem; }
  .diff-label { font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding-top: 3px; }
  .diff-label--expected { color: var(--pass); }
  .diff-label--actual { color: var(--fail); }
  .diff-text { font-size: 0.85rem; color: var(--text-dim); line-height: 1.55; margin: 0; }

  /* Footer: AI meta left, buttons right, separated by a hair-line */
  .issue-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 0.9rem; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .ai-meta { display: flex; align-items: center; gap: 0.55rem; cursor: help; }
  .ai-badge { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--ai-bright); font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; }
  .ai-badge svg { filter: drop-shadow(0 0 5px var(--ai-glow)); }
  .ai-dot { color: var(--text-subtle); }
  .confidence-bar { width: 64px; height: 4px; background: var(--bg-elev-3); border-radius: 999px; overflow: hidden; }
  .confidence-fill { height: 100%; background: linear-gradient(90deg, var(--ai), var(--ai-bright)); border-radius: 999px; box-shadow: 0 0 6px var(--ai-glow); }
  .confidence-value { font-size: 0.74rem; color: var(--ai-bright); font-weight: 700; font-variant-numeric: tabular-nums; }

  .issue-actions { display: flex; gap: 0.45rem; flex-wrap: wrap; }
  .copy-btn { display: inline-flex; align-items: center; gap: 0.4rem; background: transparent; border: 1px solid var(--border); color: var(--text-dim); padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.74rem; font-weight: 600; transition: all 0.15s; text-decoration: none; cursor: pointer; }
  .copy-btn:hover { border-color: var(--border-strong); color: var(--text); }
  .copy-btn.copied { border-color: var(--pass); color: var(--pass); }
  .copy-btn--primary { border-color: rgba(56, 189, 248, 0.45); color: var(--ai-bright); }
  .copy-btn--primary:hover { border-color: var(--ai-bright); background: rgba(56, 189, 248, 0.08); }

  /* Screenshot: small thumbnail on the right, click to lightbox */
  .issue-snapshot { display: block; padding: 0; background: none; border: 0; cursor: zoom-in; width: 100%; }
  .issue-snapshot img { width: 100%; max-height: 260px; object-fit: cover; object-position: top; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); transition: border-color 0.15s, transform 0.15s; display: block; }
  .issue-snapshot:hover img { border-color: var(--ai-bright); transform: translateY(-1px); }

  .no-issues { padding: 1.35rem 1.6rem; background: rgba(0, 245, 160, 0.05); border: 1px solid rgba(0, 245, 160, 0.25); border-radius: var(--radius); color: var(--pass); font-size: 0.92rem; font-weight: 600; }

  /* ---- Timeline ---- */
  .timeline { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .step { display: grid; grid-template-columns: 44px 1fr 120px; gap: 1rem; padding: 1rem 1.35rem; border-bottom: 1px solid var(--border); align-items: center; transition: background 0.1s; scroll-margin-top: 1rem; }
  .step:last-child { border-bottom: none; }
  .step:hover { background: var(--bg-elev-2); }
  .step.hidden { display: none; }
  .step--issue { background: rgba(255, 61, 113, 0.035); border-left: 3px solid var(--fail); padding-left: calc(1.35rem - 3px); }
  .step--failure { background: rgba(255, 61, 113, 0.02); }
  .step-number { font-size: 0.72rem; font-weight: 700; color: var(--text-subtle); background: var(--bg-elev-2); border: 1px solid var(--border); width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
  .step--issue .step-number { color: var(--fail); border-color: var(--fail); background: rgba(255, 61, 113, 0.08); }
  .step-content { min-width: 0; }
  .step-action { font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 0.82rem; color: var(--text); word-break: break-word; }
  .step-tool { color: var(--ai-bright); font-weight: 600; }
  .arg-key { color: var(--text-dim); }
  .arg-val { color: var(--pass); }
  .step-result { font-size: 0.8rem; color: var(--text-dim); margin-top: 0.35rem; word-break: break-word; }
  .step--issue .step-result { color: var(--fail); }
  .step--failure .step-result { color: var(--fail); }
  .step-img { justify-self: end; }
  .step-screenshot { width: 104px; max-height: 200px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; display: block; transition: transform 0.15s, border-color 0.15s; }
  .step-screenshot:hover { border-color: var(--ai-bright); transform: translateY(-1px); }
  .step-screenshot--missing { width: 104px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: var(--text-subtle); background: var(--bg-elev-2); border: 1px dashed var(--border); }

  /* ---- Lightbox ---- */
  .lightbox { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.92); display: none; align-items: center; justify-content: center; z-index: 100; padding: 2rem; cursor: zoom-out; backdrop-filter: blur(6px); }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 30px 80px rgba(0,0,0,0.7); }
  .lightbox-close { position: absolute; top: 1.5rem; right: 1.5rem; color: #fff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); width: 40px; height: 40px; border-radius: 50%; font-size: 1.2rem; display: flex; align-items: center; justify-content: center; }
  .lightbox-close:hover { background: rgba(255,255,255,0.18); }

  /* ---- Cmd+K search modal ---- */
  .search-modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: none; align-items: flex-start; justify-content: center; z-index: 200; padding: 10vh 1.5rem 2rem; backdrop-filter: blur(8px); }
  .search-modal.open { display: flex; }
  .search-box { width: 100%; max-width: 640px; background: var(--bg-elev); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow); overflow: hidden; }
  .search-input-wrap { display: flex; align-items: center; gap: 0.75rem; padding: 1.1rem 1.35rem; border-bottom: 1px solid var(--border); }
  .search-input-wrap svg { color: var(--text-subtle); flex-shrink: 0; }
  .search-input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--text); font-size: 1rem; font-family: inherit; }
  .search-input::placeholder { color: var(--text-subtle); }
  .search-hint { font-size: 0.72rem; color: var(--text-subtle); }
  .search-results { max-height: 55vh; overflow-y: auto; padding: 0.5rem; }
  .search-result { display: flex; gap: 0.75rem; align-items: center; padding: 0.7rem 0.9rem; border-radius: 8px; color: var(--text-dim); font-size: 0.85rem; cursor: pointer; border-left: 2px solid transparent; }
  .search-result:hover, .search-result.selected { background: var(--bg-elev-2); color: var(--text); border-left-color: var(--ai-bright); }
  .search-result-num { font-size: 0.7rem; color: var(--text-subtle); min-width: 24px; font-variant-numeric: tabular-nums; }
  .search-result-body { flex: 1; min-width: 0; overflow: hidden; }
  .search-result-tool { font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 0.78rem; color: var(--ai-bright); }
  .search-result-preview { font-size: 0.76rem; color: var(--text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .search-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-subtle); font-size: 0.85rem; }

  /* ---- Footer ---- */
  .footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--text-subtle); font-size: 0.78rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; }

  @media (max-width: 720px) {
    .container { padding: 1.5rem 1rem 3rem; }
    .header { flex-direction: column; align-items: flex-start; gap: 1rem; }
    .step { grid-template-columns: 36px 1fr; }
    .step-img { grid-column: 1 / -1; justify-self: start; margin-top: 0.25rem; }
  }
</style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div>
        <div class="brand"><span class="brand-dot"></span>AppCrawl</div>
        <h1>Test Report</h1>
        <div class="title-sub">${esc(report.bundleId)} · ${esc(report.mode)} mode</div>
      </div>
      ${statusBadge}
    </header>

    <div class="command-bar">
      <button class="search-trigger" id="search-trigger" aria-label="Open search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        Search steps, tools, results, issues…
        <span class="kbd"><span>⌘</span><span>K</span></span>
      </button>
    </div>

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
    <div class="filter-bar" id="filter-bar">
      <button class="chip active" data-filter="all">All <span class="chip-count" data-count="all"></span></button>
      <button class="chip" data-filter="issues">#issues <span class="chip-count" data-count="issues"></span></button>
      <button class="chip" data-filter="failures">#failures <span class="chip-count" data-count="failures"></span></button>
      <button class="chip" data-filter="tap">#taps <span class="chip-count" data-count="tap"></span></button>
      <button class="chip" data-filter="type">#typing <span class="chip-count" data-count="type"></span></button>
      <button class="chip" data-filter="nav">#navigation <span class="chip-count" data-count="nav"></span></button>
      <button class="chip" data-filter="wait">#waits <span class="chip-count" data-count="wait"></span></button>
    </div>
    <div class="timeline" id="timeline">${timelineSteps}</div>

    <footer class="footer">
      <div>Generated by AppCrawl · ${esc(formatTimestamp(report.timestamp))}</div>
      <div>${report.summary.totalActions} actions · ${durationLabel} · Press <span class="kbd"><span>⌘</span><span>K</span></span> to search</div>
    </footer>
  </div>

  <!-- Lightbox -->
  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" aria-label="Close">×</button>
    <img src="" alt="" />
  </div>

  <!-- Cmd+K search modal -->
  <div class="search-modal" id="search-modal">
    <div class="search-box">
      <div class="search-input-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="text" class="search-input" id="search-input" placeholder="Find a step, tool, or result..." autocomplete="off" spellcheck="false" />
        <span class="search-hint">ESC to close</span>
      </div>
      <div class="search-results" id="search-results"></div>
    </div>
  </div>

  <script>
    (function() {
      // ---- Lightbox ----
      const lightbox = document.getElementById('lightbox');
      const lightboxImg = lightbox.querySelector('img');
      const lightboxClose = lightbox.querySelector('.lightbox-close');
      function openLightbox(src, alt) {
        lightboxImg.src = src;
        lightboxImg.alt = alt || '';
        lightbox.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function closeLightbox() {
        lightbox.classList.remove('open');
        lightboxImg.src = '';
        document.body.style.overflow = '';
      }
      document.querySelectorAll('[data-lightbox]').forEach(function(el) {
        el.addEventListener('click', function() {
          const img = el.tagName === 'IMG' ? el : el.querySelector('img');
          if (img && img.src) openLightbox(img.src, img.alt);
        });
      });
      lightbox.addEventListener('click', function(e) {
        if (e.target === lightbox || e.target === lightboxClose) closeLightbox();
      });

      // ---- Filter chips ----
      const filterBar = document.getElementById('filter-bar');
      const allSteps = Array.from(document.querySelectorAll('#timeline .step'));

      // Populate counts
      filterBar.querySelectorAll('[data-count]').forEach(function(el) {
        const tag = el.getAttribute('data-count');
        const count = allSteps.filter(function(s) {
          return s.getAttribute('data-filter').split(' ').indexOf(tag) !== -1;
        }).length;
        el.textContent = count;
      });

      function applyFilter(tag) {
        allSteps.forEach(function(step) {
          const tags = step.getAttribute('data-filter').split(' ');
          step.classList.toggle('hidden', tags.indexOf(tag) === -1);
        });
        filterBar.querySelectorAll('.chip').forEach(function(c) {
          c.classList.toggle('active', c.getAttribute('data-filter') === tag);
        });
      }
      filterBar.addEventListener('click', function(e) {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        applyFilter(chip.getAttribute('data-filter'));
      });

      // ---- Copy buttons ----
      // Skip anchors without data-copy — those are real links (e.g. the
      // Jira deep-link button) and should follow their href naturally.
      document.querySelectorAll('.copy-btn[data-copy]').forEach(function(btn) {
        btn.addEventListener('click', function(ev) {
          ev.preventDefault();
          const payload = btn.getAttribute('data-copy');
          if (!payload) return;
          navigator.clipboard.writeText(payload).then(function() {
            const original = btn.innerHTML;
            btn.classList.add('copied');
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied';
            setTimeout(function() {
              btn.classList.remove('copied');
              btn.innerHTML = original;
            }, 1500);
          });
        });
      });

      // ---- Cmd+K omnisearch ----
      const searchModal = document.getElementById('search-modal');
      const searchInput = document.getElementById('search-input');
      const searchResults = document.getElementById('search-results');
      const searchTrigger = document.getElementById('search-trigger');
      let selectedIdx = 0;
      let currentMatches = [];

      function renderResults(query) {
        const q = query.trim().toLowerCase();
        currentMatches = q.length === 0
          ? allSteps.slice(0, 20)
          : allSteps.filter(function(s) {
              return s.getAttribute('data-search').indexOf(q) !== -1;
            });
        selectedIdx = 0;

        if (currentMatches.length === 0) {
          searchResults.innerHTML = '<div class="search-empty">No matches for "' + escapeHtml(query) + '"</div>';
          return;
        }

        searchResults.innerHTML = currentMatches.slice(0, 50).map(function(step, i) {
          const num = step.getAttribute('data-step');
          const tool = step.getAttribute('data-tool');
          const result = step.querySelector('.step-result');
          const preview = result ? result.textContent.slice(0, 90) : '';
          return '<div class="search-result' + (i === 0 ? ' selected' : '') + '" data-target="step-' + num + '">'
            + '<span class="search-result-num">' + num + '</span>'
            + '<div class="search-result-body">'
            + '<div class="search-result-tool">' + escapeHtml(tool) + '</div>'
            + '<div class="search-result-preview">' + escapeHtml(preview) + '</div>'
            + '</div></div>';
        }).join('');
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }

      function openSearch() {
        searchModal.classList.add('open');
        document.body.style.overflow = 'hidden';
        searchInput.value = '';
        renderResults('');
        setTimeout(function() { searchInput.focus(); }, 50);
      }
      function closeSearch() {
        searchModal.classList.remove('open');
        document.body.style.overflow = '';
      }
      function jumpTo(targetId) {
        closeSearch();
        const el = document.getElementById(targetId);
        if (!el) return;
        // Temporarily clear filter so the target is visible
        if (el.classList.contains('hidden')) applyFilter('all');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background 0.6s';
        const prev = el.style.background;
        el.style.background = 'rgba(56, 189, 248, 0.15)';
        setTimeout(function() { el.style.background = prev; }, 900);
      }

      searchTrigger.addEventListener('click', openSearch);
      searchInput.addEventListener('input', function() { renderResults(searchInput.value); });
      searchResults.addEventListener('click', function(e) {
        const row = e.target.closest('.search-result');
        if (row) jumpTo(row.getAttribute('data-target'));
      });
      searchModal.addEventListener('click', function(e) {
        if (e.target === searchModal) closeSearch();
      });

      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIdx = Math.min(selectedIdx + 1, currentMatches.length - 1);
          updateSelection();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIdx = Math.max(selectedIdx - 1, 0);
          updateSelection();
        } else if (e.key === 'Enter' && currentMatches[selectedIdx]) {
          e.preventDefault();
          jumpTo('step-' + currentMatches[selectedIdx].getAttribute('data-step'));
        }
      });
      function updateSelection() {
        const rows = searchResults.querySelectorAll('.search-result');
        rows.forEach(function(r, i) { r.classList.toggle('selected', i === selectedIdx); });
        if (rows[selectedIdx]) rows[selectedIdx].scrollIntoView({ block: 'nearest' });
      }

      // ---- Global keyboard shortcuts ----
      document.addEventListener('keydown', function(e) {
        const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
        const isSlash = e.key === '/' && document.activeElement.tagName !== 'INPUT';
        if (isCmdK || isSlash) {
          e.preventDefault();
          openSearch();
        }
        if (e.key === 'Escape') {
          if (searchModal.classList.contains('open')) closeSearch();
          else if (lightbox.classList.contains('open')) closeLightbox();
        }
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Confidence for the "AI Remediation" box.
 *
 * Heuristic derived from severity + whether the agent marked the test as
 * failed. Not a real ML confidence score — it's a visual indicator that
 * lets the UI component render consistently. A real confidence value
 * would need a per-issue LLM follow-up call that asks the model to rate
 * how certain it is about the finding.
 */
function computeConfidence(
  issue: { severity: string; expected: string; actual: string },
  report: Report,
): number {
  const hasBothSides = issue.expected.length > 0 && issue.actual.length > 0;
  const testFailed = report.summary.testResult?.status === "fail";
  if (issue.severity === "critical") return testFailed ? 95 : 88;
  if (issue.severity === "major") return hasBothSides ? 78 : 70;
  return hasBothSides ? 60 : 50;
}

/**
 * Build a self-contained markdown prompt that an external coding agent
 * (Claude Code, Cursor, Aider, etc.) can execute directly to diagnose
 * and fix the issue. Includes: context, bug description, the
 * reproduction trace from the last few UI actions, and a
 * `appcrawl run` command the agent can use to verify its fix in a
 * fix→test loop.
 *
 * We keep this template-based (no per-issue LLM call) because:
 *   1. It keeps report generation free and offline
 *   2. The downstream agent is the one that should be thinking —
 *      we're handing it facts, not conclusions
 */
function buildFixPrompt(
  issue: { step: number; severity: string; description: string; expected: string; actual: string },
  report: Report,
): string {
  // Reproduction trace: the last ~6 UI actions leading up to the issue.
  // Filter to meaningful interactions (skip waits and meta actions) so
  // the trace reads like a test script.
  const upToIssue = report.actions.filter((a) => a.step <= issue.step);
  const meaningful = upToIssue.filter(
    (a) => a.tool !== "wait" && a.tool !== "report_issue" && a.tool !== "mark_complete",
  );
  const trace = meaningful.slice(-6);
  const traceLines = trace.map((a) => {
    const paramStr = Object.entries(a.params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    const marker = a.step === issue.step ? "  ← bug appeared after this action" : "";
    return `Step ${a.step}: ${a.tool}(${paramStr})${marker}`;
  });

  const goalSection = report.instruction
    ? `- **Test goal:** ${report.instruction}\n`
    : "";

  const verifyCommand =
    report.mode === "steered" && report.instruction
      ? `appcrawl run "${report.instruction}" --app ${report.bundleId} --ci`
      : `appcrawl run "verify fix: ${issue.description}" --app ${report.bundleId} --ci`;

  return `# Bug found by AppCrawl — fix prompt

You are a software engineer fixing a bug in a mobile app. AppCrawl — an AI-driven UI tester that autonomously explores apps and reports issues — found the following problem during a test run. Your job is to diagnose, fix, and verify.

## Context

- **App bundle ID:** \`${report.bundleId}\`
- **Test mode:** ${report.mode}
${goalSection}- **Step where bug was found:** ${issue.step}

## The bug

**[${issue.severity.toUpperCase()}]** ${issue.description}

### Expected behavior
${issue.expected}

### Actual behavior
${issue.actual}

## Reproduction trace

These are the UI actions AppCrawl performed leading up to the bug:

\`\`\`
${traceLines.join("\n")}
\`\`\`

## Your task

1. **Locate the root cause.** Search the codebase for distinctive strings from the "Actual behavior" (error messages, component names, log prefixes). Trace from there to the code path that produced the unwanted behavior.
2. **Propose a minimal fix.** Keep the scope small. Don't refactor unrelated code or add features.
3. **Implement the fix** in the smallest number of files possible.
4. **Verify with AppCrawl.** Once your fix is applied and the app is rebuilt, re-run the tester:
   \`\`\`bash
   ${verifyCommand}
   \`\`\`
   A clean exit (no blocking issues, exit code 0) means the fix works. If AppCrawl still reports the same issue, iterate.
5. **Report back** with: root cause analysis, the diff you applied, and the result of the verification run.

## Notes

- AppCrawl tests the real app running on a simulator/emulator — not a mocked environment. Your fix needs to work in the actual runtime.
- If you cannot reproduce the bug locally, the reproduction trace above shows exactly what actions AppCrawl took. Walk through them manually on your own simulator.
- If the bug description is ambiguous, favor a defensive fix (handle the edge case gracefully) over a permissive one (ignore it).
`;
}

/**
 * Render the "Create Jira issue" button for an issue card.
 *
 * Two modes:
 *   - Configured: opens a pre-filled Jira create-issue URL in a new tab.
 *     Uses the Atlassian deep link with ?summary, ?description, ?pid
 *     query params. No API token or CORS needed — the user just lands
 *     on the create form with everything typed out.
 *   - Unconfigured: falls back to a "Copy as Jira markdown" button that
 *     puts wiki-flavored markup on the clipboard so the user can paste
 *     into any Jira instance.
 */
function renderJiraButton(
  issue: { step: number; severity: string; description: string; expected: string; actual: string },
  report: Report,
  jira: JiraConfig | undefined,
): string {
  const icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`;
  if (jira?.url) {
    const url = buildJiraUrl(issue, report, jira);
    return `<a class="copy-btn" href="${esc(url)}" target="_blank" rel="noopener" title="Open Jira's create-issue form with this bug pre-filled">${icon}Create Jira issue</a>`;
  }
  const jiraMarkdown = buildJiraMarkdown(issue, report);
  return `<button class="copy-btn" data-copy="${esc(jiraMarkdown)}" title="Copy as Jira wiki markup — paste into any Jira 'Create issue' form">${icon}Copy as Jira</button>`;
}

/**
 * Build an Atlassian deep link that pre-fills the create-issue form.
 * https://YOUR.atlassian.net/secure/CreateIssueDetails!init.jspa
 *   ?pid=<projectKey>&summary=<encoded>&description=<encoded>&issuetype=Bug
 *
 * We use the project KEY (not pid, which is a numeric id) because users
 * can copy it out of their Jira URL bar; numeric pid would require an
 * API call we explicitly want to avoid.
 */
function buildJiraUrl(
  issue: { step: number; severity: string; description: string; expected: string; actual: string },
  report: Report,
  jira: JiraConfig,
): string {
  const base = jira.url.replace(/\/$/, "");
  const summary = `[${issue.severity.toUpperCase()}] ${issue.description}`;
  const description = buildJiraMarkdown(issue, report);
  const params = new URLSearchParams();
  if (jira.project) params.set("pid", jira.project);
  params.set("summary", summary);
  params.set("description", description);
  params.set("issuetype", jira.issueType ?? "Bug");
  return `${base}/secure/CreateIssueDetails!init.jspa?${params.toString()}`;
}

/**
 * Jira wiki markup for the issue body. Used for both the deep-link
 * `description` param and the clipboard fallback.
 */
function buildJiraMarkdown(
  issue: { step: number; severity: string; description: string; expected: string; actual: string },
  report: Report,
): string {
  const upToIssue = report.actions.filter((a) => a.step <= issue.step);
  const meaningful = upToIssue.filter(
    (a) => a.tool !== "wait" && a.tool !== "report_issue" && a.tool !== "mark_complete",
  );
  const trace = meaningful.slice(-6).map((a) => {
    const params = Object.entries(a.params)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    return `Step ${a.step}: ${a.tool}(${params})`;
  });
  const goalLine = report.instruction ? `*Test goal:* ${report.instruction}\n` : "";
  return `*Found by AppCrawl* (AI-driven UI tester)

*App:* {{${report.bundleId}}}
*Mode:* ${report.mode}
${goalLine}*Step:* ${issue.step}
*Severity:* ${issue.severity}

h3. Expected
${issue.expected}

h3. Actual
${issue.actual}

h3. Reproduction trace
{code}
${trace.join("\n")}
{code}
`;
}

/**
 * Group tool names into filter-chip categories. Used by the client-side
 * filter bar on the timeline (e.g. "#taps" shows only tap-ish actions).
 */
function categorizeAction(tool: string): string {
  if (tool === "tap" || tool === "tap_coordinates" || tool === "tap_and_type") return "tap";
  if (tool === "type_text") return "type";
  if (tool === "scroll" || tool === "navigate_back") return "nav";
  if (tool === "wait") return "wait";
  if (tool === "report_issue" || tool === "mark_complete" || tool === "assert_visible") return "meta";
  return "other";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JUnit XML for CI pipeline integration. Each issue becomes a
 * <failure>; a failed mark_complete becomes a failed testcase;
 * a clean run emits a single passing testcase.
 */
function renderJunit(report: Report): string {
  const suiteName = `appcrawl.${report.mode}`;
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
<testsuites name="appcrawl" tests="${tests}" failures="${failures}" time="${report.duration}">
  <testsuite name="${esc(suiteName)}" tests="${tests}" failures="${failures}" time="${report.duration}" timestamp="${report.timestamp}">
    <testcase classname="${esc(suiteName)}" name="${esc(testName)}" time="${report.duration}">
${failureNode}    </testcase>
  </testsuite>
</testsuites>
`;
}

export function printConsoleSummary(state: AgentState, mode: string): void {
  console.log("\n" + "=".repeat(50));
  console.log("  APPCRAWL TEST REPORT");
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
