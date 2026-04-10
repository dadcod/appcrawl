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

    // Detect repeated actions (loop warning)
    if (this.actions.length >= 3) {
      const last3 = this.actions.slice(-3);
      const sameAction = last3.every(
        (a) => a.tool === last3[0].tool && JSON.stringify(a.params) === JSON.stringify(last3[0].params),
      );
      if (sameAction) {
        lines.push("");
        lines.push("⚠️ WARNING: You have repeated the same action 3+ times. It is NOT working. You MUST try a completely different approach:");
        lines.push("  - If tapping by label fails, try tap_coordinates with x,y from the screenshot");
        lines.push("  - If a button/element is not responding, try a different element or navigate_back");
        lines.push("  - If stuck on a screen, try scrolling or swiping to reveal other options");
      }
    }

    return lines.join("\n");
  }
}
