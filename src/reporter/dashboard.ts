import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Report } from "./types.js";

interface DashboardEntry {
  dir: string;
  report: Report;
  htmlPath: string;
  age: string;
}

/**
 * Generate a static HTML dashboard that indexes all reports in a directory.
 * Deployable to S3, Vercel, GH Pages, or just opened locally.
 */
export function generateDashboard(
  reportDir: string = "appcrawl-reports",
  outputPath?: string,
): string {
  const resolved = resolve(reportDir);
  const entries: DashboardEntry[] = [];

  if (!existsSync(resolved)) {
    throw new Error(`Report directory not found: ${resolved}`);
  }

  const dirs = readdirSync(resolved)
    .filter((d) => {
      const full = join(resolved, d);
      return statSync(full).isDirectory() && existsSync(join(full, "report.json"));
    })
    .sort()
    .reverse(); // newest first

  for (const dir of dirs) {
    try {
      const jsonPath = join(resolved, dir, "report.json");
      const report: Report = JSON.parse(readFileSync(jsonPath, "utf-8"));
      const htmlPath = join(dir, "report.html");
      const age = timeAgo(new Date(report.timestamp));
      entries.push({ dir, report, htmlPath, age });
    } catch {
      // Skip corrupt reports
    }
  }

  const html = renderDashboard(entries);
  const dest = outputPath ?? join(resolved, "index.html");
  writeFileSync(dest, html);
  return dest;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toISOString().slice(0, 10);
}

function renderDashboard(entries: DashboardEntry[]): string {
  const totalRuns = entries.length;
  const passed = entries.filter(
    (e) => e.report.summary.testResult?.status === "pass" || e.report.summary.issuesFound === 0,
  ).length;
  const failed = totalRuns - passed;
  const totalIssues = entries.reduce((sum, e) => sum + e.report.summary.issuesFound, 0);

  const rows = entries
    .map((e) => {
      const r = e.report;
      const status = r.summary.testResult?.status;
      const hasIssues = r.summary.issuesFound > 0;
      let badge: string;
      if (status === "pass") badge = '<span class="badge pass">PASS</span>';
      else if (status === "fail") badge = '<span class="badge fail">FAIL</span>';
      else if (hasIssues) badge = '<span class="badge warn">ISSUES</span>';
      else badge = '<span class="badge neutral">DONE</span>';

      const goal = r.instruction
        ? `<span class="goal">${escapeHtml(r.instruction.slice(0, 80))}${r.instruction.length > 80 ? "..." : ""}</span>`
        : '<span class="goal dim">Exploratory</span>';

      return `
        <tr onclick="window.open('${e.htmlPath}', '_blank')">
          <td>${badge}</td>
          <td>
            <div class="app">${escapeHtml(r.bundleId)}</div>
            <div class="meta">${r.mode} &middot; ${r.model}</div>
          </td>
          <td>${goal}</td>
          <td>${r.summary.screensVisited}</td>
          <td>${r.summary.totalActions}</td>
          <td>${r.summary.issuesFound}</td>
          <td>${r.duration}s</td>
          <td class="age">${e.age}</td>
        </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AppCrawl Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e0e0e0;
    --dim: #888;
    --blue: #0EA5E9;
    --green: #22c55e;
    --red: #ef4444;
    --amber: #f59e0b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 2rem;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .header h1 {
    font-size: 1.5rem;
    font-weight: 600;
  }
  .header .logo {
    font-size: 1.5rem;
  }
  .stats {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 2rem;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    min-width: 120px;
  }
  .stat .value {
    font-size: 2rem;
    font-weight: 700;
  }
  .stat .label {
    color: var(--dim);
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }
  .stat.pass .value { color: var(--green); }
  .stat.fail .value { color: var(--red); }
  .stat.issues .value { color: var(--amber); }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border-radius: 8px;
    overflow: hidden;
  }
  thead th {
    text-align: left;
    padding: 0.75rem 1rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    color: var(--dim);
    border-bottom: 1px solid var(--border);
  }
  tbody tr {
    cursor: pointer;
    transition: background 0.15s;
  }
  tbody tr:hover { background: rgba(14, 165, 233, 0.08); }
  tbody td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  tbody tr:last-child td { border-bottom: none; }
  .badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge.pass { background: rgba(34, 197, 94, 0.15); color: var(--green); }
  .badge.fail { background: rgba(239, 68, 68, 0.15); color: var(--red); }
  .badge.warn { background: rgba(245, 158, 11, 0.15); color: var(--amber); }
  .badge.neutral { background: rgba(136, 136, 136, 0.15); color: var(--dim); }
  .app { font-weight: 500; }
  .meta { color: var(--dim); font-size: 0.8rem; }
  .goal { font-size: 0.85rem; }
  .goal.dim { color: var(--dim); font-style: italic; }
  .age { color: var(--dim); white-space: nowrap; }
  .empty {
    text-align: center;
    padding: 3rem;
    color: var(--dim);
  }
  @media (max-width: 768px) {
    body { padding: 1rem; }
    .stats { flex-wrap: wrap; }
    table { font-size: 0.85rem; }
    th:nth-child(n+4), td:nth-child(n+4) { display: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="logo">S</div>
  <h1>AppCrawl Dashboard</h1>
</div>

<div class="stats">
  <div class="stat">
    <div class="value">${totalRuns}</div>
    <div class="label">Total Runs</div>
  </div>
  <div class="stat pass">
    <div class="value">${passed}</div>
    <div class="label">Passed</div>
  </div>
  <div class="stat fail">
    <div class="value">${failed}</div>
    <div class="label">Failed</div>
  </div>
  <div class="stat issues">
    <div class="value">${totalIssues}</div>
    <div class="label">Issues Found</div>
  </div>
</div>

${
  entries.length === 0
    ? '<div class="empty">No reports found. Run <code>appcrawl explore</code> or <code>appcrawl suite</code> to generate reports.</div>'
    : `
<table>
  <thead>
    <tr>
      <th>Status</th>
      <th>App</th>
      <th>Goal</th>
      <th>Screens</th>
      <th>Actions</th>
      <th>Issues</th>
      <th>Duration</th>
      <th>When</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>`
}

</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
