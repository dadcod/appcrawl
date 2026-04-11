export interface ActionRecord {
  step: number;
  tool: string;
  params: Record<string, unknown>;
  result: string;
  timestamp: number;
}

export interface IssueRecord {
  step: number;
  severity: "critical" | "major" | "minor";
  description: string;
  expected: string;
  actual: string;
  screenshotPath: string | null;
}

export interface TestResult {
  status: "pass" | "fail";
  reason: string;
  step: number;
}

export class AgentState {
  screens = new Map<string, { visitCount: number; firstSeen: number }>();
  actions: ActionRecord[] = [];
  issues: IssueRecord[] = [];
  testResult: TestResult | null = null;
  startTime = Date.now();

  recordScreen(screenId: string): void {
    const existing = this.screens.get(screenId);
    if (existing) {
      existing.visitCount++;
    } else {
      this.screens.set(screenId, { visitCount: 1, firstSeen: Date.now() });
    }
  }

  recordAction(
    step: number,
    tool: string,
    params: Record<string, unknown>,
    result: string,
  ): void {
    this.actions.push({ step, tool, params, result, timestamp: Date.now() });
  }

  recordIssue(
    step: number,
    severity: "critical" | "major" | "minor",
    description: string,
    expected: string,
    actual: string,
    screenshotPath: string | null = null,
  ): void {
    this.issues.push({
      step,
      severity,
      description,
      expected,
      actual,
      screenshotPath,
    });
  }

  markComplete(status: "pass" | "fail", reason: string, step: number): void {
    this.testResult = { status, reason, step };
  }

  summary(): string {
    const lines: string[] = [];

    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    lines.push(`[Run: ${elapsed}s elapsed, ${this.actions.length} actions taken]`);

    if (this.screens.size > 0) {
      const screenList = Array.from(this.screens.entries())
        .map(([name, info]) => `${name} (${info.visitCount}x)`)
        .join(", ");
      lines.push(`[Screens visited: ${screenList}]`);
    }

    if (this.issues.length > 0) {
      lines.push(`[Issues found: ${this.issues.length}]`);
      for (const issue of this.issues) {
        lines.push(`  - [${issue.severity}] ${issue.description}`);
      }
    }

    // Last 5 actions for context
    const recent = this.actions.slice(-5);
    if (recent.length > 0) {
      lines.push("[Recent actions:]");
      for (const action of recent) {
        const paramStr = Object.entries(action.params)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
        lines.push(`  Step ${action.step}: ${action.tool}(${paramStr}) → ${action.result}`);
      }
    }

    // Detect repeated failing actions within the recent window.
    // The LLM can defeat naive "3-in-a-row" checks by inserting one
    // different action between retries, so we instead fingerprint the
    // last 6 actions and count how many times the *same failing target*
    // appears. This catches alternating-loop patterns too.
    const loopWarning = this.detectLoop();
    if (loopWarning) {
      lines.push("");
      lines.push(loopWarning);
      lines.push("You MUST change strategy now:");
      lines.push("  - STOP retrying the same element. It will not work.");
      lines.push("  - Try tap_coordinates with x,y read directly from the screenshot (percentages 0-100).");
      lines.push("  - Try scrolling or swiping to reveal other UI.");
      lines.push("  - Try navigate_back to return to a known screen.");
      lines.push("  - If genuinely stuck, call mark_complete with status=fail.");
    }

    return lines.join("\n");
  }

  /**
   * Returns a warning string if the agent appears stuck in a loop,
   * or null if recent actions look healthy.
   *
   * Heuristic: over the last 6 actions, if the same (tool, key-param)
   * fingerprint has failed 3+ times, we're in a loop — even if the
   * failures were interleaved with other actions.
   */
  private detectLoop(): string | null {
    const window = this.actions.slice(-6);
    if (window.length < 3) return null;

    const failureCounts = new Map<string, number>();
    for (const action of window) {
      if (!isFailure(action.result)) continue;
      const key = actionFingerprint(action);
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of failureCounts) {
      if (count >= 3) {
        return `⚠️ LOOP DETECTED: "${key}" has failed ${count} times in the last ${window.length} actions.`;
      }
    }

    // Also catch: many failures in a row, even across different targets
    const totalFailures = window.filter((a) => isFailure(a.result)).length;
    if (totalFailures >= 5) {
      return `⚠️ LOOP DETECTED: ${totalFailures} of the last ${window.length} actions failed.`;
    }

    return null;
  }
}

function isFailure(result: string): boolean {
  const lower = result.toLowerCase();
  return (
    lower.startsWith("failed") ||
    lower.startsWith("fail:") ||
    lower.includes("not found") ||
    lower.includes("error")
  );
}

/**
 * Reduce an action to a coarse key that groups retries of the same
 * conceptual target. For taps we use the element/selector; for typing
 * we use the field name; for coordinate taps we bucket by 10% cells so
 * tiny coordinate jitter still counts as the same target.
 */
function actionFingerprint(action: ActionRecord): string {
  const p = action.params;
  switch (action.tool) {
    case "tap":
    case "tap_and_type":
      return `${action.tool}:${String(p.element ?? "")}`;
    case "tap_coordinates": {
      const x = Math.round(Number(p.x ?? 0) / 10) * 10;
      const y = Math.round(Number(p.y ?? 0) / 10) * 10;
      return `tap_coordinates:~${x},${y}`;
    }
    case "type_text":
      return `type_text:${String(p.text ?? "")}`;
    case "scroll":
      return `scroll:${String(p.direction ?? "")}`;
    default:
      return `${action.tool}:${JSON.stringify(p)}`;
  }
}
