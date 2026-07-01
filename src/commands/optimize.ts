/**
 * `evalguard optimize` — Automatic prompt optimization
 *
 * Rewrites prompts to maximize evaluation scores using 4 strategies:
 *   - iterative-refinement: LLM diagnoses weaknesses and rewrites
 *   - genetic: Population-based crossover/mutation evolution
 *   - few-shot-injection: Auto-selects best few-shot examples
 *   - constraint-tightening: Analyzes failures and adds guardrails
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";

type OptimizationStrategyName = "iterative-refinement" | "genetic" | "few-shot-injection" | "constraint-tightening";

const VALID_STRATEGIES: OptimizationStrategyName[] = [
  "iterative-refinement",
  "genetic",
  "few-shot-injection",
  "constraint-tightening",
];

interface OptimizeOpts {
  config?: string;
  prompt?: string;
  strategy: string;
  maxIterations: string;
  targetScore: string;
  scorers: string;
  model: string;
  provider: string;
  testCases?: string;
  output?: string;
  populationSize: string;
  mutationRate: string;
  crossoverRate: string;
  eliteCount: string;
  maxExamples: string;
  all: boolean;
}

export function registerOptimize(program: Command): void {
  program
    .command("optimize")
    .description("Automatically optimize a prompt to maximize evaluation scores")
    .option("-c, --config <file>", "Path to evalguard.yaml config file")
    .option("-p, --prompt <text>", "Prompt text to optimize (or use --config)")
    .option(
      "-s, --strategy <name>",
      `Optimization strategy: ${VALID_STRATEGIES.join(", ")}`,
      "iterative-refinement",
    )
    .option("-n, --max-iterations <n>", "Maximum optimization iterations", "10")
    .option("-t, --target-score <score>", "Target score to stop early (0-1)", "0.95")
    .option("--scorers <list>", "Comma-separated scorer names", "answer-relevance")
    .option("--model <model>", "LLM model for generation", "gpt-4o")
    .option("--provider <provider>", "Provider name", "openai")
    .option("--test-cases <file>", "JSON file with test cases [{input, expectedOutput}]")
    .option("-o, --output <file>", "Output file for the optimized prompt")
    .option("--population-size <n>", "Population size (genetic strategy)", "8")
    .option("--mutation-rate <rate>", "Mutation rate 0-1 (genetic)", "0.3")
    .option("--crossover-rate <rate>", "Crossover rate 0-1 (genetic)", "0.5")
    .option("--elite-count <n>", "Elite count (genetic)", "2")
    .option("--max-examples <n>", "Max few-shot examples", "5")
    .option("--all", "Run all 4 strategies and pick the best", false)
    .action(async (opts: OptimizeOpts) => {
      const { PromptOptimizationEngine, createProvider } = await import("@evalguard/core") as any;

      // Resolve prompt
      let prompt: string;
      let testCases: Array<{ input: string; expectedOutput?: string }> = [];

      if (opts.config) {
        const configPath = path.resolve(opts.config);
        if (!fs.existsSync(configPath)) {
          console.error(chalk.red(`Config file not found: ${configPath}`));
          process.exit(1);
        }
        const configData = fs.readFileSync(configPath, "utf-8");
        // Simple YAML-like parsing for prompt and cases
        const parsed = parseSimpleConfig(configData);
        prompt = parsed.prompt || opts.prompt || "";
        if (parsed.cases.length > 0) testCases = parsed.cases;
      } else if (opts.prompt) {
        prompt = opts.prompt;
      } else {
        console.error(chalk.red("Either --config or --prompt is required."));
        process.exit(1);
      }

      if (!prompt) {
        console.error(chalk.red("No prompt found. Provide via --prompt or --config."));
        process.exit(1);
      }

      // Load test cases from file if specified
      if (opts.testCases) {
        const tcPath = path.resolve(opts.testCases);
        if (!fs.existsSync(tcPath)) {
          console.error(chalk.red(`Test cases file not found: ${tcPath}`));
          process.exit(1);
        }
        const tcData = JSON.parse(fs.readFileSync(tcPath, "utf-8"));
        testCases = (tcData.cases ?? tcData).map((c: any) => ({
          input: c.input,
          expectedOutput: c.expectedOutput ?? c.expected,
        }));
      }

      if (testCases.length === 0) {
        console.error(chalk.red("No test cases provided. Use --test-cases or include in config."));
        process.exit(1);
      }

      // Validate strategy
      const strategy = opts.strategy as OptimizationStrategyName;
      if (!opts.all && !VALID_STRATEGIES.includes(strategy)) {
        console.error(
          chalk.red(`Invalid strategy "${strategy}". Choose from: ${VALID_STRATEGIES.join(", ")}`),
        );
        process.exit(1);
      }

      // Build LLM caller
      const callLLM = await makeCallLLM(opts.provider, opts.model, createProvider);

      const scorers = opts.scorers.split(",").map((s: string) => s.trim());

      console.log();
      console.log(chalk.bold("  EvalGuard Prompt Optimizer"));
      console.log(chalk.dim("  ========================"));
      console.log(`  Strategy:    ${chalk.cyan(opts.all ? "all (best-of-4)" : strategy)}`);
      console.log(`  Iterations:  ${chalk.cyan(opts.maxIterations)}`);
      console.log(`  Target:      ${chalk.cyan(opts.targetScore)}`);
      console.log(`  Scorers:     ${chalk.cyan(scorers.join(", "))}`);
      console.log(`  Test cases:  ${chalk.cyan(String(testCases.length))}`);
      console.log(`  Model:       ${chalk.cyan(`${opts.provider}/${opts.model}`)}`);
      console.log();

      const spinner = ora(
        opts.all ? "Running all 4 strategies..." : `Running ${strategy} optimization...`,
      ).start();

      try {
        const engine = new PromptOptimizationEngine();

        const baseConfig = {
          prompt,
          evalCases: testCases,
          scorers,
          callLLM,
          targetModel: `${opts.provider}/${opts.model}`,
          maxIterations: parseInt(opts.maxIterations, 10),
          targetScore: parseFloat(opts.targetScore),
          populationSize: parseInt(opts.populationSize, 10),
          mutationRate: parseFloat(opts.mutationRate),
          crossoverRate: parseFloat(opts.crossoverRate),
          eliteCount: parseInt(opts.eliteCount, 10),
          maxExamples: parseInt(opts.maxExamples, 10),
        };

        let result: any;

        if (opts.all) {
          result = await engine.optimizeAll(baseConfig);
        } else {
          result = await engine.optimize({ ...baseConfig, strategy });
        }

        spinner.stop();

        // Display results
        console.log();
        console.log(chalk.bold.green("  Optimization Complete"));
        console.log();
        console.log(`  Strategy:          ${chalk.cyan(result.strategy)}`);
        console.log(`  Original Score:    ${chalk.yellow(result.originalScore.toFixed(3))}`);
        console.log(`  Optimized Score:   ${chalk.green(result.optimizedScore.toFixed(3))}`);
        console.log(
          `  Improvement:       ${result.improvementPercent > 0 ? chalk.green(`+${result.improvementPercent}%`) : chalk.dim("0%")}`,
        );
        console.log(`  Iterations:        ${chalk.cyan(String(result.iterations.length))}`);
        console.log(`  Duration:          ${chalk.dim(`${(result.durationMs / 1000).toFixed(1)}s`)}`);

        if (result.allResults) {
          console.log();
          console.log(chalk.bold("  All Strategy Results:"));
          for (const r of result.allResults) {
            const icon = r.strategy === result.strategy ? chalk.green("*") : " ";
            console.log(
              `  ${icon} ${r.strategy.padEnd(24)} score=${r.optimizedScore.toFixed(3)} (+${r.improvementPercent}%) ${chalk.dim(`${(r.durationMs / 1000).toFixed(1)}s`)}`,
            );
          }
        }

        // Show changelog
        if (result.changelog.length > 0) {
          console.log();
          console.log(chalk.bold("  Changelog:"));
          for (const entry of result.changelog.slice(0, 10)) {
            console.log(`    ${chalk.dim("-")} ${entry}`);
          }
          if (result.changelog.length > 10) {
            console.log(chalk.dim(`    ... and ${result.changelog.length - 10} more`));
          }
        }

        // Show prompt preview
        console.log();
        console.log(chalk.bold("  Optimized Prompt (preview):"));
        const preview = result.optimizedPrompt.slice(0, 300);
        console.log(`    ${chalk.white(preview)}${result.optimizedPrompt.length > 300 ? chalk.dim("...") : ""}`);

        // Save output
        if (opts.output) {
          const outputPath = path.resolve(opts.output);
          const outputData = {
            strategy: result.strategy,
            originalPrompt: prompt,
            optimizedPrompt: result.optimizedPrompt,
            originalScore: result.originalScore,
            optimizedScore: result.optimizedScore,
            improvementPercent: result.improvementPercent,
            iterations: result.iterations.length,
            changelog: result.changelog,
            durationMs: result.durationMs,
            config: {
              scorers,
              model: opts.model,
              provider: opts.provider,
              maxIterations: parseInt(opts.maxIterations, 10),
              targetScore: parseFloat(opts.targetScore),
            },
            optimizedAt: new Date().toISOString(),
          };
          fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
          console.log();
          console.log(`  ${chalk.green("+")} Saved to ${chalk.cyan(outputPath)}`);
        } else {
          // Default: save optimized prompt to file
          const defaultOutput = "optimized-prompt.json";
          const outputData = {
            optimizedPrompt: result.optimizedPrompt,
            originalScore: result.originalScore,
            optimizedScore: result.optimizedScore,
            strategy: result.strategy,
            optimizedAt: new Date().toISOString(),
          };
          fs.writeFileSync(defaultOutput, JSON.stringify(outputData, null, 2));
          console.log();
          console.log(`  ${chalk.green("+")} Saved to ${chalk.cyan(defaultOutput)}`);
        }
      } catch (err) {
        spinner.fail(`Optimization failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

// ── Helpers ──

function parseSimpleConfig(content: string): { prompt: string; cases: Array<{ input: string; expectedOutput?: string }> } {
  let prompt = "";
  const cases: Array<{ input: string; expectedOutput?: string }> = [];

  // Try JSON first
  try {
    const parsed = JSON.parse(content);
    return {
      prompt: parsed.prompt ?? "",
      cases: (parsed.cases ?? parsed.testCases ?? []).map((c: any) => ({
        input: c.input,
        expectedOutput: c.expectedOutput ?? c.expected,
      })),
    };
  } catch {
    // Not JSON, try simple YAML-like parsing
  }

  // Simple YAML extraction
  const promptMatch = content.match(/prompt:\s*[|>]?\s*\n([\s\S]*?)(?=\n\w|\ncases:|$)/);
  if (promptMatch) {
    prompt = promptMatch[1].replace(/^\s{2,}/gm, "").trim();
  } else {
    const inlineMatch = content.match(/prompt:\s*["'](.+?)["']/);
    if (inlineMatch) prompt = inlineMatch[1];
  }

  return { prompt, cases };
}

async function makeCallLLM(
  providerName: string,
  model: string,
  createProvider: any,
): Promise<(prompt: string) => Promise<string>> {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const envKey = envMap[providerName] ?? `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const apiKey = process.env[envKey] ?? process.env.EVALGUARD_PROVIDER_KEY ?? "";

  const provider = createProvider(providerName as any, apiKey);
  return async (prompt: string) => {
    const response = await provider.chat([{ role: "user", content: prompt }], { model });
    return response.content;
  };
}
