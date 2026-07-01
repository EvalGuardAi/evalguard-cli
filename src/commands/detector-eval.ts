/**
 * `evalguard detector-eval`  — train + evaluate the first-party prompt-threat
 * detector on the built-in red-team corpus (mined from ALL_PLUGINS) via
 * stratified k-fold cross-validation, reporting per-class precision/recall/F1
 * and the macro-F1. Wires the library-only detector-training harness into the
 * CLI as a working-product command.
 */
import { Command } from "commander";
import chalk from "chalk";

interface ClassMetric { precision: number; recall: number; f1: number; support: number }
interface EvalReport {
  macroF1: number;
  accuracy: number;
  perClass: Record<string, ClassMetric>;
  folds: number;
  totalExamples: number;
}

export function registerDetectorEval(program: Command): void {
  program
    .command("detector-eval")
    .description("Train + k-fold evaluate the first-party prompt-threat detector on the built-in red-team corpus")
    .option("--folds <n>", "Number of cross-validation folds", "5")
    .option("--max-per-plugin <n>", "Max examples mined per plugin", "8")
    .option("--json", "Output the full report as JSON", false)
    .action(async (opts: { folds: string; maxPerPlugin: string; json: boolean }) => {
      const core = (await import("@evalguard/core")) as unknown as {
        buildPluginCorpus: (plugins: unknown[], opts?: { maxPerPlugin?: number }) => Promise<Array<{ text: string; label: string }>>;
        kFoldEvaluate: (corpus: Array<{ text: string; label: string }>, k?: number) => EvalReport;
        SAFE_EXAMPLES: Array<{ text: string; label: string }>;
        ALL_PLUGINS: unknown[];
      };

      const folds = Math.max(2, parseInt(opts.folds, 10) || 5);
      const maxPerPlugin = Math.max(1, parseInt(opts.maxPerPlugin, 10) || 8);

      const mined = await core.buildPluginCorpus(core.ALL_PLUGINS, { maxPerPlugin });
      const corpus = [...mined, ...core.SAFE_EXAMPLES];
      const report = core.kFoldEvaluate(corpus, folds);

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      console.log();
      console.log(chalk.bold("  First-party prompt-threat detector — k-fold evaluation"));
      console.log(chalk.dim(`  corpus: ${report.totalExamples} examples (mined from ${core.ALL_PLUGINS.length} plugins + safe set) · ${report.folds}-fold CV`));
      console.log();
      console.log(`  ${chalk.dim("class".padEnd(14))}${chalk.dim("precision".padEnd(12))}${chalk.dim("recall".padEnd(12))}${chalk.dim("f1".padEnd(10))}${chalk.dim("support")}`);
      console.log(chalk.dim("  " + "─".repeat(56)));
      for (const [label, m] of Object.entries(report.perClass)) {
        console.log(`  ${label.padEnd(14)}${pct(m.precision).padEnd(12)}${pct(m.recall).padEnd(12)}${pct(m.f1).padEnd(10)}${m.support}`);
      }
      console.log(chalk.dim("  " + "─".repeat(56)));
      const f1Color = report.macroF1 >= 0.85 ? chalk.green : report.macroF1 >= 0.6 ? chalk.yellow : chalk.red;
      console.log(`  ${chalk.bold("macro-F1")}   ${f1Color(pct(report.macroF1))}   ${chalk.dim("accuracy")} ${pct(report.accuracy)}`);
      console.log();
      console.log(chalk.dim("  Note: trains the local TF-IDF/NB model on a real corpus. A transformer-grade"));
      console.log(chalk.dim("  detector (Lynx-class) needs a funded GPU run — this measures the baseline."));
      console.log();
    });
}
