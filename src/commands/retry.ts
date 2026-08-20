/**
 * `evalguard retry` — Retry only failed test cases from a previous run
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import ora from "ora";
import { getRun, storeRun, generateId, StoredRun } from "./store.js";
import { boundedFetch, decodeJsonBody } from "../lib/http.js";

export function registerRetry(program: Command): void {
  program
    .command("retry")
    .description("Retry only failed test cases from a previous run")
    .argument("<runId>", "Run ID to retry failures from")
    .option("--model <model>", "Override model for the retry")
    .option("--max <n>", "Maximum number of cases to retry", "0")
    .action(async (runId: string, opts: { model?: string; max: string }) => {
      const run = getRun(runId);
      if (!run) {
        console.error(chalk.red(`Run not found: ${runId}`));
        console.log(chalk.dim("  Use `evalguard history` to list available runs."));
        process.exit(1);
      }

      if (!run.results || run.results.length === 0) {
        console.error(chalk.red("No detailed results stored for this run. Cannot determine failed cases."));
        console.log(chalk.dim("  Re-run with eval:local to store case-level results."));
        process.exit(1);
      }

      const failedCases = run.results.filter(
        (r: Record<string, unknown>) => r.passed === false || r.status === "failed"
      );

      if (failedCases.length === 0) {
        console.log(chalk.green("✓") + " No failed cases to retry. All cases passed!");
        return;
      }

      const maxRetries = parseInt(opts.max, 10);
      const casesToRetry = maxRetries > 0 ? failedCases.slice(0, maxRetries) : failedCases;
      const model = opts.model ?? run.model;

      console.log();
      console.log(chalk.bold(`  Retrying ${casesToRetry.length} failed case(s) from "${run.name}"`));
      console.log(chalk.dim(`  Model: ${model} | Original run: ${run.id}`));
      console.log();

      const spinner = ora(`Retrying ${casesToRetry.length} cases...`).start();

      try {
        const baseUrl = resolveBaseUrl();
        const apiKey = resolveApiKey();

        if (!apiKey) {
          spinner.fail("Not authenticated. Run `evalguard login` first.");
          process.exit(1);
        }

        const res = await boundedFetch(`${baseUrl}/evals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            name: `${run.name} (retry)`,
            model,
            retryOf: run.id,
            cases: casesToRetry.map((c: Record<string, unknown>) => ({
              input: c.input,
              expectedOutput: c.expectedOutput ?? c.expected,
            })),
          }),
        });

        const data = (await decodeJsonBody(res, "retry")) as Record<string, unknown>;

        if (!res.ok) {
          throw new Error(`API error ${res.status}: ${data.message ?? "Unknown error"}`);
        }

        const retryData = (data.data ?? data) as Record<string, unknown>;
        spinner.succeed(`Retry submitted: ${chalk.cyan(retryData.id as string)}`);
        console.log(chalk.dim(`  ${casesToRetry.length} failed cases sent for re-evaluation`));
        console.log(chalk.dim(`  Use \`evalguard history --id ${retryData.id}\` to view results`));
        console.log();
      } catch (err) {
        spinner.fail(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
