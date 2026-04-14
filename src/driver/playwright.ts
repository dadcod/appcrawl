import type { Browser, BrowserContext, Page } from "playwright";
import type { Device, DeviceDriver, ElementNode } from "./types.js";

export interface PlaywrightDriverOptions {
  /** Browser engine to use */
  browser?: "chromium" | "firefox" | "webkit";
  /** Whether to run in headless mode */
  headless?: boolean;
  /** Viewport width */
  viewportWidth?: number;
  /** Viewport height */
  viewportHeight?: number;
}

/**
 * DeviceDriver implementation backed by Playwright.
 *
 * Coordinates follow the same convention as the mobile drivers:
 * - `tap(x, y)` receives PERCENTAGE coordinates (0-100)
 * - `swipe(x1, y1, x2, y2)` also uses percentages
 * - `accessibilityTree()` returns the DOM tree as ElementNode[]
 * - `launchApp(url)` navigates to the URL (bundleId is reinterpreted as URL)
 */
export class PlaywrightDriver implements DeviceDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private options: PlaywrightDriverOptions;
  private viewportWidth: number;
  private viewportHeight: number;

  constructor(options: PlaywrightDriverOptions = {}) {
    this.options = options;
    this.viewportWidth = options.viewportWidth ?? 1280;
    this.viewportHeight = options.viewportHeight ?? 800;
  }

  async connect(): Promise<void> {
    // Dynamic import so Playwright is optional — only needed for web testing
    const pw = await import("playwright");

    const browserType = this.options.browser ?? "chromium";
    const launcher = pw[browserType];

    this.browser = await launcher.launch({
      headless: this.options.headless ?? false,
    });

    this.context = await this.browser.newContext({
      viewport: {
        width: this.viewportWidth,
        height: this.viewportHeight,
      },
    });

    this.page = await this.context.newPage();
  }

  private getPage(): Page {
    if (!this.page) throw new Error("Not connected. Call connect() first.");
    return this.page;
  }

  async screenshot(): Promise<Buffer> {
    const page = this.getPage();
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    return Buffer.from(buffer);
  }

  async accessibilityTree(): Promise<ElementNode[]> {
    const page = this.getPage();

    // Extract interactive elements from the DOM using evaluate
    const elements = await page.evaluate(() => {
      const results: Array<{
        tag: string;
        type: string;
        label: string | null;
        value: string | null;
        enabled: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];

      // Interactive selectors
      const selectors = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "[role='button']",
        "[role='link']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='switch']",
        "[role='textbox']",
        "[role='combobox']",
        "[onclick]",
        "[tabindex]",
      ];

      const seen = new Set<Element>();
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          // Skip invisible elements
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

          const tag = el.tagName.toLowerCase();
          const htmlEl = el as HTMLElement;
          const inputEl = el as HTMLInputElement;

          // Determine label
          let label =
            htmlEl.getAttribute("aria-label") ||
            htmlEl.getAttribute("title") ||
            htmlEl.textContent?.trim().slice(0, 100) ||
            null;

          // For inputs, use placeholder as label fallback
          if (!label && (tag === "input" || tag === "textarea")) {
            label = htmlEl.getAttribute("placeholder") || null;
          }

          // Determine value
          let value: string | null = null;
          if (tag === "input" || tag === "textarea" || tag === "select") {
            value = inputEl.value || null;
          }
          if (htmlEl.getAttribute("aria-checked")) {
            value = htmlEl.getAttribute("aria-checked");
          }

          // Determine type
          let type = "Element";
          if (tag === "a") type = "Link";
          else if (tag === "button" || htmlEl.getAttribute("role") === "button") type = "Button";
          else if (tag === "input") {
            const inputType = htmlEl.getAttribute("type") || "text";
            if (inputType === "password") type = "SecureTextField";
            else if (inputType === "checkbox" || inputType === "radio") type = "Checkbox";
            else if (inputType === "submit" || inputType === "button") type = "Button";
            else type = "TextField";
          } else if (tag === "textarea") type = "TextField";
          else if (tag === "select") type = "Select";
          else if (htmlEl.getAttribute("role") === "tab") type = "Tab";
          else if (htmlEl.getAttribute("role") === "checkbox") type = "Checkbox";
          else if (htmlEl.getAttribute("role") === "link") type = "Link";

          // Determine enabled
          const disabled =
            htmlEl.hasAttribute("disabled") ||
            htmlEl.getAttribute("aria-disabled") === "true";

          results.push({
            tag,
            type,
            label,
            value,
            enabled: !disabled,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }

      // Also grab visible text headings for screen identification
      for (const el of document.querySelectorAll("h1, h2, h3, [role='heading']")) {
        if (seen.has(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = el.textContent?.trim().slice(0, 100) || null;
        if (text) {
          results.push({
            tag: el.tagName.toLowerCase(),
            type: "Heading",
            label: text,
            value: null,
            enabled: true,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }

      return results;
    });

    return elements.map((el) => ({
      type: el.type,
      label: el.label,
      value: el.value,
      frame: { x: el.x, y: el.y, width: el.width, height: el.height },
      enabled: el.enabled,
      children: [],
    }));
  }

  async tap(xPercent: number, yPercent: number): Promise<void> {
    const page = this.getPage();
    const x = Math.round((xPercent / 100) * this.viewportWidth);
    const y = Math.round((yPercent / 100) * this.viewportHeight);
    await page.mouse.click(x, y);
  }

  /**
   * Click an element by its visible text or aria-label.
   * Falls back to text-based locator.
   */
  async tapOn(text: string): Promise<void> {
    const page = this.getPage();

    // Try aria-label first
    const ariaLocator = page.locator(`[aria-label="${text}"]`);
    if ((await ariaLocator.count()) > 0) {
      await ariaLocator.first().click({ timeout: 5000 });
      return;
    }

    // Try by text
    const textLocator = page.getByText(text, { exact: false });
    if ((await textLocator.count()) > 0) {
      await textLocator.first().click({ timeout: 5000 });
      return;
    }

    // Try by role
    const buttonLocator = page.getByRole("button", { name: text });
    if ((await buttonLocator.count()) > 0) {
      await buttonLocator.first().click({ timeout: 5000 });
      return;
    }

    const linkLocator = page.getByRole("link", { name: text });
    if ((await linkLocator.count()) > 0) {
      await linkLocator.first().click({ timeout: 5000 });
      return;
    }

    throw new Error(`Element "${text}" not found on page`);
  }

  async tapAndType(fieldLabel: string, text: string): Promise<void> {
    const page = this.getPage();

    // Try label association first
    const labelLocator = page.getByLabel(fieldLabel);
    if ((await labelLocator.count()) > 0) {
      await labelLocator.first().click({ timeout: 5000 });
      await labelLocator.first().fill(text);
      return;
    }

    // Try placeholder
    const placeholderLocator = page.getByPlaceholder(fieldLabel);
    if ((await placeholderLocator.count()) > 0) {
      await placeholderLocator.first().click({ timeout: 5000 });
      await placeholderLocator.first().fill(text);
      return;
    }

    // Try aria-label
    const ariaLocator = page.locator(`[aria-label="${fieldLabel}"]`);
    if ((await ariaLocator.count()) > 0) {
      await ariaLocator.first().click({ timeout: 5000 });
      await ariaLocator.first().fill(text);
      return;
    }

    throw new Error(`Field "${fieldLabel}" not found on page`);
  }

  async swipe(
    x1Percent: number,
    y1Percent: number,
    x2Percent: number,
    y2Percent: number,
    _duration?: number,
  ): Promise<void> {
    const page = this.getPage();
    const x1 = Math.round((x1Percent / 100) * this.viewportWidth);
    const y1 = Math.round((y1Percent / 100) * this.viewportHeight);
    const x2 = Math.round((x2Percent / 100) * this.viewportWidth);
    const y2 = Math.round((y2Percent / 100) * this.viewportHeight);

    // Simulate scroll based on swipe direction
    const deltaX = x2 - x1;
    const deltaY = y2 - y1;
    await page.mouse.wheel(deltaX, -deltaY);
  }

  async typeText(text: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.type(text);
  }

  async pressButton(button: "home" | "lock"): Promise<void> {
    // No-op for web — no hardware buttons
    void button;
  }

  async launchApp(url: string): Promise<void> {
    const page = this.getPage();
    // Treat the "bundleId" as a URL for web testing
    const target = url.startsWith("http") ? url : `https://${url}`;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async terminateApp(_bundleId: string): Promise<void> {
    // Navigate to about:blank
    const page = this.getPage();
    await page.goto("about:blank");
  }

  async listDevices(): Promise<Device[]> {
    return [
      {
        udid: "playwright-browser",
        name: `${this.options.browser ?? "chromium"} ${this.viewportWidth}x${this.viewportHeight}`,
        state: this.browser ? "booted" : "shutdown",
        type: "simulator",
      },
    ];
  }

  async cleanup(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.page = null;
  }
}
