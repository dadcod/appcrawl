import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { PNG } from "pngjs";

/**
 * Visual regression: compare screenshots from two runs and produce
 * diff images highlighting pixel-level changes.
 *
 * Workflow:
 *   1. `appcrawl baseline <report-dir>` — save screenshots as the baseline
 *   2. Next `appcrawl suite --ci` run produces new screenshots
 *   3. `appcrawl visual-diff --baseline <dir> --current <dir>` — compare
 *
 * Or automatically: suite runs compare against the latest baseline if
 * one exists in `.appcrawl/baselines/<suite-name>/`.
 */

export interface DiffResult {
  file: string;
  /** 0-1 ratio of changed pixels */
  diffRatio: number;
  /** Absolute count of changed pixels */
  diffPixels: number;
  totalPixels: number;
  /** Path to the diff image (highlights changes in red) */
  diffImagePath: string | null;
  status: "pass" | "fail" | "new" | "missing";
}

export interface VisualDiffReport {
  results: DiffResult[];
  passed: number;
  failed: number;
  newScreens: number;
  threshold: number;
}

const DEFAULT_THRESHOLD = 0.005; // 0.5% pixel change = fail
const PIXEL_THRESHOLD = 0.1; // Per-pixel color distance threshold for pixelmatch

/**
 * Compare screenshots from two directories.
 *
 * @param baselineDir - Directory containing baseline screenshots
 * @param currentDir - Directory containing current run's screenshots
 * @param outputDir - Where to write diff images
 * @param threshold - Max allowed diff ratio (0-1), default 0.5%
 */
export async function compareScreenshots(
  baselineDir: string,
  currentDir: string,
  outputDir: string,
  threshold: number = DEFAULT_THRESHOLD,
): Promise<VisualDiffReport> {
  mkdirSync(outputDir, { recursive: true });

  const baselineFiles = existsSync(baselineDir)
    ? readdirSync(baselineDir).filter((f) => f.endsWith(".png"))
    : [];
  const currentFiles = existsSync(currentDir)
    ? readdirSync(currentDir).filter((f) => f.endsWith(".png"))
    : [];

  const allFiles = new Set([...baselineFiles, ...currentFiles]);
  const results: DiffResult[] = [];

  for (const file of allFiles) {
    const baselinePath = join(baselineDir, file);
    const currentPath = join(currentDir, file);

    if (!existsSync(baselinePath)) {
      // New screenshot with no baseline
      results.push({
        file,
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 0,
        diffImagePath: null,
        status: "new",
      });
      continue;
    }

    if (!existsSync(currentPath)) {
      // Baseline exists but current is missing (screen no longer visited)
      results.push({
        file,
        diffRatio: 1,
        diffPixels: 0,
        totalPixels: 0,
        diffImagePath: null,
        status: "missing",
      });
      continue;
    }

    const result = await diffImages(baselinePath, currentPath, join(outputDir, `diff-${file}`));
    results.push({
      ...result,
      file,
      status: result.diffRatio > threshold ? "fail" : "pass",
    });
  }

  // Sort: failures first, then new, then pass
  const order = { fail: 0, new: 1, missing: 2, pass: 3 };
  results.sort((a, b) => order[a.status] - order[b.status]);

  return {
    results,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    newScreens: results.filter((r) => r.status === "new").length,
    threshold,
  };
}

async function diffImages(
  baselinePath: string,
  currentPath: string,
  diffOutputPath: string,
): Promise<Pick<DiffResult, "diffRatio" | "diffPixels" | "totalPixels" | "diffImagePath">> {
  const baselineImg = PNG.sync.read(readFileSync(baselinePath));
  const currentImg = PNG.sync.read(readFileSync(currentPath));

  // If dimensions differ, resize to the larger canvas
  const width = Math.max(baselineImg.width, currentImg.width);
  const height = Math.max(baselineImg.height, currentImg.height);

  const baseline = padToSize(baselineImg, width, height);
  const current = padToSize(currentImg, width, height);

  const diff = new PNG({ width, height });
  const totalPixels = width * height;

  const pm = await import("pixelmatch");
  const pixelmatch = pm.default;

  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: PIXEL_THRESHOLD, includeAA: false },
  );

  const diffRatio = diffPixels / totalPixels;

  // Only write diff image if there are actual differences
  let diffImagePath: string | null = null;
  if (diffPixels > 0) {
    writeFileSync(diffOutputPath, PNG.sync.write(diff));
    diffImagePath = diffOutputPath;
  }

  return { diffRatio, diffPixels, totalPixels, diffImagePath };
}

/**
 * Pad a PNG to a target size (fills with transparent pixels).
 * Returns the original if already the right size.
 */
function padToSize(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;

  const padded = new PNG({ width, height, fill: true });
  // Fill with transparent
  padded.data.fill(0);
  // Copy original pixels
  PNG.bitblt(img, padded, 0, 0, img.width, img.height, 0, 0);
  return padded;
}

/**
 * Save screenshots from a report dir as a named baseline.
 */
export function saveBaseline(
  screenshotDir: string,
  baselineName: string,
  baselineRoot: string = ".appcrawl/baselines",
): string {
  const destDir = join(baselineRoot, baselineName);
  mkdirSync(destDir, { recursive: true });

  const files = readdirSync(screenshotDir).filter((f) => f.endsWith(".png"));
  for (const file of files) {
    copyFileSync(join(screenshotDir, file), join(destDir, file));
  }

  return destDir;
}

/**
 * Print a visual diff report to console.
 */
export function printDiffReport(report: VisualDiffReport): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  VISUAL REGRESSION REPORT");
  console.log(`${"=".repeat(60)}`);
  console.log(`  Threshold: ${(report.threshold * 100).toFixed(1)}% pixel change`);
  console.log("");

  for (const r of report.results) {
    const pct = (r.diffRatio * 100).toFixed(2);
    switch (r.status) {
      case "pass":
        console.log(`  [PASS] ${r.file} (${pct}% diff)`);
        break;
      case "fail":
        console.log(`  [FAIL] ${r.file} — ${pct}% changed (${r.diffPixels} pixels)`);
        if (r.diffImagePath) {
          console.log(`         diff: ${r.diffImagePath}`);
        }
        break;
      case "new":
        console.log(`  [NEW]  ${r.file} — no baseline to compare`);
        break;
      case "missing":
        console.log(`  [GONE] ${r.file} — in baseline but not in current run`);
        break;
    }
  }

  console.log("");
  console.log(`  ${report.passed} passed, ${report.failed} failed, ${report.newScreens} new`);
  console.log(`${"=".repeat(60)}`);
}
