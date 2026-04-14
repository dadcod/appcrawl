export const DEFAULTS = {
  maxSteps: 50,
  steeredMaxSteps: 30,
  // Claude Sonnet 4.5 — best vision + tool use for agentic UI testing
  model: "claude-sonnet-4-5",
  bundleId: "",
  verbose: false,
  reportDir: "appcrawl-reports",
  screenshotDelay: 1000,
  /** Delay between steps in ms. Gives animations / network calls time
   *  to settle before the next screenshot. 0 = no extra delay. */
  stepDelay: 2000,
  screenWidth: 393,
  screenHeight: 852,
} as const;

export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "ollama";

export function resolveModel(modelFlag: string | undefined): {
  provider: Provider;
  modelId: string;
} {
  const model = modelFlag ?? DEFAULTS.model;

  // Explicit provider prefix: openrouter:model/name, ollama:llama3, etc.
  const prefixMatch = model.match(/^(openrouter|ollama):(.+)$/);
  if (prefixMatch) {
    return { provider: prefixMatch[1] as Provider, modelId: prefixMatch[2] };
  }

  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
    return { provider: "openai", modelId: model };
  }
  if (model.startsWith("gemini-")) {
    return { provider: "google", modelId: model };
  }
  // Default to Anthropic for claude-* or any unrecognized model
  return { provider: "anthropic", modelId: model };
}
