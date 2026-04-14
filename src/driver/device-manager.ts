/**
 * Device bring-up: ensure there's a booted simulator/emulator before the
 * agent loop starts, and install the app if a build artifact was supplied.
 *
 * This is the glue that makes `appcrawl explore --app com.x` work against a
 * cold machine — CI runners, a fresh laptop, whatever. Without it, users
 * have to manually `open -a Simulator` or `emulator @pixel_6` before every
 * run, and `appcrawl doctor` has to say "[MISSING] simulator" instead of
 * just bringing one up.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Platform } from "./types.js";

export interface EnsureDeviceOptions {
  platform: Platform;
  /** iOS: device name (e.g. "iPhone 15"). Android: AVD name. Optional. */
  deviceName?: string;
  /** Path to .app / .ipa / .apk to install before launching. Optional. */
  installPath?: string;
  /** Target app bundle id. Used for Android uninstall-before-install. */
  bundleId: string;
  verbose?: boolean;
}

export interface EnsureDeviceResult {
  deviceId: string;
  deviceName: string;
  bootedByUs: boolean;
}

export async function ensureDevice(
  options: EnsureDeviceOptions,
): Promise<EnsureDeviceResult> {
  const result =
    options.platform === "ios"
      ? await ensureIosSimulator(options)
      : await ensureAndroidDevice(options);

  if (options.installPath) {
    await installApp(options.platform, options.installPath, options.bundleId, options.verbose);
  }

  return result;
}

async function ensureIosSimulator(
  options: EnsureDeviceOptions,
): Promise<EnsureDeviceResult> {
  const log = (msg: string): void => {
    if (options.verbose) console.log(`[device] ${msg}`);
  };

  // Already booted? Use it.
  const booted = listBootedIosSimulators();
  if (booted.length > 0) {
    const preferred = options.deviceName
      ? booted.find((d) => d.name === options.deviceName)
      : booted[0];
    if (preferred) {
      log(`Using already-booted simulator: ${preferred.name}`);
      return { deviceId: preferred.udid, deviceName: preferred.name, bootedByUs: false };
    }
  }

  // Nothing booted — pick a target and boot it.
  const target = options.deviceName
    ? findIosSimulator(options.deviceName)
    : pickDefaultIosSimulator();
  if (!target) {
    throw new Error(
      options.deviceName
        ? `No iOS simulator named "${options.deviceName}" found. Run: xcrun simctl list devices`
        : "No iOS simulators installed. Install one via Xcode > Settings > Platforms.",
    );
  }

  log(`Booting simulator: ${target.name} (${target.udid})`);
  execSync(`xcrun simctl boot ${target.udid}`, { timeout: 60_000 });
  // Open Simulator.app so the UI is visible (and so xcrun commands work)
  execSync(`open -a Simulator`, { timeout: 10_000 });
  // Wait for the device to finish booting
  execSync(`xcrun simctl bootstatus ${target.udid} -b`, { timeout: 120_000 });
  log(`Simulator booted.`);

  return { deviceId: target.udid, deviceName: target.name, bootedByUs: true };
}

async function ensureAndroidDevice(
  options: EnsureDeviceOptions,
): Promise<EnsureDeviceResult> {
  const log = (msg: string): void => {
    if (options.verbose) console.log(`[device] ${msg}`);
  };

  // Already connected? Use it.
  const connected = listConnectedAndroidDevices();
  if (connected.length > 0) {
    const preferred = options.deviceName
      ? connected.find((d) => d.serial === options.deviceName || d.name === options.deviceName)
      : connected[0];
    if (preferred) {
      log(`Using connected device: ${preferred.serial}`);
      return { deviceId: preferred.serial, deviceName: preferred.name, bootedByUs: false };
    }
  }

  // Nothing connected — start an emulator.
  const avdName = options.deviceName ?? pickDefaultAvd();
  if (!avdName) {
    throw new Error(
      "No Android device connected and no AVDs available. Create one via Android Studio > Device Manager, or pass --device <avd-name>.",
    );
  }

  log(`Starting emulator: ${avdName}`);
  // Launch in background — `emulator` is a long-running process.
  const emulatorCmd = `emulator -avd ${avdName} -no-snapshot-load -no-audio -no-boot-anim`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require("node:child_process");
  const proc = spawn("sh", ["-c", `${emulatorCmd} > /dev/null 2>&1 &`], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  // Wait for device to appear and finish boot.
  log(`Waiting for emulator to boot...`);
  execSync(`adb wait-for-device`, { timeout: 300_000 });
  // boot_completed indicates the system is fully ready
  for (let i = 0; i < 60; i++) {
    try {
      const out = execSync("adb shell getprop sys.boot_completed", {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (out === "1") break;
    } catch {
      // device may still be coming up
    }
    await sleep(2_000);
  }
  log(`Emulator booted.`);

  const deviceId = listConnectedAndroidDevices()[0]?.serial;
  if (!deviceId) throw new Error("Emulator started but no device appeared in `adb devices`.");
  return { deviceId, deviceName: avdName, bootedByUs: true };
}

async function installApp(
  platform: Platform,
  appPath: string,
  bundleId: string,
  verbose?: boolean,
): Promise<void> {
  if (!existsSync(appPath)) {
    throw new Error(`Install path does not exist: ${appPath}`);
  }
  const log = (msg: string): void => {
    if (verbose) console.log(`[device] ${msg}`);
  };

  if (platform === "ios") {
    log(`Installing ${appPath}...`);
    execSync(`xcrun simctl install booted "${appPath}"`, { timeout: 120_000 });
  } else {
    // Uninstall first to avoid signature mismatch on rebuilds. Ignore
    // failures — app may not be installed yet.
    try {
      execSync(`adb uninstall ${bundleId}`, { timeout: 30_000, stdio: "ignore" });
    } catch {
      // fine
    }
    log(`Installing ${appPath}...`);
    execSync(`adb install -r "${appPath}"`, { timeout: 180_000 });
  }
  log(`Installed.`);
}

interface IosDevice {
  udid: string;
  name: string;
  runtime: string;
}

function listBootedIosSimulators(): IosDevice[] {
  const output = execSync("xcrun simctl list devices booted", { encoding: "utf-8" });
  const devices: IosDevice[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s+(.+?)\s+\(([A-F0-9-]{36})\)\s+\(Booted\)/);
    if (match) devices.push({ name: match[1].trim(), udid: match[2], runtime: "" });
  }
  return devices;
}

function findIosSimulator(name: string): IosDevice | null {
  const output = execSync("xcrun simctl list devices available", { encoding: "utf-8" });
  let currentRuntime = "";
  for (const line of output.split("\n")) {
    const runtimeMatch = line.match(/^-- (.+?) --$/);
    if (runtimeMatch) {
      currentRuntime = runtimeMatch[1];
      continue;
    }
    const match = line.match(/^\s+(.+?)\s+\(([A-F0-9-]{36})\)\s+\((?:Booted|Shutdown)\)/);
    if (match && match[1].trim() === name) {
      return { name: match[1].trim(), udid: match[2], runtime: currentRuntime };
    }
  }
  return null;
}

function pickDefaultIosSimulator(): IosDevice | null {
  // Prefer the newest iPhone on the newest runtime — that's the safest
  // default across the Xcode versions people actually have installed.
  const output = execSync("xcrun simctl list devices available", { encoding: "utf-8" });
  const candidates: IosDevice[] = [];
  let currentRuntime = "";
  for (const line of output.split("\n")) {
    const runtimeMatch = line.match(/^-- (.+?) --$/);
    if (runtimeMatch) {
      currentRuntime = runtimeMatch[1];
      continue;
    }
    const match = line.match(/^\s+(.+?)\s+\(([A-F0-9-]{36})\)\s+\((?:Booted|Shutdown)\)/);
    if (match && /iOS/.test(currentRuntime) && /^iPhone/.test(match[1].trim())) {
      candidates.push({ name: match[1].trim(), udid: match[2], runtime: currentRuntime });
    }
  }
  if (candidates.length === 0) return null;
  // Last entry tends to be the newest iPhone on the newest runtime.
  return candidates[candidates.length - 1];
}

interface AndroidDevice {
  serial: string;
  name: string;
}

function listConnectedAndroidDevices(): AndroidDevice[] {
  try {
    const output = execSync("adb devices", { encoding: "utf-8", timeout: 5_000 });
    const devices: AndroidDevice[] = [];
    for (const line of output.split("\n").slice(1)) {
      const match = line.match(/^(\S+)\s+device\s*$/);
      if (match) devices.push({ serial: match[1], name: match[1] });
    }
    return devices;
  } catch {
    return [];
  }
}

function pickDefaultAvd(): string | null {
  try {
    const output = execSync("emulator -list-avds", { encoding: "utf-8", timeout: 5_000 });
    const avds = output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    return avds[0] ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
