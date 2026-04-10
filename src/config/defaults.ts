export const DEFAULTS = {
  maxSteps: 50,
  steeredMaxSteps: 30,
  model: "claude-sonnet-4-20250514",
  bundleId: "",
  verbose: false,
  reportDir: "skirmish-reports",
  screenshotDelay: 1000,
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
