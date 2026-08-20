/**
 * `evalguard pricing` — model pricing DB inspection + cost estimator.
 *
 *   evalguard pricing list                                           List every model in the DB
 *   evalguard pricing list --provider openai                         Filter to one vendor
 *   evalguard pricing lookup <model>                                 Show one model's full row
 *   evalguard pricing estimate <model> --input N --output N [--cached N]
 *   evalguard pricing stale [--max-age-months 12]                    Refresh-overdue rows
 *
 * Backed by `@evalguard/core/cost/model-pricing.ts`. Read-only — no
 * gateway calls, no API key required.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  MODEL_PRICING_DB,
  getModelPricing,
  calculateModelCost,
  findStalePricing,
} from "@evalguard/core";

function formatPerMillion(perToken: number): string {
  return `$${(perToken * 1_000_000).toFixed(3)}/M`;
}

function renderRow(modelId: string, p: (typeof MODEL_PRICING_DB)[string]): void {
  const cached = p.cachedInputPerToken !== undefined
    ? `cached ${formatPerMillion(p.cachedInputPerToken)}`
    : chalk.dim("(no cache rate)");
  console.log(
    `  ${chalk.bold(modelId.padEnd(28))}` +
      `${chalk.dim(p.provider.padEnd(10))}` +
      `in ${formatPerMillion(p.inputPerToken).padEnd(12)} ` +
      `out ${formatPerMillion(p.outputPerToken).padEnd(12)} ` +
      `${cached.padEnd(20)} ` +
      chalk.dim(p.lastUpdated),
  );
}

export function registerPricing(program: Command): void {
  const pricing = program
    .command("pricing")
    .description("Inspect the structured model-pricing database (read-only)");

  pricing
    .command("list")
    .description("List every model in the DB with input/output/cache rates")
    .option("--provider <name>", "Filter to one vendor (openai, anthropic, google, ...)")
    .option("--json", "Output as JSON", false)
    .action((opts: { provider?: string; json?: boolean }) => {
      const filtered = Object.entries(MODEL_PRICING_DB).filter(([, p]) =>
        opts.provider ? p.provider === opts.provider.toLowerCase() : true,
      );
      if (opts.json) {
        console.log(JSON.stringify(Object.fromEntries(filtered), null, 2));
        // Same gate as the text path below (audit 2026-08-09:
        // cli-json-branch-skips-exit-gate) — `--json` printed `{}` and exited 0
        // for a provider filter that matched nothing, while the text path exits 1.
        if (filtered.length === 0) process.exit(1);
        return;
      }
      if (filtered.length === 0) {
        console.error(chalk.yellow(`No models match provider="${opts.provider ?? ""}".`));
        process.exit(1);
      }
      console.log();
      console.log(chalk.bold(`  ${filtered.length} model${filtered.length === 1 ? "" : "s"}`));
      console.log();
      for (const [id, p] of filtered) renderRow(id, p);
      console.log();
    });

  pricing
    .command("lookup")
    .description("Show full pricing for a single model (substring + longest-prefix match)")
    .argument("<model>", "Model id (bare or provider-prefixed, e.g. 'gpt-4o' or 'openai:gpt-4o-2024-08-06')")
    .option("--json", "Output as JSON", false)
    .action((model: string, opts: { json?: boolean }) => {
      const p = getModelPricing(model);
      if (!p) {
        console.error(chalk.red(`No pricing entry for "${model}". Try \`evalguard pricing list\` to see available models.`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ matched: model, pricing: p }, null, 2));
        return;
      }
      console.log();
      console.log(`  ${chalk.bold(model)}`);
      console.log(`  ${chalk.dim("Provider")}      ${p.provider}`);
      console.log(`  ${chalk.dim("Input")}         ${formatPerMillion(p.inputPerToken)}`);
      console.log(`  ${chalk.dim("Output")}        ${formatPerMillion(p.outputPerToken)}`);
      if (p.cachedInputPerToken !== undefined) {
        console.log(`  ${chalk.dim("Cached input")}  ${formatPerMillion(p.cachedInputPerToken)}`);
      }
      if (p.audioInputPerToken !== undefined) {
        console.log(`  ${chalk.dim("Audio input")}   ${formatPerMillion(p.audioInputPerToken)}`);
      }
      if (p.audioOutputPerToken !== undefined) {
        console.log(`  ${chalk.dim("Audio output")}  ${formatPerMillion(p.audioOutputPerToken)}`);
      }
      console.log(`  ${chalk.dim("Last updated")}  ${p.lastUpdated}`);
      if (p.source) console.log(`  ${chalk.dim("Source")}        ${p.source}`);
      console.log();
    });

  pricing
    .command("estimate")
    .description("Compute cost for a model + token counts using the structured DB")
    .argument("<model>", "Model id")
    .requiredOption("--input <count>", "Input tokens", (v) => parseInt(v, 10))
    .requiredOption("--output <count>", "Output tokens", (v) => parseInt(v, 10))
    .option("--cached <count>", "Cached input tokens (subtracted from input, billed at the cache rate)", (v) => parseInt(v, 10), 0)
    .option("--json", "Output as JSON", false)
    .action((model: string, opts: { input: number; output: number; cached: number; json?: boolean }) => {
      if (!Number.isFinite(opts.input) || opts.input < 0) { console.error(chalk.red("--input must be a non-negative integer")); process.exit(1); }
      if (!Number.isFinite(opts.output) || opts.output < 0) { console.error(chalk.red("--output must be a non-negative integer")); process.exit(1); }
      if (!Number.isFinite(opts.cached) || opts.cached < 0) { console.error(chalk.red("--cached must be a non-negative integer")); process.exit(1); }

      const result = calculateModelCost(model, {
        inputTokens: opts.input,
        outputTokens: opts.output,
        cachedInputTokens: opts.cached,
      });

      if (opts.json) {
        console.log(JSON.stringify({ model, ...result }, null, 2));
        return;
      }

      console.log();
      console.log(`  ${chalk.bold(model)}  ${result.pricingUsed ? "" : chalk.yellow("(unknown model — used $3/M fallback)")}`);
      console.log(`  ${chalk.dim("Input")}        $${result.inputCost.toFixed(6)}  (${(opts.input - opts.cached).toLocaleString()} tokens)`);
      console.log(`  ${chalk.dim("Output")}       $${result.outputCost.toFixed(6)}  (${opts.output.toLocaleString()} tokens)`);
      if (opts.cached > 0) {
        console.log(`  ${chalk.dim("Cached")}       $${result.cachedInputCost.toFixed(6)}  (${opts.cached.toLocaleString()} tokens)`);
      }
      console.log(`  ${chalk.bold("Total")}        ${chalk.green(`$${result.totalCost.toFixed(6)}`)}`);
      console.log();
    });

  pricing
    .command("stale")
    .description("List pricing entries older than the configured window (default 12 months)")
    .option("--max-age-months <n>", "Maximum allowed age", (v) => parseInt(v, 10), 12)
    .option("--json", "Output as JSON", false)
    .action((opts: { maxAgeMonths: number; json?: boolean }) => {
      const stale = findStalePricing(new Date(), opts.maxAgeMonths);
      if (opts.json) {
        console.log(JSON.stringify({ thresholdMonths: opts.maxAgeMonths, stale }, null, 2));
        // `pricing stale --json` IS the CI form of this check, and it was the one
        // that could not fail (audit 2026-08-09: cli-json-branch-skips-exit-gate).
        // The text path exits 1 on the same input via the gate below.
        if (stale.length > 0) process.exit(1);
        return;
      }
      if (stale.length === 0) {
        console.log(chalk.green(`  ✓ All ${Object.keys(MODEL_PRICING_DB).length} entries are within ${opts.maxAgeMonths} months.`));
        return;
      }
      console.error(chalk.red(`  ✗ ${stale.length} entr${stale.length === 1 ? "y is" : "ies are"} stale (> ${opts.maxAgeMonths} months):`));
      for (const s of stale) {
        console.error(`    - ${chalk.bold(s.modelId.padEnd(28))} ${chalk.dim(`${s.lastUpdated} (${s.ageDays}d old)`)}`);
      }
      process.exit(1);
    });
}
