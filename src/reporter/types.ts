import type { ActionRecord, IssueRecord, TestResult } from "../agent/state.js";

export interface Report {
  timestamp: string;
  duration: number;
  mode: "explore" | "steered";
  instruction: string | null;
  bundleId: string;
  model: string;
  summary: {
    screensVisited: number;
    totalActions: number;
    issuesFound: number;
    testResult: TestResult | null;
  };
  screens: Array<{ name: string; visitCount: number }>;
  issues: IssueRecord[];
  actions: ActionRecord[];
}
