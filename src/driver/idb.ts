import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Device, DeviceDriver, ElementNode } from "./types.js";

const exec = promisify(execFile);

export class IdbDriver implements DeviceDriver {
  private udid: string;

  constructor(udid = "booted") {
    this.udid = udid;
  }

  async screenshot(): Promise<Buffer> {
    const path = join(tmpdir(), `skirmish-${Date.now()}.png`);
    await this.run("screenshot", [path]);
    const buffer = await readFile(path);
    await unlink(path).catch(() => {});
    return buffer;
  }

  async accessibilityTree(): Promise<ElementNode[]> {
    const { stdout } = await this.run("ui", ["describe-all", "--json"]);
    return parseAccessibilityOutput(stdout);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.run("ui", ["tap", String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration = 0.5,
  ): Promise<void> {
    await this.run("ui", [
      "swipe",
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      "--duration",
      String(duration),
    ]);
  }

  async typeText(text: string): Promise<void> {
    await this.run("ui", ["text", text]);
  }

  async pressButton(button: "home" | "lock"): Promise<void> {
    const buttonMap = { home: "HOME", lock: "LOCK" };
    await this.run("ui", ["button", buttonMap[button]]);
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.run("launch", [bundleId]);
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.run("terminate", [bundleId]);
  }

  async listDevices(): Promise<Device[]> {
    const { stdout } = await this.run("list-targets", [], false);
    return parseDeviceList(stdout);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for CLI-based driver
  }

  private async run(
    command: string,
    args: string[],
    withUdid = true,
  ): Promise<{ stdout: string; stderr: string }> {
    const fullArgs = withUdid
      ? [command, "--udid", this.udid, ...args]
      : [command, ...args];

    try {
      return await exec("idb", fullArgs, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`idb ${command} failed: ${msg}`);
    }
  }
}

function parseAccessibilityOutput(stdout: string): ElementNode[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeNode);
    }
    return [normalizeNode(parsed)];
  } catch {
    // idb may output line-delimited JSON or a different format.
    // Attempt line-by-line parsing.
    const nodes: ElementNode[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        nodes.push(normalizeNode(JSON.parse(trimmed)));
      } catch {
        // skip unparseable lines
      }
    }
    return nodes;
  }
}

function normalizeNode(raw: Record<string, unknown>): ElementNode {
  const frame = raw.frame as Record<string, number> | undefined;
  const children = (raw.children ?? raw.elements ?? []) as Record<string, unknown>[];

  return {
    type: String(raw.type ?? raw.AXRole ?? raw.role ?? "Unknown"),
    label: (raw.label ?? raw.AXLabel ?? raw.title ?? null) as string | null,
    value: (raw.value ?? raw.AXValue ?? null) as string | null,
    frame: {
      x: frame?.x ?? frame?.X ?? 0,
      y: frame?.y ?? frame?.Y ?? 0,
      width: frame?.width ?? frame?.w ?? 0,
      height: frame?.height ?? frame?.h ?? 0,
    },
    enabled: raw.enabled !== false,
    children: Array.isArray(children) ? children.map(normalizeNode) : [],
  };
}

function parseDeviceList(stdout: string): Device[] {
  const devices: Device[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // idb list-targets format: "UDID | Name | State | Type"
    const parts = trimmed.split("|").map((p) => p.trim());
    if (parts.length >= 4) {
      devices.push({
        udid: parts[0],
        name: parts[1],
        state: parts[2].toLowerCase().includes("booted")
          ? "booted"
          : parts[2].toLowerCase().includes("shutdown")
            ? "shutdown"
            : "unknown",
        type: parts[3].toLowerCase().includes("simulator")
          ? "simulator"
          : "device",
      });
    }
  }
  return devices;
}

export async function checkIdbInstalled(): Promise<{
  installed: boolean;
  message: string;
}> {
  try {
    await exec("idb", ["--help"], { timeout: 5_000 });
    return { installed: true, message: "idb is installed" };
  } catch {
    return {
      installed: false,
      message: [
        "idb is not installed. Install it with:",
        "",
        "  brew install idb-companion",
        "  pip3 install fb-idb",
        "",
        "More info: https://fbidb.io/docs/installation",
      ].join("\n"),
    };
  }
}
