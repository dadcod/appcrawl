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
    if (result.content && Array.isArray(result.content)) {
      const parts: string[] = [];
      for (const block of result.content) {
        if (block.type === "text") {
          parts.push(block.text as string);
        }
      }
      return parts.join("\n");
    }
    return JSON.stringify(result);
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
    // Use a single Maestro flow to tap, clear, and type.
    // Try tapping the label first, then erase+type. If the field label
    // matches a non-input element, the tap still happens but eraseText
    // won't work — that's handled by the retry logic in the agent.
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(
        `- tapOn: "${escapedLabel}"\n- eraseText: 50\n- inputText: "${escapedText}"`,
      ),
      device_id: deviceId,
    });
  }

  async tapPlaceholderAndType(placeholder: string, text: string): Promise<void> {
    const deviceId = await this.getBootedDeviceId();
    const escapedText = text.replace(/"/g, '\\"');
    const escapedPlaceholder = placeholder.replace(/"/g, '\\"');
    // Tap by hint/placeholder text — more reliable for input fields
    await this.callTool("run_flow", {
      flow_yaml: this.flowYaml(
        `- tapOn: "${escapedPlaceholder}"\n- eraseText: 50\n- inputText: "${escapedText}"`,
      ),
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

function parseMaestroHierarchy(text: string): ElementNode[] {
  // Maestro's inspect_view_hierarchy returns CSV-like format:
  // Type, Label, Value, X, Y, Width, Height, Enabled
  // Or it might return a structured text. Parse flexibly.
  const nodes: ElementNode[] = [];
  const lines = text.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    // Skip header lines
    if (
      line.startsWith("---") ||
      line.toLowerCase().includes("view hierarchy") ||
      line.toLowerCase().startsWith("type")
    )
      continue;

    // Try CSV parsing: Type,Label,X,Y,Width,Height
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length >= 4) {
      const node: ElementNode = {
        type: parts[0] || "Unknown",
        label: parts[1] || null,
        value: parts[2] || null,
        frame: {
          x: parseFloat(parts[3]) || 0,
          y: parseFloat(parts[4]) || 0,
          width: parseFloat(parts[5]) || 0,
          height: parseFloat(parts[6]) || 0,
        },
        enabled: parts[7] !== "false",
        children: [],
      };
      // Only add nodes that have a label or meaningful type
      if (node.label || node.type !== "Unknown") {
        nodes.push(node);
      }
      continue;
    }

    // Fallback: treat indented lines as hierarchy
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (content) {
      // Extract label from patterns like: Button "Settings" or Text("Hello")
      const labelMatch = content.match(
        /["']([^"']+)["']|text=["']([^"']+)["']|label=["']([^"']+)["']/i,
      );
      const typeMatch = content.match(/^(\w+)/);

      nodes.push({
        type: typeMatch?.[1] ?? "Unknown",
        label: labelMatch?.[1] ?? labelMatch?.[2] ?? labelMatch?.[3] ?? content,
        value: null,
        frame: { x: 0, y: 0, width: 0, height: 0 },
        enabled: true,
        children: [],
      });
    }
  }

  return nodes;
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
