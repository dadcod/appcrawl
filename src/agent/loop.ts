import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { DeviceDriver, ElementNode } from "../driver/types.js";
import { findElementByLabel, flattenTree, treeFingerprint } from "../driver/types.js";
import type { MaestroDriver } from "../driver/maestro.js";
import { agentTools } from "./tools.js";
import { AgentState } from "./state.js";
import { explorePrompt, steeredPrompt, summarizeInteractive } from "./prompts.js";
import { resolveModel, DEFAULTS } from "../config/defaults.js";

export interface LoopOptions {
  driver: DeviceDriver;
  bundleId: string;
  mode: "explore" | "steered";
  instruction?: string;
  maxSteps: number;
  model?: string;
  verbose: boolean;
  screenshotDir: string;
  appContext?: string;
}

export interface LoopResult {
  state: AgentState;
  completed: boolean;
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { driver, bundleId, mode, instruction, maxSteps, verbose, screenshotDir, appContext } =
    options;

  const state = new AgentState();
  const model = createModel(options.model);
  const systemPrompt =
    mode === "explore"
      ? explorePrompt(appContext)
      : steeredPrompt(instruction ?? "Explore the app", appContext);

  // Launch the app
  log(verbose, "Launching app...");
  await driver.launchApp(bundleId);
  log(verbose, "Waiting for app to load...");
  await sleep(5000);

  let completed = false;

  for (let step = 1; step <= maxSteps; step++) {
    log(verbose, `\n--- Step ${step}/${maxSteps} ---`);

    // 1. Observe: screenshot + accessibility tree
    const [screenshot, tree] = await Promise.all([
      driver.screenshot(),
      driver.accessibilityTree().catch(() => [] as ElementNode[]),
    ]);

    // Save screenshot
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(screenshotDir, { recursive: true });
    const screenshotPath = `${screenshotDir}/step-${step}.png`;
    await writeFile(screenshotPath, screenshot);

    // Identify current screen from tree
    const screenId = identifyScreen(tree);
    if (screenId) {
      state.recordScreen(screenId);
    }

    // 2. Build prompt
    const targetsText = tree.length > 0
      ? summarizeInteractive(tree)
      : "(accessibility tree unavailable — read the screenshot and use tap_coordinates)";
    const stateText = state.summary();

    const userMessage = [
      `Step ${step}/${maxSteps}`,
      "",
      stateText,
      "",
      "Interactive elements on screen (pass the label to tap/tap_and_type):",
      targetsText,
      "",
      "Choose your next action.",
    ].join("\n");

    log(verbose, `Screen: ${screenId ?? "unknown"}`);

    // 3. Think: call LLM
    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: userMessage },
              { type: "image", image: screenshot, mimeType: "image/png" },
            ],
          },
        ],
        tools: agentTools,
        toolChoice: "required",
        maxSteps: 1,
      });

      // 4. Act: execute tool calls
      if (result.toolCalls.length === 0) {
        log(verbose, "LLM returned no tool call, retrying...");
        state.recordAction(step, "none", {}, "No action returned");
        continue;
      }

      const toolCall = result.toolCalls[0];
      log(verbose, `Action: ${toolCall.toolName}(${JSON.stringify(toolCall.args)})`);

      const preFingerprint = treeFingerprint(tree);

      let actionResult = await executeAction(
        toolCall.toolName,
        toolCall.args as Record<string, unknown>,
        driver,
        tree,
        step,
        state,
        screenshotPath,
      );

      // Screen-change detection: if the action claimed success but the
      // accessibility tree is byte-identical afterward, annotate the
      // result. Phrased as an observation rather than a verdict —
      // selection/toggle actions often update only visual state and
      // "no effect" phrasing trains the LLM to abandon successful taps.
      if (!isFailureResult(actionResult) && !isTerminalAction(toolCall.toolName)) {
        await sleep(DEFAULTS.screenshotDelay);
        const postTree = await driver
          .accessibilityTree()
          .catch(() => null as ElementNode[] | null);
        if (postTree && treeFingerprint(postTree) === preFingerprint) {
          actionResult = `${actionResult} [a11y tree unchanged — tap may have updated visual-only state like a selection; check the next screenshot before assuming it failed]`;
        }
      }

      state.recordAction(
        step,
        toolCall.toolName,
        toolCall.args as Record<string, unknown>,
        actionResult,
      );
      log(verbose, `Result: ${actionResult}`);

      // Check if test is complete
      if (state.testResult) {
        completed = true;
        log(verbose, `\nTest ${state.testResult.status}: ${state.testResult.reason}`);
        break;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log(verbose, `Error: ${msg}`);
      state.recordAction(step, "error", {}, msg);

      if (msg.includes("credit balance") || msg.includes("authentication") || msg.includes("401")) {
        log(verbose, "API key issue — stopping.");
        console.error(`\nAPI error: ${msg}`);
        break;
      }

      if (msg.includes("rate limit") || msg.includes("429")) {
        log(verbose, "Rate limited, waiting 5s...");
        await sleep(5000);
      }
    }
  }

  return { state, completed };
}

async function executeAction(
  toolName: string,
  args: Record<string, unknown>,
  driver: DeviceDriver,
  tree: ElementNode[],
  step: number,
  state: AgentState,
  screenshotPath: string,
): Promise<string> {
  try {
    return await executeActionInner(toolName, args, driver, tree, step, state, screenshotPath);
  } catch (e: unknown) {
    // Centralized driver error handling: every Maestro/driver failure becomes
    // a readable tool result so the LLM can see what went wrong and adapt.
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed: ${msg}`;
  }
}

async function executeActionInner(
  toolName: string,
  args: Record<string, unknown>,
  driver: DeviceDriver,
  tree: ElementNode[],
  step: number,
  state: AgentState,
  screenshotPath: string,
): Promise<string> {
  switch (toolName) {
    case "tap": {
      const selector = args.element as string;
      // Prefer Maestro's semantic tap (works by label/text matching)
      if ("tapOn" in driver) {
        const maestro = driver as MaestroDriver;
        // If it looks like a testID (contains hyphens, no spaces), try tapById first
        const isTestId = selector.includes("-") && !selector.includes(" ");
        if (isTestId) {
          try {
            await maestro.tapById(selector);
            return `Tapped by testID "${selector}"`;
          } catch {
            // Fall through to text-based tap
          }
        }
        await maestro.tapOn(selector);
        return `Tapped "${selector}"`;
      }
      // Fallback: resolve from accessibility tree
      const element = findElementByLabel(tree, selector);
      if (!element) {
        const available = flattenTree(tree)
          .filter((n) => n.label)
          .map((n) => n.label)
          .slice(0, 20);
        return `Element "${selector}" not found. Available: ${available.join(", ")}`;
      }
      const { frameCenterX, frameCenterY } = await import("../driver/types.js");
      await driver.tap(frameCenterX(element.frame), frameCenterY(element.frame));
      return `Tapped "${element.label}"`;
    }

    case "tap_coordinates": {
      await driver.tap(args.x as number, args.y as number);
      return `Tapped at (${args.x}, ${args.y})`;
    }

    case "type_text": {
      await driver.typeText(args.text as string);
      return `Typed "${args.text}"`;
    }

    case "tap_and_type": {
      const field = args.element as string;
      const text = args.text as string;
      if ("tapAndType" in driver) {
        await (driver as MaestroDriver).tapAndType(field, text);
        return `Tapped "${field}" and typed "${text}"`;
      }
      // Fallback: tap then type
      const el = findElementByLabel(tree, field);
      if (el) {
        const { frameCenterX, frameCenterY } = await import("../driver/types.js");
        await driver.tap(frameCenterX(el.frame), frameCenterY(el.frame));
      }
      await driver.typeText(text);
      return `Tapped "${field}" and typed "${text}"`;
    }

    case "navigate_back": {
      // iOS back swipe: left edge to center (using percentage coordinates)
      await driver.swipe(2, 50, 50, 50, 0.3);
      return "Swiped back";
    }

    case "scroll": {
      const dir = args.direction as string;
      // Use percentage coordinates for swipe (0-100)
      const swipeMap: Record<string, [number, number, number, number]> = {
        up: [50, 70, 50, 30],
        down: [50, 30, 50, 70],
        left: [80, 50, 20, 50],
        right: [20, 50, 80, 50],
      };
      const [x1, y1, x2, y2] = swipeMap[dir] ?? swipeMap.down;
      await driver.swipe(x1, y1, x2, y2);
      return `Scrolled ${dir}`;
    }

    case "wait": {
      const seconds = args.seconds as number;
      await sleep(seconds * 1000);
      return `Waited ${seconds}s`;
    }

    case "assert_visible": {
      const text = args.text as string;
      const found = findElementByLabel(tree, text);
      if (found) {
        return `PASS: "${text}" is visible`;
      }
      return `FAIL: "${text}" is not visible on screen`;
    }

    case "report_issue": {
      state.recordIssue(
        step,
        args.severity as "critical" | "major" | "minor",
        args.description as string,
        args.expected as string,
        args.actual as string,
        screenshotPath,
      );
      return `Issue reported: [${args.severity}] ${args.description}`;
    }

    case "mark_complete": {
      state.markComplete(args.status as "pass" | "fail", args.reason as string, step);
      return `Test marked as ${args.status}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

function identifyScreen(tree: ElementNode[]): string | null {
  if (tree.length === 0) return null;
  // Use the root element's label or type as screen identifier
  const root = tree[0];
  return root.label ?? root.type ?? null;
}

function createModel(modelFlag?: string): LanguageModel {
  const { provider, modelId } = resolveModel(modelFlag);

  switch (provider) {
    case "openai":
      return createOpenAI()(modelId);
    case "google":
      return createGoogleGenerativeAI()(modelId);
    case "openrouter": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createOpenRouter } = require("@openrouter/ai-sdk-provider");
      return createOpenRouter()(modelId) as unknown as LanguageModel;
    }
    case "ollama": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ollama } = require("ollama-ai-provider");
      return ollama(modelId) as unknown as LanguageModel;
    }
    case "anthropic":
    default:
      return createAnthropic()(modelId);
  }
}

function isFailureResult(result: string): boolean {
  const lower = result.toLowerCase();
  return lower.startsWith("failed") || lower.startsWith("fail:");
}

/**
 * Actions that don't need screen-change detection: reporting, marking
 * complete, and asserts aren't expected to change the UI.
 */
function isTerminalAction(toolName: string): boolean {
  return (
    toolName === "mark_complete" ||
    toolName === "report_issue" ||
    toolName === "assert_visible" ||
    toolName === "wait"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(message);
  }
}
