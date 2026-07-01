/**
 * `evalguard watch <file>` — Watch mode: re-run eval on file changes
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("Watch eval config and re-run on changes")
    .argument("<file>", "Path to eval config JSON file")
    .option("--model <model>", "Override model")
    .option("--provider <provider>", "Override provider")
    .option("--debounce <ms>", "Debounce interval in ms", "1000")
    .action(async (file: string, opts: { model?: string; provider?: string; debounce: string }) => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }

      const debounceMs = parseInt(opts.debounce, 10);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let runCount = 0;

      console.log();
      console.log(chalk.bold(`  Watching ${path.basename(file)} for changes...`));
      console.log(chalk.dim("  Press Ctrl+C to stop"));
      console.log();

      const runEval = async () => {
        runCount++;
        console.log(chalk.dim(`  ─── Run #${runCount} at ${new Date().toLocaleTimeString()} ───`));

        try {
          // Dynamic import to get fresh module state
          const { runEvaluation, BUILT_IN_SCORERS, createProvider } = await import("@evalguard/core") as any;

          const raw = fs.readFileSync(filePath, "utf-8");
          const config = JSON.parse(raw);
          const model = opts.model ?? config.model;
          const providerName = opts.provider ?? config.provider ?? "openai";

          const envMap: Record<string, string> = {
            openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY",
          };
          const envKey = envMap[providerName] ?? `${providerName.toUpperCase()}_API_KEY`;
          const apiKey = process.env[envKey] ?? "";
          const provider = createProvider(providerName as any, apiKey);

          const callLLM = async (prompt: string) => {
            const r = await provider.chat([{ role: "user", content: prompt }], { model });
            return r.content;
          };

          const result = await runEvaluation({
            model,
            prompt: config.prompt,
            cases: config.cases,
            scorers: config.scorers,
            callLLM,
            scorerOptions: config.scorerOptions,
          });

          const passed = result.cases.filter((c: any) => c.passed).length;
          const failed = result.cases.length - passed;
          const passColor = result.passRate >= 0.8 ? chalk.green : result.passRate >= 0.5 ? chalk.yellow : chalk.red;

          console.log(`  ${passColor("●")} ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)} (${(result.passRate * 100).toFixed(1)}%) ${chalk.dim(`${result.totalLatency}ms`)}`);
        } catch (err) {
          console.log(`  ${chalk.red("✗")} Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        console.log();
      };

      // Initial run
      await runEval();

      // Watch for changes
      const watcher = fs.watch(filePath, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(runEval, debounceMs);
      });

      // Also watch directory for related files
      const dir = path.dirname(filePath);
      const dirWatcher = fs.watch(dir, (event, filename) => {
        if (filename && filename.endsWith(".json") && filename !== path.basename(filePath)) {
          // Check if the config references this file
          if (timer) clearTimeout(timer);
          timer = setTimeout(runEval, debounceMs);
        }
      });

      // Keep alive
      process.on("SIGINT", () => {
        watcher.close();
        dirWatcher.close();
        console.log(chalk.dim("\n  Watch stopped."));
        process.exit(0);
      });

      // Prevent Node from exiting
      await new Promise(() => {});
    });
}
