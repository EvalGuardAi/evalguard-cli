/**
 * `evalguard list scorers` — List available scorers
 * `evalguard list plugins` — List available attack plugins
 * `evalguard list strategies` — List available encoding strategies
 * `evalguard list graders` — List available graders
 * `evalguard list providers` — List supported LLM providers
 */
import { Command } from "commander";
import chalk from "chalk";

export function registerList(program: Command): void {
  const list = program
    .command("list")
    .description("List available components");

  // ─── list scorers ───
  list
    .command("scorers")
    .description("List all built-in scorers")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { BUILT_IN_SCORERS } = await import("@evalguard/core") as any;

      const scorers = Object.entries(BUILT_IN_SCORERS).map(([key, scorer]: [string, any]) => ({
        name: key,
        description: scorer.description ?? scorer.name,
      }));

      if (opts.json) {
        console.log(JSON.stringify(scorers, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Available Scorers (${scorers.length})`));
      console.log();
      for (const s of scorers) {
        console.log(`  ${chalk.cyan(s.name.padEnd(25))} ${chalk.dim(s.description)}`);
      }
      console.log();
    });

  // ─── list plugins ───
  list
    .command("plugins")
    .description("List all red team attack plugins")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { ALL_PLUGINS } = await import("@evalguard/core") as any;

      const plugins = ALL_PLUGINS.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        severity: p.severity,
        attackTypes: p.attackTypes,
      }));

      if (opts.json) {
        console.log(JSON.stringify(plugins, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Attack Plugins (${plugins.length})`));
      console.log();
      for (const p of plugins) {
        const sevColor = p.severity === "critical" ? chalk.red : p.severity === "high" ? chalk.yellow : chalk.dim;
        console.log(`  ${chalk.cyan(p.id.padEnd(25))} ${sevColor(p.severity.padEnd(10))} ${chalk.dim(p.description)}`);
      }
      console.log();
    });

  // ─── list strategies ───
  list
    .command("strategies")
    .description("List all encoding/obfuscation strategies")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { ALL_STRATEGIES } = await import("@evalguard/core") as any;

      const strategies = ALL_STRATEGIES.map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));

      if (opts.json) {
        console.log(JSON.stringify(strategies, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Encoding Strategies (${strategies.length})`));
      console.log();
      for (const s of strategies) {
        console.log(`  ${chalk.cyan(s.id.padEnd(25))} ${chalk.dim(s.description)}`);
      }
      console.log();
    });

  // ─── list graders ───
  list
    .command("graders")
    .description("List all security graders")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { ALL_GRADERS } = await import("@evalguard/core") as any;

      const graders = ALL_GRADERS.map((g: any) => ({
        id: g.id,
        name: g.name,
        description: g.description,
      }));

      if (opts.json) {
        console.log(JSON.stringify(graders, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Security Graders (${graders.length})`));
      console.log();
      for (const g of graders) {
        console.log(`  ${chalk.cyan(g.id.padEnd(25))} ${chalk.dim(g.description)}`);
      }
      console.log();
    });

  // ─── list providers ───
  list
    .command("providers")
    .description("List all supported LLM providers")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { listProviders } = await import("@evalguard/core") as any;

      const providers = listProviders();

      if (opts.json) {
        console.log(JSON.stringify(providers, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Supported Providers (${providers.length})`));
      console.log();

      // Curated category map for the well-known providers — purely cosmetic
      // grouping. It is NOT the source of truth for WHICH providers exist: the
      // registry's `listProviders()` is. Any registered provider not named in a
      // curated category is surfaced under "Other" below, so the printed count
      // ALWAYS equals the header count and the `--json` count (previously the
      // human view silently dropped every uncategorised provider — e.g.
      // nvidia-nim, moonshot, zhipu, vercel-ai-gateway — printing 40 of 91).
      const categories: Record<string, string[]> = {
        "Cloud AI": ["openai", "anthropic", "gemini", "mistral", "groq", "cohere", "ai21", "deepseek", "perplexity", "xai", "cerebras", "moonshot", "zhipu", "sambanova"],
        "Cloud Platforms": ["azure-openai", "bedrock", "vertex", "sagemaker", "watsonx", "snowflake", "databricks", "oracle-cloud", "nvidia-nim", "cloudera", "truefoundry", "jfrog-ml"],
        "Open Source / Local": ["ollama", "vllm", "localai", "llamafile", "llamacpp", "huggingface", "lm-studio", "xinference", "transformers-js", "text-generation-webui", "openllm", "docker", "docker-model-runner", "gradio"],
        "Gateways / Routers": ["openrouter", "litellm", "helicone", "portkey", "cloudflare", "vercel-ai-gateway", "envoy-ai-gateway", "cloudflare-ai-gateway", "f5-gateway", "aiml-api", "cometapi"],
        "Specialized": ["together", "fireworks", "replicate", "fal", "alibaba", "voyage", "github-models", "hyperbolic", "nscale", "baseten", "modal", "lepton", "anyscale", "modelslab", "llama-api", "quiverai", "elevenlabs", "openclaw"],
        "SDK / Agents": ["claude-agent-sdk", "openai-chatkit", "openai-codex-sdk", "openai-agents", "aws-bedrock-agents", "ibm-bam"],
        "Protocol / Transport": ["mcp", "websocket", "webhook", "slack", "web-browser"],
        "Language Bridges": ["go", "ruby", "python"],
        "Utility": ["echo", "script", "sequence", "custom-http", "manual-input", "simulated-user"],
      };

      // Render every curated category, tracking which providers we've shown so
      // the leftover "Other" bucket can catch any registered-but-uncategorised
      // provider. We iterate the REGISTRY (`providers`) for membership so a
      // category entry that no longer exists is simply skipped.
      const shown = new Set<string>();
      for (const [category, ids] of Object.entries(categories)) {
        const available = ids.filter((id) => providers.includes(id));
        if (available.length === 0) continue;
        console.log(`  ${chalk.bold(category)}`);
        for (const id of available) {
          shown.add(id);
          console.log(`    ${chalk.cyan(id)}`);
        }
        console.log();
      }

      // Anything the registry knows about but no curated category claimed.
      // Guarantees the human view lists ALL providers (count parity with the
      // header and `--json`).
      const other = providers.filter((id: string) => !shown.has(id));
      if (other.length > 0) {
        console.log(`  ${chalk.bold("Other")}`);
        for (const id of other) {
          console.log(`    ${chalk.cyan(id)}`);
        }
        console.log();
      }
    });

  // ─── list attacks ───
  list
    .command("attacks")
    .description("List legacy attack types")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { ATTACK_TYPES } = await import("@evalguard/core") as any;

      const attacks = ATTACK_TYPES.map((a: any) => ({
        type: a.type,
        name: a.name,
        severity: a.severity,
        payloadCount: a.payloads.length,
      }));

      if (opts.json) {
        console.log(JSON.stringify(attacks, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Legacy Attack Types (${attacks.length})`));
      console.log();
      for (const a of attacks) {
        const sevColor = a.severity === "critical" ? chalk.red : a.severity === "high" ? chalk.yellow : chalk.dim;
        console.log(`  ${chalk.cyan(a.type.padEnd(25))} ${sevColor(a.severity.padEnd(10))} ${a.payloadCount} payloads`);
      }
      console.log();
    });
}
