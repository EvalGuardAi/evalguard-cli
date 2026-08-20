/**
 * Shared `callLLM` adapter for CLI commands.
 *
 * EXTRACTED 2026-07-29 from three byte-equivalent private copies in
 * `commands/generate.ts`, `commands/generate-dataset.ts` and
 * `commands/optimize.ts`. A fourth caller (`commands/compliance-check.ts`)
 * needed it, and adding a fourth copy is exactly the drift this repo has been
 * bitten by before. All four now share this one implementation.
 *
 * Contract note (load-bearing): `createProvider` takes the API key
 * POSITIONALLY — `createProvider(name, apiKey)`. Passing an options object
 * instead does NOT throw, it just yields a provider with no key, which is how
 * `compliance-check` silently produced a scan whose every attack recorded
 * `[ERROR] callLLM is not a function`.
 */

/** Provider name → the env var its API key is read from. */
const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** The env var holding `providerName`'s API key. */
export function providerEnvVar(providerName: string): string {
  return (
    PROVIDER_ENV_VARS[providerName] ??
    `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`
  );
}

/**
 * Resolve the provider API key: explicit override, then the provider-specific
 * env var, then the generic `EVALGUARD_PROVIDER_KEY`.
 */
export function resolveProviderKey(providerName: string, explicitKey?: string): string {
  return (
    explicitKey ??
    process.env[providerEnvVar(providerName)] ??
    process.env.EVALGUARD_PROVIDER_KEY ??
    ""
  );
}

/**
 * Build the `callLLM(prompt) => Promise<string>` function every core entry
 * point (`runSecurityScan`, `generateAssertions`, the optimizers) expects.
 *
 * @param createProvider the `createProvider` export from `@evalguard/core`
 *   (passed in so commands keep their lazy `await import("@evalguard/core")`).
 * @param apiKey explicit key; omit to resolve from the environment.
 */
export async function makeCallLLM(
  providerName: string,
  model: string,
  createProvider: (name: string, apiKey: string) => { chat: (...args: never[]) => unknown },
  apiKey?: string,
): Promise<(prompt: string) => Promise<string>> {
  const key = resolveProviderKey(providerName, apiKey);
  // POSITIONAL key — see the contract note above.
  const provider = createProvider(providerName, key) as {
    chat: (
      messages: { role: string; content: string }[],
      opts: { model: string },
    ) => Promise<{ content: string }>;
  };
  if (typeof provider?.chat !== "function") {
    throw new Error(
      `Provider "${providerName}" did not yield a usable client (no .chat method). ` +
        `Check the provider name and that ${providerEnvVar(providerName)} is set.`,
    );
  }
  return async (prompt: string) => {
    const response = await provider.chat([{ role: "user", content: prompt }], { model });
    return response.content;
  };
}

/**
 * Map a model id to the provider name `createProvider` understands.
 *
 * EXTRACTED 2026-07-29 (audit A1) from THREE drifted copies in
 * `commands/compliance-check.ts:395`, `commands/gate.ts:527` and
 * `commands/scan-local.ts:547`. They did not agree, and one of them was
 * wrong in a way that broke the command:
 *
 *   compliance-check returned "google" for gemini-* and "meta" for llama-*.
 *   Neither is a registered provider — `createProvider` throws
 *     Unknown provider "google". Valid providers: openai, anthropic, gemini,
 *     mistral, groq, ollama, azure-openai, bedrock
 *   so `evalguard compliance-check --model gemini-1.5-pro` could never reach
 *   a model and fell through to the dry-run report.
 *
 * This copy returns only names the registry actually resolves
 * (`packages/core/src/providers/registry.ts`). Do not fork it again.
 */
export function detectProviderFromModel(model: string): string {
  if (!model || typeof model !== "string") return "openai";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  ) {
    return "openai";
  }
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
  if (model.includes("llama") || model.includes("mixtral")) return "groq";
  if (model.startsWith("deepseek-")) return "deepseek";
  return "openai";
}
