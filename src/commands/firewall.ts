/**
 * `evalguard firewall <input>` — Test input against LLM firewall rules
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

type FirewallRule = any;

/** Advanced-rails CLI flags shared by the firewall command. */
export interface FirewallAdvancedRailsFlags {
  gcg?: boolean;
  yaraOutput?: boolean;
}

/**
 * True when any advanced-rails detector flag is set. When false the firewall
 * command runs the unchanged legacy `checkFirewall` path (byte-for-byte the
 * existing behavior — zero regression). The async-only rails (embedding
 * paraphrase, retrieval grounding) require a network embedder / retrieved
 * context that the CLI cannot supply standalone, so the CLI exposes the two
 * model-free synchronous rails (gcg + yaraOutput); the others stay on the
 * server-side firewall surface.
 */
export function hasAdvancedRails(flags: FirewallAdvancedRailsFlags): boolean {
  return Boolean(flags.gcg || flags.yaraOutput);
}

/**
 * Run the core FirewallEngine with the opt-in advanced rails enabled. Pure +
 * unit-testable — does NOT duplicate detection logic; it constructs the core
 * FirewallEngine and calls its scan / scanOutput. For input text, the gcg
 * adversarial-suffix perplexity rail runs in `scan`; for output text (via
 * `--output`), the YARA declarative output rails run in `scanOutput`.
 */
export async function scanWithAdvancedRails(
  text: string,
  flags: FirewallAdvancedRailsFlags & { output?: boolean },
): Promise<{
  blocked: boolean;
  score: number;
  category: string;
  subcategory: string;
  details: string;
  latencyMs: number;
  layers: { layer: string; triggered: boolean; score: number; details: string }[];
}> {
  const { FirewallEngine } = (await import("@evalguard/core")) as {
    FirewallEngine: new (config?: unknown) => {
      scan: (input: string) => {
        blocked: boolean;
        score: number;
        category: string;
        subcategory: string;
        details: string;
        latencyMs: number;
        layers: { layer: string; triggered: boolean; score: number; details: string }[];
      };
      scanOutput: (output: string) => {
        blocked: boolean;
        score: number;
        category: string;
        subcategory: string;
        details: string;
        latencyMs: number;
        layers: { layer: string; triggered: boolean; score: number; details: string }[];
      };
    };
  };

  const engine = new FirewallEngine({
    // Raise the per-scan latency budget so an explicitly-opted-in advanced
    // rail (gcg) is never silently dropped: the engine's hot path gates each
    // layer on a cumulative budget (default 100ms) to protect the proxy p95,
    // but a CLI user who passed --advanced-gcg expects the rail to actually
    // run. The CLI is a one-shot tool, not the latency-sensitive hot path.
    maxLatencyMs: 10_000,
    advancedRails: {
      gcg: { enabled: Boolean(flags.gcg) },
      yaraOutput: { enabled: Boolean(flags.yaraOutput) },
    },
  });

  return flags.output ? engine.scanOutput(text) : engine.scan(text);
}

export function registerFirewall(program: Command): void {
  program
    .command("firewall")
    .description("Test input against LLM firewall rules")
    .argument("<input>", "Input text to check (or - for stdin, @file for file)")
    .option("--rules <file>", "Custom firewall rules JSON file")
    .option("--json", "Output as JSON", false)
    .option(
      "--advanced-gcg",
      "Opt-in: GCG / adversarial-suffix perplexity detector (input rail, model-free)",
      false,
    )
    .option(
      "--advanced-yara",
      "Opt-in: YARA-style declarative output rails (use with --output)",
      false,
    )
    .option(
      "--output",
      "Treat <input> as an LLM OUTPUT and run output rails (e.g. YARA) instead of input rails",
      false,
    )
    .action(
      async (
        input: string,
        opts: { rules?: string; json?: boolean; advancedGcg?: boolean; advancedYara?: boolean; output?: boolean },
      ) => {
        let text = input;

        // Read from file if prefixed with @
        if (input.startsWith("@")) {
          const filePath = path.resolve(input.slice(1));
          if (!fs.existsSync(filePath)) {
            console.error(chalk.red(`File not found: ${filePath}`));
            process.exit(1);
          }
          text = fs.readFileSync(filePath, "utf-8");
        }

        const advFlags: FirewallAdvancedRailsFlags = {
          gcg: opts.advancedGcg,
          yaraOutput: opts.advancedYara,
        };

        // ── Advanced-rails path: route through the core FirewallEngine ──
        // Triggered only when an --advanced-* flag is set; otherwise the
        // legacy checkFirewall path below runs UNCHANGED (zero regression).
        if (hasAdvancedRails(advFlags)) {
          const result = await scanWithAdvancedRails(text, { ...advFlags, output: opts.output });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.blocked ? 1 : 0);
          }
          console.log();
          const actionColor = result.blocked ? chalk.red : chalk.green;
          console.log(`  ${actionColor("●")} ${chalk.bold(result.blocked ? "BLOCK" : "ALLOW")}`);
          console.log(chalk.dim(`  Category: ${result.category}/${result.subcategory}  •  Score: ${result.score.toFixed(2)}  •  Latency: ${result.latencyMs}ms`));
          const fired = result.layers.filter((l) => l.triggered);
          if (fired.length > 0) {
            console.log();
            for (const l of fired) {
              console.log(`  ${chalk.yellow(l.layer.padEnd(20))} score=${l.score.toFixed(2)}  ${chalk.dim(l.details)}`);
            }
          } else {
            console.log(chalk.dim("  No threats detected."));
          }
          console.log();
          process.exit(result.blocked ? 1 : 0);
        }

        // ── Legacy path (unchanged) ──
        const { checkFirewall, DEFAULT_FIREWALL_RULES } = await import("@evalguard/core") as any;

        // Load custom rules or use defaults
        let rules: FirewallRule[] = DEFAULT_FIREWALL_RULES;
        if (opts.rules) {
          const rulesPath = path.resolve(opts.rules);
          if (!fs.existsSync(rulesPath)) {
            console.error(chalk.red(`Rules file not found: ${rulesPath}`));
            process.exit(1);
          }
          rules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
        }

        const result = checkFirewall(text, rules);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          // Exit non-zero on block so `firewall --json` works as a CI gate — the
          // human-readable (below) and advanced-rails paths already exit on block;
          // the JSON path must too, or a blocked prompt silently passes CI.
          process.exit(result.action === "block" ? 1 : 0);
        }

        console.log();
        const actionColor = result.action === "block" ? chalk.red : result.action === "flag" ? chalk.yellow : chalk.green;
        console.log(`  ${actionColor("●")} ${chalk.bold(result.action.toUpperCase())}`);
        console.log(chalk.dim(`  Latency: ${result.latencyMs}ms`));

        if (result.reasons.length > 0) {
          console.log();
          for (const r of result.reasons) {
            const sevColor = r.severity === "critical" ? chalk.red : r.severity === "high" ? chalk.yellow : chalk.dim;
            console.log(`  ${sevColor(r.severity.padEnd(10))} [${r.type}] ${r.detail}`);
          }
        } else {
          console.log(chalk.dim("  No threats detected."));
        }
        console.log();

        process.exit(result.action === "block" ? 1 : 0);
      },
    );

  // ── firewall-benchmark ──
  // Run the firewall against the bundled labeled safety corpora and report a
  // PINT-style balanced-accuracy score. Usable as a CI quality gate.
  program
    .command("firewall-benchmark")
    .description("Benchmark the firewall against labeled safety corpora (PINT-style balanced accuracy)")
    .option("--json", "Output full report as JSON", false)
    .option("--limit <n>", "Cap cases per benchmark (fast smoke run)", (v) => parseInt(v, 10))
    .option("--min-balanced-accuracy <n>", "Fail (exit 1) if balanced accuracy is below this 0-1 threshold", parseFloat)
    .option("--max-fpr <n>", "Fail (exit 1) if the false-positive rate exceeds this 0-1 threshold", parseFloat)
    .action(async (opts: { json?: boolean; limit?: number; minBalancedAccuracy?: number; maxFpr?: number }) => {
      const { runFirewallBenchmark, formatBenchmarkReport } = (await import("@evalguard/core")) as any;
      const result = await runFirewallBenchmark({ limitPerBenchmark: opts.limit });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatBenchmarkReport(result));
      }

      // CI gate semantics.
      const ba = result.overall.balancedAccuracy;
      const fpr = result.overall.falsePositiveRate;
      let failed = false;
      if (opts.minBalancedAccuracy != null && ba != null && ba < opts.minBalancedAccuracy) {
        console.error(chalk.red(`\n✗ Balanced accuracy ${(ba * 100).toFixed(1)}% < required ${(opts.minBalancedAccuracy * 100).toFixed(1)}%`));
        failed = true;
      }
      if (opts.maxFpr != null && fpr != null && fpr > opts.maxFpr) {
        console.error(chalk.red(`✗ False-positive rate ${(fpr * 100).toFixed(1)}% > allowed ${(opts.maxFpr * 100).toFixed(1)}%`));
        failed = true;
      }
      process.exit(failed ? 1 : 0);
    });
}
