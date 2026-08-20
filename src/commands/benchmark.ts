/**
 * `evalguard benchmark list`                     — list available benchmarks
 * `evalguard benchmark run <suite> --model <id>`  — run a benchmark suite against a model
 */
import { Command } from "commander";
import chalk from "chalk";
import { makeCallLLM, detectProviderFromModel } from "../lib/call-llm.js";

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

      const authored = benchmarks.filter(
        (b: BenchmarkRow) => b.provenance?.kind === "evalguard-authored",
      ).length;

      console.log();
      console.log(chalk.bold(`  Available Benchmarks (${benchmarks.length})`));
      // The suite NAME is the public benchmark's; the CASES are ours. Say so
      // before the table, not in a footnote — a reader who stops at the first
      // two lines must not leave believing these are the public datasets.
      if (authored > 0) {
        console.log(
          chalk.yellow(
            `  ${authored} of ${benchmarks.length} ship EvalGuard-authored cases. A suite named after a public\n` +
              "  benchmark imitates its task format; it is not that dataset, and a score here is\n" +
              "  not comparable to a published leaderboard. Run the real split with --from-hf\n" +
              "  where a binding exists (see `evalguard benchmark info <suite>`).",
          ),
        );
      }
      console.log();
      console.log(
        `  ${chalk.dim("ID".padEnd(18))}${chalk.dim("Name".padEnd(22))}${chalk.dim("Category".padEnd(16))}${chalk.dim("Samples".padEnd(10))}${chalk.dim("Cases".padEnd(20))}${chalk.dim("Description")}`
      );
      console.log(chalk.dim("  " + "─".repeat(112)));

      for (const b of benchmarks as BenchmarkRow[]) {
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

        // Pad the PLAIN label, then colour it — padding a colourised string
        // counts the ANSI escapes and shreds the column.
        const provLabel = provenanceLabel(b.provenance).padEnd(20);
        const provColor =
          b.provenance?.kind === "evalguard-authored"
            ? chalk.yellow
            : b.provenance?.kind === "public-dataset-bundled"
              ? chalk.green
              : chalk.red;

        console.log(
          `  ${chalk.cyan(b.id.padEnd(18))}${chalk.white(b.name.padEnd(22))}${catColor(b.category.padEnd(16))}${chalk.white(String(b.sampleCount).padEnd(10))}${provColor(provLabel)}${chalk.dim(b.description.slice(0, 46))}`
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
    .option(
      "--from-hf",
      "Grade the REAL public dataset split from HuggingFace instead of the EvalGuard-authored bank (requires a wired binding; fails rather than silently falling back)",
      false
    )
    .action(
      async (
        suite: string,
        opts: {
          model?: string;
          sample: string;
          provider?: string;
          json: boolean;
          apiKey?: string;
          fromHf: boolean;
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

        // ── Case source ────────────────────────────────────────────────────
        // Until 2026-08-06 this command printed "Benchmark: MMLU" and then an
        // accuracy, over 26 multiple-choice questions EvalGuard wrote. Nothing
        // in the output distinguished that from a run on the 14,042-question
        // public MMLU test set, and the number is routinely pasted into decks.
        // The provenance line now sits above the score, always.
        let hfCases: Array<{ input: string; expectedOutput: string; category?: string }> | null =
          null;
        if (opts.fromHf) {
          const { loadBenchmarkFromHF, hasHFBinding } = (await import(
            "@evalguard/core"
          )) as {
            loadBenchmarkFromHF: (
              id: string,
              o: { limit: number },
            ) => Promise<{
              cases: Array<{ input: string; expectedOutput: string; category?: string }>;
              usedFallback: boolean;
              fallbackReason?: string;
              dataset: string;
            }>;
            hasHFBinding: (id: string) => boolean;
          };

          if (!hasHFBinding(suiteObj.id)) {
            console.error(
              chalk.red(
                `\n  --from-hf: no public-dataset binding is wired for "${suiteObj.id}".\n`,
              ) +
                chalk.dim(
                  "  Re-run without --from-hf to grade the EvalGuard-authored bank, or add a\n" +
                    "  binding in packages/core/src/benchmarks/hf-loader/registry.ts.\n",
                ),
            );
            process.exit(1);
          }

          const outcome = await loadBenchmarkFromHF(suiteObj.id, {
            limit: samplesPerSuite,
          });
          // A silent fallback here would be the whole defect wearing a new
          // hat: the user asked for the real dataset and would get our bank,
          // under a heading that says HuggingFace. Fail instead.
          if (outcome.usedFallback) {
            console.error(
              chalk.red(
                `\n  --from-hf: could not load the public split (${outcome.fallbackReason ?? "unknown"}).\n`,
              ) +
                chalk.dim(
                  "  Refusing to grade the EvalGuard-authored bank under a --from-hf heading.\n",
                ),
            );
            process.exit(1);
          }
          hfCases = outcome.cases;
          console.log(
            chalk.green(
              `  Cases:   ${hfCases.length} from the public dataset ${outcome.dataset}`,
            ),
          );
        } else if (suiteObj.provenance?.kind === "evalguard-authored") {
          const mirrors = suiteObj.provenance.mirrors;
          console.log(
            chalk.yellow(
              `  Cases:   EvalGuard-authored${mirrors ? ` (${mirrors} task format)` : ""} — NOT the ` +
                `${mirrors ?? "public"} dataset.\n` +
                "           The accuracy below is a score on OUR questions and is not\n" +
                "           comparable to a published leaderboard.",
            ),
          );
        } else {
          console.log(
            chalk.dim(`  Cases:   ${provenanceLabel(suiteObj.provenance)}`),
          );
        }
        console.log();

        // Build LLM caller
        let callLLM: (prompt: string) => Promise<string>;

        // 2026-07-29 (audit A1): this block previously called
        //   createProvider(opts.provider ?? opts.model, opts.model, { apiKey })
        // — THREE arguments against a two-parameter function
        // (`createProvider(name, apiKey)`, providers/registry.ts:183) whose
        // first argument must be a PROVIDER name, not a model id. Verified
        // against the shipped build: `createProvider.length === 2`, and
        // `createProvider("gpt-4o-mini", …)` throws
        //   Unknown provider "gpt-4o-mini". Valid providers: openai, anthropic, …
        // It then called `provider.complete(prompt)`, and `LLMProvider`
        // declares only `chat()` (providers/types.ts:227-230) — so even a
        // correctly-constructed provider had no such method.
        //
        // Both failures landed in the bare `catch` below, which meant the echo
        // fallback was not an "exceptional path": it was the ONLY reachable
        // path. `evalguard benchmark run` could never reach a real model, and
        // reported benchmark scores computed from `Echo: <prompt prefix>`.
        //
        // Fixed by using the shared `makeCallLLM` — the same adapter
        // compliance-check / generate / generate-dataset / optimize use. Do NOT
        // reintroduce a local provider-construction copy here; that drift is
        // what produced this bug.
        const providerName = opts.provider ?? detectProviderFromModel(opts.model);
        try {
          const { createProvider } = (await import("@evalguard/core")) as {
            createProvider: (name: string, apiKey: string) => { chat: (...args: never[]) => unknown };
          };
          callLLM = await makeCallLLM(providerName, opts.model, createProvider, opts.apiKey);
        } catch (err) {
          // Echo mode is a DRY-RUN aid, never a silent substitute for a real
          // run. Say exactly why the provider could not be built, and mark the
          // output so a score from echo text can't be mistaken for a benchmark.
          console.log(
            chalk.yellow(
              `  Warning: could not initialize provider "${providerName}" for model "${opts.model}": ` +
                `${err instanceof Error ? err.message : String(err)}\n` +
                "  Falling back to ECHO MODE — the reported scores are NOT a real benchmark.\n"
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
          // Live-loaded cases go through the SAME scorer and the same errored-
          // sample accounting as the bundled bank — see runner.ts.
          ...(hfCases ? { cases: { [suiteObj.id]: hfCases } } : {}),
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

        // ── Coverage accounting (audit 2026-08-03) ───────────────────────
        // `runBenchmarks` never grades a sample whose `callLLM` threw: it is
        // counted in `errored` / `errorRate` and excluded from `correct`,
        // `accuracy`, `avgScore` and `categoryBreakdown` (core runner.ts,
        // false-pass fix 2026-07-26). This command is the shipped HUMAN
        // surface for that runner and it printed none of it — so the
        // hardening was invisible exactly where a person reads the number.
        //
        // Worse, the two figures it did print came from different
        // denominators: `accuracy` is over GRADED samples, `correct/
        // totalSamples` is over ATTEMPTED ones. A run where 25 of 26 calls
        // 503'd and the one that returned was right rendered as a green
        // "Accuracy: 100.0% (1/26)" — an outage read as a perfect benchmark,
        // with a self-contradictory fraction beside it.
        //
        // `errored` is optional on BenchmarkRunResult (older core builds
        // predate it), hence `?? 0`: on such a build `graded ===
        // totalSamples` and the output is byte-equivalent to before.
        const suiteCoverage: SuiteCoverage[] = (
          result.suiteResults as SuiteResultRow[]
        ).map((sr) => {
          const errored = sr.errored ?? 0;
          return {
            sr,
            errored,
            graded: Math.max(0, sr.totalSamples - errored),
          };
        });
        // A suite that attempted samples but graded ZERO produced no
        // measurement at all. Reporting "0.0%" there is a verdict on absent
        // data — it blames the model for the provider outage — and exiting 0
        // is the false pass. Same rule as regression-delta's
        // `not-comparable` status.
        const ungraded = suiteCoverage.filter(
          (c) => c.sr.totalSamples > 0 && c.graded === 0
        );

        if (opts.json) {
          // `--json` is the surface a dashboard or a CI job reads. It carried
          // an accuracy and a suite name and nothing about where the cases
          // came from, so any consumer that rendered it reproduced the same
          // ambiguity one layer further out.
          console.log(
            JSON.stringify(
              {
                ...result,
                caseSource: hfCases
                  ? { kind: "public-dataset-bundled", loadedFrom: "huggingface" }
                  : suiteObj.provenance,
              },
              null,
              2,
            ),
          );
          if (ungraded.length > 0) process.exit(1);
          return;
        }

        // Display results
        for (const { sr, errored, graded } of suiteCoverage) {
          console.log(chalk.bold(`  Results: ${sr.suiteName}`));
          console.log(chalk.dim(`  ${"─".repeat(50)}`));

          if (graded === 0 && sr.totalSamples > 0) {
            console.log(
              `  Accuracy:  ${chalk.red("n/a")} ${chalk.dim(
                `— 0 of ${sr.totalSamples} samples were graded`
              )}`
            );
          } else {
            console.log(
              `  Accuracy:  ${colorAccuracy(sr.accuracy)} (${sr.correct}/${graded} graded)`
            );
            console.log(
              `  Avg Score: ${chalk.white((sr.avgScore * 100).toFixed(1) + "%")}`
            );
          }

          if (errored > 0) {
            const pct =
              sr.totalSamples > 0
                ? ((errored / sr.totalSamples) * 100).toFixed(1)
                : "0.0";
            console.log(
              `  ${chalk.red("Errored:")}   ${chalk.red(
                `${errored}/${sr.totalSamples}`
              )} ${chalk.dim(
                `samples (${pct}%) never reached the model — excluded from accuracy`
              )}`
            );
          }

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

        if (ungraded.length > 0) {
          console.error(
            chalk.red(
              `  NO MEASUREMENT: every sample errored in ${ungraded
                .map((c) => c.sr.suiteId)
                .join(", ")}. This is not a benchmark result.\n`
            )
          );
          process.exit(1);
        }
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
      console.log(
        `  ${chalk.dim("Case source:")} ${provenanceLabel(suiteObj.provenance)}`,
      );

      // The disclaimer belongs here, next to the sample count someone is about
      // to quote — not on a docs page they may never open.
      if (suiteObj.provenance?.kind === "evalguard-authored") {
        const mirrors = suiteObj.provenance.mirrors;
        console.log();
        console.log(
          chalk.yellow(
            mirrors
              ? `  All ${suiteObj.sampleCount} cases were written by EvalGuard. This suite imitates the\n` +
                  `  task format and category taxonomy of ${mirrors}; it does NOT bundle the\n` +
                  `  ${mirrors} dataset, and an accuracy from it is not a score on ${mirrors}.`
              : `  All ${suiteObj.sampleCount} cases were written by EvalGuard. No third-party dataset\n` +
                  "  is bundled.",
          ),
        );

        const { hasHFBinding } = (await import("@evalguard/core")) as {
          hasHFBinding: (id: string) => boolean;
        };
        console.log(
          hasHFBinding(suiteObj.id)
            ? chalk.dim(
                `\n  To grade against the real public split instead:\n` +
                  `    evalguard benchmark run ${suiteObj.id} --model <id> --from-hf`,
              )
            : chalk.dim(
                "\n  No public-dataset loader is wired for this suite, so --from-hf is\n" +
                  "  unavailable and only the authored bank can be run today.",
              ),
        );
      }

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

  // ─── benchmark agent-suites ───
  //
  // Reachability surface for packages/core/src/agent-benchmarks
  // (AgentBenchmarkRunner). Until 2026-08 that module was exported from
  // `@evalguard/core` and imported by nothing but its own unit tests.
  //
  // These suites are BYO-dataset: unlike `benchmark list` (which lists suites
  // that ship their own samples via `generateSamples`), an agent suite is a
  // definition — id, version, scoring weights, upstream dataset — that the
  // customer loads with their own tasks via `loadBuiltIn(suiteId, tasks)` and
  // grades with their own executor. The output says so explicitly rather than
  // implying we ship runnable agent benchmarks.
  bench
    .command("agent-suites")
    .description(
      "List the built-in AGENT benchmark suite definitions (BYO-dataset: you supply the tasks and the pass/fail decision)",
    )
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { AgentBenchmarkRunner } = (await import(
        "@evalguard/core"
      )) as unknown as {
        AgentBenchmarkRunner: new () => {
          getAvailableSuites: () => AgentSuiteRow[];
        };
      };
      const suites = new AgentBenchmarkRunner().getAvailableSuites();

      if (opts.json) {
        console.log(JSON.stringify(suites, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  Agent Benchmark Suites (${suites.length})`));
      console.log(
        chalk.dim(
          "  BYO-dataset — EvalGuard ships the definition, runner and aggregation; you ship the tasks and the grader.",
        ),
      );
      console.log();
      console.log(
        `  ${chalk.dim("Suite".padEnd(18))}${chalk.dim("Ver".padEnd(8))}${chalk.dim("Weights (comp/step/cost/safety)".padEnd(34))}${chalk.dim("Upstream dataset")}`,
      );
      console.log(chalk.dim("  " + "─".repeat(100)));

      for (const s of suites) {
        const w = s.scoringWeights;
        const weights = w
          ? `${w.taskCompletion} / ${w.stepEfficiency} / ${w.costEfficiency} / ${w.safetyScore}`
          : chalk.dim("(core build predates 2026-08)");
        // The marker goes INSIDE the pad so the column stays aligned.
        const label = s.shippedBenchmarkId ? `${s.suiteId} *` : s.suiteId;
        console.log(
          `  ${chalk.cyan(label.padEnd(18))}${chalk.white((s.version ?? "-").padEnd(8))}${weights.padEnd(34)}${chalk.dim(s.sourceDataset ?? "—")}`,
        );
      }

      // A suite id must never be readable as two different products. Suites
      // whose name-family also exists as a shipped, fully-sampled benchmark
      // (mmbench-agent ↔ mmbench, humaneval-agent ↔ humaneval, …) say so here,
      // with the command that runs the OTHER one.
      const shadowed = suites.filter((s) => s.shippedBenchmarkId);
      if (shadowed.length > 0) {
        console.log();
        console.log(
          chalk.dim(
            "  * BYO-dataset agent suite — NOT the shipped benchmark of the same family.",
          ),
        );
        console.log(
          chalk.dim(
            "    The shipped one ships its own samples and grader and runs today:",
          ),
        );
        for (const s of shadowed) {
          console.log(
            `      ${chalk.cyan(s.suiteId.padEnd(18))}${chalk.dim("≠")}  ${chalk.white(
              s.shippedBenchmarkId!.padEnd(14),
            )}${chalk.dim(`evalguard benchmark run ${s.shippedBenchmarkId}`)}`,
          );
        }
      }

      console.log();
      console.log(
        chalk.dim(
          "  Load one with: runner.loadBuiltIn(\"<suite>\", tasks) — see packages/core/src/agent-benchmarks.",
        ),
      );
      console.log();
    });
}

/**
 * One entry of `BenchmarkRunResult.suiteResults` (core `benchmarks/types.ts`).
 * `errored` / `errorRate` are optional there — a core build older than the
 * 2026-07-26 false-pass fix omits them, and this command must degrade to the
 * historical output rather than print `NaN`.
 */
interface SuiteResultRow {
  suiteId: string;
  suiteName: string;
  /** Samples attempted = graded + errored. */
  totalSamples: number;
  correct: number;
  /** Samples whose `callLLM` threw; never graded. Absent on older cores. */
  errored?: number;
  errorRate?: number;
  /** `correct / (totalSamples - errored)`. */
  accuracy: number;
  avgScore: number;
  categoryBreakdown?: Record<
    string,
    { correct: number; total: number; accuracy: number }
  >;
}

/** A suite result paired with its graded/errored split. */
interface SuiteCoverage {
  sr: SuiteResultRow;
  errored: number;
  /** `totalSamples - errored` — the denominator of `accuracy`. */
  graded: number;
}

/** Row shape of `AgentBenchmarkRunner.getAvailableSuites()`. */
interface AgentSuiteRow {
  suiteId: string;
  name: string;
  description: string;
  /** Absent on core builds older than 2026-08. */
  version?: string;
  /** Absent on core builds older than 2026-08. */
  scoringWeights?: {
    taskCompletion: number;
    stepEfficiency: number;
    costEfficiency: number;
    safetyScore: number;
  };
  /** Absent on core builds older than 2026-08, or when no upstream is declared. */
  sourceDataset?: string;
  /**
   * Id of the shipped, fully-sampled benchmark this suite shares a name-family
   * with (`mmbench-agent` → `mmbench`). Absent when the suite shadows nothing,
   * and on core builds older than 2026-08.
   */
  shippedBenchmarkId?: string;
}

/**
 * Shape of `BenchmarkProvenance` (core `benchmarks/types.ts`), optional here
 * because a core build older than 2026-08-06 does not emit it. On such a build
 * the label reads "undeclared" rather than silently claiming a source.
 */
interface ProvenanceRow {
  kind?: "evalguard-authored" | "public-dataset-bundled";
  mirrors?: string;
}

/** One row of `listBenchmarks()`. */
interface BenchmarkRow {
  id: string;
  name: string;
  description: string;
  category: string;
  sampleCount: number;
  provenance?: ProvenanceRow;
}

function provenanceLabel(p: ProvenanceRow | undefined): string {
  if (p?.kind === "evalguard-authored") return "EvalGuard-authored";
  if (p?.kind === "public-dataset-bundled") return "public dataset";
  return "undeclared";
}

function colorAccuracy(accuracy: number): string {
  const pct = (accuracy * 100).toFixed(1) + "%";
  if (accuracy >= 0.8) return chalk.green(pct);
  if (accuracy >= 0.5) return chalk.yellow(pct);
  return chalk.red(pct);
}
