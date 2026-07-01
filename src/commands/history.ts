/**
 * `evalguard history` — View local eval/scan run history
 * Stored in ~/.evalguard/results.json (SQLite-like local persistence)
 */
import { Command } from "commander";
import chalk from "chalk";
import { listRuns, getRun } from "./store.js";

export function registerHistory(program: Command): void {
  program
    .command("history")
    .description("View local eval/scan run history (offline storage)")
    .option("-t, --type <type>", "Filter by type: eval or scan")
    .option("-n, --limit <number>", "Number of runs to show", "20")
    .option("--id <id>", "Show details for a specific run")
    .option("--json", "Output as JSON", false)
    .action((opts: { type?: string; limit: string; id?: string; json: boolean }) => {
      if (opts.id) {
        const run = getRun(opts.id);
        if (!run) {
          console.error(chalk.red(`Run not found: ${opts.id}`));
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(run, null, 2));
        } else {
          console.log();
          console.log(chalk.bold(`  ${run.name}`));
          console.log(chalk.dim(`  ID: ${run.id}`));
          console.log(chalk.dim(`  Type: ${run.type} | Model: ${run.model} | Provider: ${run.provider}`));
          console.log(chalk.dim(`  Time: ${run.timestamp}`));
          console.log();
          const color = run.passRate >= 0.8 ? chalk.green : run.passRate >= 0.5 ? chalk.yellow : chalk.red;
          console.log(`  Pass rate: ${color((run.passRate * 100).toFixed(1) + "%")}`);
          console.log(`  Results:   ${chalk.green(run.passed + " passed")} / ${chalk.red(run.failed + " failed")} / ${run.total} total`);
          console.log(`  Score:     ${run.score.toFixed(2)}/${run.maxScore}`);
          console.log(`  Latency:   ${run.latencyMs}ms`);
          console.log();
        }
        return;
      }

      const type = opts.type as "eval" | "scan" | undefined;
      const runs = listRuns(type, parseInt(opts.limit));

      if (runs.length === 0) {
        console.log(chalk.dim("\n  No runs found. Run `evalguard eval:local` or `evalguard gate` first.\n"));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Recent Runs (${runs.length})`));
      console.log(chalk.dim("  " + "-".repeat(80)));

      for (const run of runs) {
        const color = run.passRate >= 0.8 ? chalk.green : run.passRate >= 0.5 ? chalk.yellow : chalk.red;
        const icon = run.passRate >= 0.8 ? chalk.green("✓") : chalk.red("✗");
        const date = new Date(run.timestamp).toLocaleString();
        console.log(`  ${icon} ${chalk.bold(run.name.slice(0, 30).padEnd(30))} ${color((run.passRate * 100).toFixed(0).padStart(4) + "%")} ${chalk.dim(`${run.passed}/${run.total}`)} ${chalk.dim(run.model.padEnd(15))} ${chalk.dim(date)}`);
      }
      console.log();
    });
}
