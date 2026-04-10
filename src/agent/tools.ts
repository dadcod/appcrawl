import { tool } from "ai";
import { z } from "zod";

export const agentTools = {
  tap: tool({
    description:
      "Tap on a UI element by its label, text, or accessibility identifier. The system will find the element on screen and tap its center.",
    parameters: z.object({
      element: z
        .string()
        .describe(
          "The label, text, or identifier of the element to tap (e.g. 'Settings', 'Log In', 'Submit button')",
        ),
    }),
  }),

  tap_coordinates: tool({
    description:
      "Tap at a screen position using PERCENTAGE coordinates (0-100). x=0 is left edge, x=100 is right edge. y=0 is top edge, y=100 is bottom edge. Example: a close button in the top-right corner would be roughly x=92, y=14. Use as fallback when tap-by-label fails.",
    parameters: z.object({
      x: z.number().min(0).max(100).describe("X position as percentage of screen width (0=left, 100=right)"),
      y: z.number().min(0).max(100).describe("Y position as percentage of screen height (0=top, 100=bottom)"),
    }),
  }),

  type_text: tool({
    description:
      "Type text into the currently focused input field. Make sure an input is focused (by tapping it first) before using this.",
    parameters: z.object({
      text: z.string().describe("The text to type"),
    }),
  }),

  tap_and_type: tool({
    description:
      "Tap on a text field and type text into it in one action. Use this for filling in form fields — it's more reliable than separate tap + type_text because it ensures the field stays focused. The field will be cleared before typing. IMPORTANT: Use the PLACEHOLDER text shown inside the input field (e.g. 'hello@example.com', '••••••••'), NOT the label text above it (e.g. 'Email', 'Password').",
    parameters: z.object({
      element: z.string().describe("The placeholder/hint text INSIDE the input field (e.g. 'hello@example.com', '••••••••', 'Enter your name'), NOT the label above it"),
      text: z.string().describe("The text to type into the field"),
    }),
  }),

  navigate_back: tool({
    description:
      "Navigate back by performing an iOS back swipe gesture (swipe from left edge to right).",
    parameters: z.object({}),
  }),

  scroll: tool({
    description: "Scroll the current view in a direction.",
    parameters: z.object({
      direction: z.enum(["up", "down", "left", "right"]).describe("Direction to scroll"),
    }),
  }),

  wait: tool({
    description:
      "Wait for content to load, animations to finish, or state to settle. Use after actions that trigger network requests or transitions.",
    parameters: z.object({
      seconds: z
        .number()
        .min(0.5)
        .max(10)
        .describe("How long to wait in seconds"),
    }),
  }),

  assert_visible: tool({
    description:
      "Assert that a specific text or element is currently visible on screen. Checks the accessibility tree.",
    parameters: z.object({
      text: z
        .string()
        .describe("The text or label that should be visible"),
    }),
  }),

  report_issue: tool({
    description:
      "Report a bug, visual issue, or unexpected behavior found during testing. Use this whenever something doesn't look right or behaves unexpectedly.",
    parameters: z.object({
      severity: z
        .enum(["critical", "major", "minor"])
        .describe(
          "critical = crash/data loss, major = broken feature, minor = visual/cosmetic",
        ),
      description: z.string().describe("What went wrong"),
      expected: z.string().describe("What should have happened"),
      actual: z.string().describe("What actually happened"),
    }),
  }),

  mark_complete: tool({
    description:
      "End the current test run with a pass or fail verdict. Use when you've finished exploring or completed the test goal.",
    parameters: z.object({
      status: z.enum(["pass", "fail"]),
      reason: z
        .string()
        .describe("Why the test passed or failed — include evidence"),
    }),
  }),
};

export type AgentToolName = keyof typeof agentTools;
