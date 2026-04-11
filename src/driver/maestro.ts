import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Device, DeviceDriver, ElementNode } from "./types.js";

export class MaestroDriver implements DeviceDriver {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private cachedDeviceId: string | null = null;
  private bundleId: string = "";

  async connect(): Promise<void> {
    const javaHome = execSync("/usr/libexec/java_home", {
      encoding: "utf-8",
    }).trim();

    const maestroPath = `${process.env.HOME}/.maestro/bin/maestro`;

    this.transport = new StdioClientTransport({
      command: maestroPath,
      args: ["mcp"],
      env: { ...process.env, JAVA_HOME: javaHome },
    });

    this.client = new Client({
      name: "skirmish",
      version: "0.1.0",
    });

    await this.client.connect(this.transport);
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) throw new Error("Not connected. Call connect() first.");

    const result = await this.client.callTool({ name, arguments: args });

    // Extract text content from MCP result
    const parts: string[] = [];
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === "text") {
          parts.push(block.text as string);
        }
      }
    }
    const text = parts.join("\n");

    // MCP tools signal failure via isError flag — surface it as a thrown error
    // so the agent can see what went wrong and adapt.
    if (result.isError) {
      throw new Error(parseMaestroError(text) || `Maestro ${name} failed`);
    }

    return text || JSON.stringify(result);
  }

  private async callToolRaw(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown[]> {
    if (!this.client) throw new Error("Not connected. Call connect() first.");
    const result = await this.client.callTool({ name, arguments: args });
    return (result.content as unknown[]) ?? [];
  }

  async screenshot(): Promise<Buffer> {
    if (!this.client) throw new Error("Not connected.");

    const result = await this.client.callTool({
      name: "take_screenshot",
      arguments: {},
    });

    // Look for image content block
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content as Array<Record<string, unknown>>) {
        if (block.type === "image" && block.data) {
          return Buffer.from(block.data as string, "base64");
        }
      }

      // Check for text content that might be a file path
      for (const block of result.content as Array<Record<string, unknown>>) {
        if (block.type === "text") {
          const text = (block.text as string).trim();
          if (text.endsWith(".png") || text.endsWith(".jpg") || text.startsWith("/")) {
            // Try reading as file path
            const { readFile } = await import("node:fs/promises");
            try {
              return await readFile(text);
            } catch {
              // Not a valid file path, continue
            }
          }
        }
      }
    }

    // Fallback: use simctl screenshot directly
    const { execSync } = await import("node:child_process");
    const { readFile } = await import("node:fs/promises");
    const tmpPath = `/tmp/skirmish-screenshot-${Date.now()}.png`;
    execSync(`xcrun simctl io booted screenshot "${tmpPath}"`, { timeout: 10_000 });
    const buffer = await readFile(tmpPath);
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpPath).catch(() => {});
    return buffer;
  }

  async accessibilityTree(): Promise<ElementNode[]> {
    const deviceId = await this.getBootedDeviceId();
    const text = await this.callTool("inspect_view_hierarchy", { device_id: deviceId });
    return parseMaestroHierarchy(text);
  }

  private flowYaml(steps: string): string {
    return `appId: ${this.bundleId}\n---\n${steps}`;
  }

  async tap(x: number, y: number): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(`- tapOn:\n    point: "${Math.round(x)}%,${Math.round(y)}%"`),
      device_id: deviceId,
    });
  }

  async tapOn(selector: string): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("tap_on", { text: selector, device_id: deviceId });
  }

  async tapById(testId: string): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("tap_on", { id: testId, device_id: deviceId });
  }

  async tapAndType(fieldLabel: string, text: string): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    const escapedText = text.replace(/"/g, '\\"');
    const escapedLabel = fieldLabel.replace(/"/g, '\\"');
    // Single Maestro flow: tap field, clear existing text, type, dismiss keyboard.
    // hideKeyboard ensures the next screenshot shows the full UI, not a
    // keyboard covering half the screen.
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(
        `- tapOn: "${escapedLabel}"\n- eraseText: 50\n- inputText: "${escapedText}"\n- hideKeyboard`,
      ),
      device_id: deviceId,
    });
  }

  async hideKeyboard(): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(`- hideKeyboard`),
      device_id: deviceId,
    });
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    _duration?: number,
  ): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(`- swipe:\n    start: "${Math.round(x1)}%, ${Math.round(y1)}%"\n    end: "${Math.round(x2)}%, ${Math.round(y2)}%"`),
      device_id: deviceId,
    });
  }

  async typeText(text: string): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("input_text", { text, device_id: deviceId });
  }

  async pressButton(_button: "home" | "lock"): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml("- pressKey: Home"),
      device_id: deviceId,
    });
  }

  async launchApp(bundleId: string): Promise<void> {
    this.bundleId = bundleId;
    // Use simctl directly — more reliable than Maestro MCP for launch
    execSync(`xcrun simctl launch booted ${bundleId}`, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    // For Expo dev builds, open the dev client URL to connect to the dev server
    try {
      execSync(
        `xcrun simctl openurl booted "exp+storyspell://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`,
        { encoding: "utf-8", timeout: 10_000 },
      );
    } catch {
      // Not an Expo dev build or dev server not running — that's fine
    }
  }

  async terminateApp(bundleId: string): Promise<void> {
    try {
      execSync(`xcrun simctl terminate booted ${bundleId}`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch {
      // App might not be running
    }
  }

  private async getBootedDeviceId(): Promise<string> {
    if (this.cachedDeviceId) return this.cachedDeviceId;
    const output = execSync("xcrun simctl list devices booted", { encoding: "utf-8" });
    const match = output.match(/\(([A-F0-9-]{36})\)\s+\(Booted\)/);
    if (!match) throw new Error("No booted simulator found");
    this.cachedDeviceId = match[1];
    return this.cachedDeviceId;
  }

  async listDevices(): Promise<Device[]> {
    const text = await this.callTool("list_devices", {});
    // Parse Maestro device list output
    const devices: Device[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Available")) continue;
      // Maestro lists devices with name and status
      devices.push({
        udid: trimmed,
        name: trimmed,
        state: trimmed.toLowerCase().includes("booted") ? "booted" : "unknown",
        type: "simulator",
      });
    }
    return devices;
  }

  async cleanup(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.transport = null;
  }
}

/**
 * Parse Maestro's `inspect_view_hierarchy` output, which is CSV-shaped:
 *
 *   element_num,depth,bounds,attributes,parent_num
 *   1,1,"[0,0][393,852]","accessibilityText=StorySpell; enabled=true",0
 *   23,20,"[120,65][232,91]","accessibilityText=Story Wizard; enabled=true",19
 *
 * Fields:
 *   - element_num: unique numeric id
 *   - depth:       nesting depth (not directly used — we flatten)
 *   - bounds:      `[x1,y1][x2,y2]` pixel rectangle
 *   - attributes:  semicolon-separated `key=value` pairs. Keys we care about:
 *                  accessibilityText, text, value, hintText, enabled
 *   - parent_num:  element_num of parent (used for implicit tree shape)
 *
 * We return a flat array — the rest of the codebase uses flattenTree
 * on top of whatever shape we hand back, so a flat list is equivalent
 * to a deeply-nested tree for our purposes. We filter out container
 * wrappers with no label to keep signal density high.
 */
function parseMaestroHierarchy(text: string): ElementNode[] {
  const nodes: ElementNode[] = [];
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return nodes;

  // First line is the CSV header — skip it.
  const dataStart = lines[0].toLowerCase().startsWith("element_num") ? 1 : 0;

  for (let i = dataStart; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    // Expected shape: [num, depth, bounds, attributes, parent_num]
    if (fields.length < 4) continue;

    const bounds = fields[2];
    const attributes = fields[3];
    const frame = parseBounds(bounds);
    const attrs = parseAttributes(attributes);

    // Prefer accessibilityText, fall back to text, then hintText.
    // hintText alone usually means placeholder text on an empty field.
    const label = attrs.accessibilityText || attrs.text || attrs.hintText || null;
    const value = attrs.value || null;

    // Drop pure container wrappers: no label, no hint, no value.
    // These are layout boxes and just add noise.
    if (!label && !value && !attrs.hintText) continue;

    // Crude type inference — Maestro doesn't expose the real UIKit class
    // over this interface, so we label by affordance.
    let type = "Element";
    if (attrs.hintText) {
      type = attrs.hintText.includes("•") ? "SecureTextField" : "TextField";
    } else if (label) {
      type = "Button";
    }

    nodes.push({
      type,
      label,
      value,
      frame,
      enabled: attrs.enabled !== "false",
      children: [],
    });
  }

  return nodes;
}

/**
 * Minimal CSV parser that understands quoted fields. Maestro's output
 * wraps bounds and attributes in double quotes and both contain commas,
 * so a naive `line.split(",")` shreds them.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseBounds(bounds: string): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  // Format: [x1,y1][x2,y2]
  const match = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = parseInt(match[1], 10);
  const y1 = parseInt(match[2], 10);
  const x2 = parseInt(match[3], 10);
  const y2 = parseInt(match[4], 10);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const pair of text.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) attrs[key] = value;
  }
  return attrs;
}

/**
 * Extract a concise error message from Maestro's verbose MCP error output.
 * Maestro errors often contain ANSI art boxes and full stack traces — the
 * signal-to-noise ratio hurts the LLM, so we strip decorations and pull out
 * just the "Failed to X: reason" line.
 */
function parseMaestroError(text: string): string {
  if (!text) return "";

  // Try to extract "Failed to <action>: <reason>" pattern
  const failedMatch = text.match(/Failed to [^:]+:\s*([^\n]+)/);
  if (failedMatch) {
    return failedMatch[0].trim();
  }

  // Try to extract "Element not found: ..." pattern
  const notFoundMatch = text.match(/Element not found:\s*([^\n]+)/);
  if (notFoundMatch) {
    return `Element not found: ${notFoundMatch[1].trim()}`;
  }

  // Strip ANSI box-drawing characters and collapse whitespace
  const cleaned = text
    .replace(/[│╭╮╰╯─━┃┏┓┗┛]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Return first 200 chars to keep error concise
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
}

export async function checkMaestroInstalled(): Promise<{
  installed: boolean;
  message: string;
}> {
  const maestroPath = `${process.env.HOME}/.maestro/bin/maestro`;
  try {
    const javaHome = execSync("/usr/libexec/java_home", {
      encoding: "utf-8",
    }).trim();
    execSync(`JAVA_HOME="${javaHome}" "${maestroPath}" --version`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return { installed: true, message: "Maestro is installed" };
  } catch {
    return {
      installed: false,
      message: [
        "Maestro is not installed or JAVA_HOME is not configured.",
        "",
        "Install Maestro:",
        "  curl -Ls 'https://get.maestro.mobile.dev' | bash",
        "",
        "Install Java (if needed):",
        "  brew install openjdk",
      ].join("\n"),
    };
  }
}
