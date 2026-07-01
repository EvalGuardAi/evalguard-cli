/**
 * `evalguard benchmark list`                     — list available benchmarks
 * `evalguard benchmark run <suite> --model <id>`  — run a benchmark suite against a model
 */
import { Command } from "commander";
import chalk from "chalk";

export function registerBenchmark(program: Command): void {
  const bench = program
    .command("benchmark")
    .description("Run and manage ML evaluation benchmarks");

  // ─── benchmark list ───
  bench
    .command("list")
    .description("List all available benchmark suites")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { listBenchmarks } = await import("@evalguard/core") as any;
      const benchmarks = listBenchmarks();

      if (opts.json) {
        console.log(JSON.stringify(benchmarks, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Available Benchmarks (${benchmarks.length})`));
      console.log();
      console.log(
        `  ${chalk.dim("ID".padEnd(18))}${chalk.dim("Name".padEnd(22))}${chalk.dim("Category".padEnd(16))}${chalk.dim("Samples".padEnd(10))}${chalk.dim("Description")}`
      );
      console.log(chalk.dim("  " + "─".repeat(100)));

      for (const b of benchmarks) {
        const catColor =
          b.category === "safety"
            ? chalk.red
            : b.category === "code"
              ? chalk.green
              : b.category === "math"
                ? chalk.yellow
                : b.category === "reasoning"
                  ? chalk.blue
                  : chalk.cyan;

        console.log(
          `  ${chalk.cyan(b.id.padEnd(18))}${chalk.white(b.name.padEnd(22))}${catColor(b.category.padEnd(16))}${chalk.white(String(b.sampleCount).padEnd(10))}${chalk.dim(b.description.slice(0, 60))}`
        );
      }
      console.log();
    });

  // ─── benchmark run ───
  bench
    .command("run <suite>")
    .description("Run a benchmark suite against a model")
    .option("-m, --model <model>", "Model to evaluate (e.g. gpt-4o-mini, claude-3-5-sonnet)")
    .option("-s, --sample <count>", "Number of samples to run", "50")
    .option("-p, --provider <provider>", "LLM provider (default: auto-detect from model name)")
    .option("--json", "Output results as JSON", false)
    .option("--api-key <key>", "API key for the provider (or use env vars)")
    .action(
      async (
        suite: string,
        opts: {
          model?: string;
          sample: string;
          provider?: string;
          json: boolean;
          apiKey?: string;
        }
      ) => {
        const { runBenchmarks, ALL_BENCHMARKS } = await import("@evalguard/core") as any;
        const samplesPerSuite = parseInt(opts.sample, 10) || 50;

        // Validate benchmark exists
        const suiteObj = ALL_BENCHMARKS.find(
          (b: any) => b.id.toLowerCase() === suite.toLowerCase()
        );
        if (!suiteObj) {
          const available = ALL_BENCHMARKS.map((b: any) => b.id).join(", ");
          console.error(
            chalk.red(`\n  Unknown benchmark: "${suite}"`)
          );
          console.error(
            chalk.dim(`  Available: ${available}\n`)
          );
          process.exit(1);
        }

        if (!opts.model) {
          console.error(
            chalk.red("\n  --model is required. Example: evalguard benchmark run mmlu --model gpt-4o-mini\n")
          );
          process.exit(1);
        }

        console.log();
        console.log(
          chalk.bold(`  Benchmark: ${suiteObj.name}`) +
            chalk.dim(` (${suiteObj.id})`)
        );
        console.log(chalk.dim(`  Model: ${opts.model}`));
        console.log(
          chalk.dim(
            `  Samples: ${Math.min(samplesPerSuite, suiteObj.sampleCount)} of ${suiteObj.sampleCount} available`
          )
        );
        console.log();

        // Build LLM caller
        let callLLM: (prompt: string) => Promise<string>;

        try {
          const { createProvider } = await import("@evalguard/core") as any;
          const provider = createProvider(
            opts.provider ?? opts.model,
            opts.model,
            { apiKey: opts.apiKey }
          );
          callLLM = async (prompt: string) => {
            const result = await provider.complete(prompt);
            return result.text ?? result.content ?? String(result);
          };
        } catch {
          // Fallback: echo provider for dry-run testing
          console.log(
            chalk.yellow(
              "  Warning: Could not initialize provider. Using echo mode for dry-run.\n"
            )
          );
          callLLM = async (prompt: string) => `Echo: ${prompt.slice(0, 100)}`;
        }

        // Run with progress
        const startTime = Date.now();
        let lastPrinted = 0;

        const result = await runBenchmarks({
          suites: [suiteObj.id],
          samplesPerSuite,
          callLLM,
          onProgress: (
            _suiteId: string,
            completed: number,
            total: number
          ) => {
            if (!opts.json && completed - lastPrinted >= 5) {
              const pct = Math.round((completed / total) * 100);
              process.stdout.write(
                `\r  Progress: ${completed}/${total} (${pct}%)`
              );
              lastPrinted = completed;
            }
          },
        });

        if (!opts.json) {
          process.stdout.write("\r" + " ".repeat(60) + "\r");
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Display results
        for (const sr of result.suiteResults) {
          console.log(chalk.bold(`  Results: ${sr.suiteName}`));
          console.log(chalk.dim(`  ${"─".repeat(50)}`));
          console.log(
            `  Accuracy:  ${colorAccuracy(sr.accuracy)} (${sr.correct}/${sr.totalSamples})`
          );
          console.log(
            `  Avg Score: ${chalk.white((sr.avgScore * 100).toFixed(1) + "%")}`
          );
          console.log(`  Duration:  ${chalk.white(elapsed + "s")}`);

          if (sr.categoryBreakdown && Object.keys(sr.categoryBreakdown).length > 1) {
            console.log();
            console.log(chalk.dim("  Category Breakdown:"));
            for (const [cat, stats] of Object.entries(sr.categoryBreakdown) as any) {
              const acc = stats.accuracy;
              console.log(
                `    ${chalk.cyan(cat.padEnd(25))} ${colorAccuracy(acc)} (${stats.correct}/${stats.total})`
              );
            }
          }
        }

        console.log();
      }
    );

  // ─── benchmark info ───
  bench
    .command("info <suite>")
    .description("Show detailed information about a benchmark suite")
    .action(async (suite: string) => {
      const { ALL_BENCHMARKS } = await import("@evalguard/core") as any;

      const suiteObj = ALL_BENCHMARKS.find(
        (b: any) => b.id.toLowerCase() === suite.toLowerCase()
      );
      if (!suiteObj) {
        const available = ALL_BENCHMARKS.map((b: any) => b.id).join(", ");
        console.error(chalk.red(`\n  Unknown benchmark: "${suite}"`));
        console.error(chalk.dim(`  Available: ${available}\n`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold(`  ${suiteObj.name}`) + chalk.dim(` (${suiteObj.id})`));
      console.log(chalk.dim(`  ${"─".repeat(50)}`));
      console.log(`  ${chalk.dim("Description:")} ${suiteObj.description}`);
      console.log(`  ${chalk.dim("Category:")}    ${suiteObj.category}`);
      console.log(`  ${chalk.dim("Samples:")}     ${suiteObj.sampleCount}`);

      // Show a few example tasks
      const samples = suiteObj.generateSamples(3);
      console.log();
      console.log(chalk.dim("  Example tasks:"));
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const preview = s.input.replace(/\n/g, " ").slice(0, 80);
        console.log(`    ${chalk.cyan(`${i + 1}.`)} ${preview}${s.input.length > 80 ? "..." : ""}`);
        if (s.category) {
          console.log(`       ${chalk.dim(`Category: ${s.category}`)}`);
        }
      }
      console.log();
    });
}

function colorAccuracy(accuracy: number): string {
  const pct = (accuracy * 100).toFixed(1) + "%";
  if (accuracy >= 0.8) return chalk.green(pct);
  if (accuracy >= 0.5) return chalk.yellow(pct);
  return chalk.red(pct);
}
