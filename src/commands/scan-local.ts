/**
 * `evalguard scan:local <file>` — Run red team security scan locally
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";

type RedTeamPlugin = any;
type TransformStrategy = any;
type Grader = any;
type SecurityScanResult = any;

interface LocalScanConfig {
  model?: string;
  provider?: string;
  prompt: string;
  systemPrompt?: string;
  purpose?: string;
  attackTypes?: string[];
  plugins?: string[];
  strategies?: string[];
  graders?: string[];
  maxConcurrency?: number;
  output?: string;
  // Nested shapes also accepted by `evalguard validate` — normalized below so a
  // validated config never crashes scan:local.
  target?: { model?: string; provider?: string };
  redteam?: {
    plugins?: string[];
    strategies?: string[];
    graders?: string[];
    attackTypes?: string[];
    numTests?: number;
    maxConcurrency?: number;
  };
}

export function registerScanLocal(program: Command): void {
  program
    .command("scan:local")
    .description("Run red team security scan locally (no API key needed)")
    .argument("<file>", "Path to scan config JSON/YAML file")
    .option("--model <model>", "Override model")
    .option("--provider <provider>", "Override provider")
    .option("--output <format>", "Output format: json or file path")
    .option("--verbose", "Show each finding", false)
    .action(async (file: string, opts: { model?: string; provider?: string; output?: string; verbose?: boolean }) => {
      const core = await import("@evalguard/core");
      const { runSecurityScan, ATTACK_TYPES, ALL_PLUGINS, ALL_STRATEGIES, ALL_GRADERS, createProvider } = core as any;

      const spinner = ora("Loading scan config...").start();

      try {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const raw = fs.readFileSync(filePath, "utf-8");
        let config: LocalScanConfig;
        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
          const { parse: parseYaml } = await import("yaml");
          config = parseYaml(raw);
        } else {
          config = JSON.parse(raw);
        }
        let model: string, providerName: string;
        try {
          ({ model, providerName } = normalizeScanConfig(config, opts));
        } catch (e) {
          spinner.fail(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }
        const apiKey = resolveApiKey(providerName);

        const provider = createProvider(providerName as any, apiKey);
        const callLLM = async (prompt: string): Promise<string> => {
          const response = await provider.chat([{ role: "user", content: prompt }], { model });
          return response.content;
        };

        // Resolve plugins, strategies, graders
        const pluginMap = Object.fromEntries(ALL_PLUGINS.map((p: any) => [p.id, p]));
        const strategyMap = Object.fromEntries(ALL_STRATEGIES.map((s: any) => [s.id, s]));
        const graderMap = Object.fromEntries(ALL_GRADERS.map((g: any) => [g.id, g]));

        const plugins: RedTeamPlugin[] | undefined = config.plugins?.map((id: string) => {
          if (!pluginMap[id]) throw new Error(`Unknown plugin: ${id}. Available: ${ALL_PLUGINS.map((p: any) => p.id).join(", ")}`);
          return pluginMap[id];
        });

        const strategies: TransformStrategy[] | undefined = config.strategies?.map((id: string) => {
          if (!strategyMap[id]) throw new Error(`Unknown strategy: ${id}. Available: ${ALL_STRATEGIES.map((s: any) => s.id).join(", ")}`);
          return strategyMap[id];
        });

        const graders: Grader[] | undefined = config.graders?.map((id: string) => {
          if (!graderMap[id]) throw new Error(`Unknown grader: ${id}. Available: ${ALL_GRADERS.map((g: any) => g.id).join(", ")}`);
          return graderMap[id];
        });

        const mode = plugins ? "plugin pipeline" : "legacy";
        const count = plugins ? `${plugins.length} plugins` : `${config.attackTypes?.length ?? ATTACK_TYPES.length} attack types`;
        spinner.text = `Scanning with ${count} (${mode}) on ${model}...`;

        const result = await runSecurityScan({
          prompt: config.prompt,
          systemPrompt: config.systemPrompt,
          purpose: config.purpose,
          attackTypes: (config.attackTypes ?? ATTACK_TYPES.map((a: any) => a.type)),
          callLLM,
          plugins,
          strategies,
          graders,
          maxConcurrency: config.maxConcurrency,
        });

        spinner.stop();
        displayScanResults(result, opts.verbose ?? false);

        if (opts.output) {
          const outPath = opts.output === "json" ? "evalguard-scan.json" : opts.output;
          fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
          console.log(`  ${chalk.green("✓")} Results saved to ${chalk.cyan(outPath)}`);
        }

        const hasCritical = result.criticalCount > 0;
        process.exit(hasCritical ? 1 : 0);
      } catch (err) {
        spinner.fail(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

function displayScanResults(result: SecurityScanResult, verbose: boolean): void {
  console.log();
  console.log(chalk.bold("  Security Scan Results"));
  console.log(chalk.dim(`  Duration: ${result.duration}ms | Total tests: ${result.totalTests}`));
  console.log();

  if (verbose) {
    for (const f of result.findings) {
      const icon = f.passed ? chalk.green("✓") : chalk.red("✗");
      const sev = f.severity === "critical" ? chalk.bgRed(` ${f.severity} `) :
                  f.severity === "high" ? chalk.red(f.severity) :
                  f.severity === "medium" ? chalk.yellow(f.severity) :
                  chalk.dim(f.severity);
      console.log(`  ${icon} [${sev}] ${f.title}`);
      if (!f.passed) {
        console.log(`    ${chalk.dim(f.description)}`);
      }
    }
    console.log();
  }

  const passRate = (result.passRate * 100).toFixed(1);
  const passColor = result.passRate >= 0.8 ? chalk.green : result.passRate >= 0.5 ? chalk.yellow : chalk.red;

  console.log(`  ${passColor("●")} Pass Rate: ${chalk.bold(passRate + "%")}`);

  if (result.criticalCount > 0) console.log(`  ${chalk.bgRed(" CRITICAL ")} ${result.criticalCount} critical vulnerabilities`);
  if (result.highCount > 0) console.log(`  ${chalk.red("HIGH")} ${result.highCount} high severity issues`);
  if (result.mediumCount > 0) console.log(`  ${chalk.yellow("MEDIUM")} ${result.mediumCount} medium severity issues`);
  if (result.lowCount > 0) console.log(`  ${chalk.dim("LOW")} ${result.lowCount} low severity issues`);
  console.log();
}

/**
 * Normalize a scan config into the flat fields the scanner reads, supporting the
 * SAME nested shapes `evalguard validate` accepts (`target.*` / `redteam.*`).
 * Mutates `config` (fills the flat fields) and returns the resolved model +
 * provider. Throws a clear error when no model can be resolved — previously a
 * config with model only under `target` left `config.model` undefined and
 * `detectProvider(undefined)` crashed with
 * "Cannot read properties of undefined (reading 'startsWith')".
 * Exported for direct unit testing (the .action() closure calls process.exit).
 */
export function normalizeScanConfig(
  config: LocalScanConfig,
  opts: { model?: string; provider?: string } = {},
): { model: string; providerName: string } {
  config.model = config.model ?? config.target?.model;
  config.provider = config.provider ?? config.target?.provider;
  config.plugins = config.plugins ?? config.redteam?.plugins;
  config.strategies = config.strategies ?? config.redteam?.strategies;
  config.graders = config.graders ?? config.redteam?.graders;
  config.attackTypes = config.attackTypes ?? config.redteam?.attackTypes;
  config.maxConcurrency =
    config.maxConcurrency ?? config.redteam?.maxConcurrency ?? config.redteam?.numTests;

  const model = opts.model ?? config.model;
  if (!model) {
    throw new Error(
      "No model specified. Set 'model' (or target.model) in the config, or pass --model <model>.",
    );
  }
  const providerName = opts.provider ?? config.provider ?? detectProvider(model);
  return { model, providerName };
}

function detectProvider(model: string): string {
  if (!model || typeof model !== "string") return "openai";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("mistral-")) return "mistral";
  if (model.includes("llama") || model.includes("mixtral")) return "groq";
  if (model.startsWith("deepseek-")) return "deepseek";
  return "openai";
}

function resolveApiKey(provider: string): string {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY",
    mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", deepseek: "DEEPSEEK_API_KEY",
    cohere: "COHERE_API_KEY", together: "TOGETHER_API_KEY",
  };
  const envKey = envMap[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return process.env[envKey] ?? process.env.EVALGUARD_PROVIDER_KEY ?? "";
}
