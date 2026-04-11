/**
 * Regenerate the HTML report from an existing run's report.json.
 * Usage: npx tsx scripts/regen-report.mts <runDir>
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Recreate the AgentState shape the renderer expects, then call
// generateReport. Simpler: import the internal helpers directly.
import type { Report } from "../src/reporter/types.js";

const runDir = resolve(process.argv[2] ?? "");
if (!runDir) {
  console.error("Usage: npx tsx scripts/regen-report.mts <runDir>");
  process.exit(1);
}

const reportJson = JSON.parse(await readFile(join(runDir, "report.json"), "utf-8")) as Report;

// Inline-replicate renderHtml by importing the module and calling an
// exported version. But it's not exported — so we'll do a tiny shim:
// reconstruct an AgentState-like object and call generateReport, which
// regenerates all three output files.
const { AgentState } = await import("../src/agent/state.js");
const { generateReport } = await import("../src/reporter/reporter.js");

const state = new AgentState();
// generateReport recomputes duration as (now - startTime), so backdate
// startTime from *now* to preserve the original duration.
state.startTime = Date.now() - reportJson.duration * 1000;
for (const a of reportJson.actions) {
  state.actions.push({
    step: a.step,
    tool: a.tool,
    params: a.params,
    result: a.result,
    timestamp: a.timestamp,
  });
}
for (const s of reportJson.screens) {
  state.screens.set(s.name, { visitCount: s.visitCount, firstSeen: 0 });
}
for (const i of reportJson.issues) {
  state.issues.push(i);
}
if (reportJson.summary.testResult) {
  state.testResult = reportJson.summary.testResult;
}

await generateReport(state, {
  mode: reportJson.mode,
  instruction: reportJson.instruction,
  bundleId: reportJson.bundleId,
  model: reportJson.model,
  runDir,
});

console.log(`Regenerated: ${runDir}/report.html`);
