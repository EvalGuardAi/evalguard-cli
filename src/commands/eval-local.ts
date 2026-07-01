/**
 * `evalguard eval:local <file>` — Run evaluation locally using @evalguard/core
 * No API key needed. Runs entirely on the user's machine.
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
// Single source of truth for Promptfoo→EvalGuard assertion mapping. We
// import the canonical map here rather than duplicating it so the
// `eval:local <promptfooconfig>` on-ramp and the explicit
// `import:promptfoo` converter never drift.
import { ASSERTION_MAP, ASSERTION_SUGGESTIONS } from "./import-promptfoo.js";

type EvalConfig = any;
type EvalOutput = any;
type EvalResultRow = any;

interface LocalEvalConfig {
  name?: string;
  description?: string;
  model: string;
  provider?: string;
  prompt: string;
  scorers: string[];
  cases: {
    input: string;
    expectedOutput?: string;
    metadata?: Record<string, unknown>;
    /** Inline JS executed sandboxed before scorers see the output. */
    transform?: string;
    /** Vars exposed inside the transform sandbox. */
    vars?: Record<string, string>;
    /**
     * Per-case scorer options derived from this case's own `assert:`/`scorers:`
     * block, keyed by scorer name. Threaded to the runner so a per-case
     * `assert: {type: "contains", value: "alpha"}` checks THIS case's value and
     * never collides with another case's value in the shared scorerOptions map.
     */
    caseScorerOptions?: Record<string, Record<string, unknown>>;
  }[];
  scorerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Promptfoo-only assertion types (javascript/python/webhook/rouge/bleu …)
   * that have NO 1:1 built-in scorer, so they can't run as part of an eval.
   * Surfaced to the user with a suggestion instead of being silently
   * dropped. Empty/undefined when the config had none.
   */
  skippedAssertions?: { type: string; suggestion: string }[];
  output?: string; // json, csv, html, human-eval, or file path
}

export function registerEvalLocal(program: Command): void {
  program
    .command("eval:local")
    .description("Run evaluation locally (no API key needed)")
    .argument("[file]", "Path to eval config JSON/YAML file (default: evalguard.yaml)")
    .option("--model <model>", "Override model")
    .option("--provider <provider>", "Override provider (openai, anthropic, etc.)")
    .option("--output <format>", "Output format: json, csv, html, human-eval, junit, or file path")
    .option("--verbose", "Show detailed output per test case", false)
    .option("--cache", "Enable eval response caching (default: enabled)", true)
    .option("--no-cache", "Disable eval response caching")
    .option(
      "--concurrency <n>",
      "Run up to N eval cases in parallel (default: 1)",
      (v: string) => Math.max(1, parseInt(v, 10) || 1),
    )
    .action(async (fileArg: string | undefined, opts: { model?: string; provider?: string; output?: string; verbose?: boolean; cache?: boolean; concurrency?: number }) => {
      const core = await import("@evalguard/core");
      const { runEvaluation, BUILT_IN_SCORERS, createProvider, formatJSON, formatCSV, formatHTML, formatHumanEval, formatJUnit } = core as any;

      const spinner = ora("Loading eval config...").start();

      try {
        // Auto-detect config file
        let file = fileArg ?? "";
        if (!file) {
          const yamlPath = path.join(process.cwd(), "evalguard.yaml");
          const ymlPath = path.join(process.cwd(), "evalguard.yml");
          const jsonPath = path.join(process.cwd(), "evalguard.config.json");
          if (fs.existsSync(yamlPath)) file = yamlPath;
          else if (fs.existsSync(ymlPath)) file = ymlPath;
          else if (fs.existsSync(jsonPath)) file = jsonPath;
          else {
            spinner.fail("No evalguard.yaml found. Run `npx evalguard init` to create one.");
            process.exit(1);
          }
        }

        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const raw = fs.readFileSync(filePath, "utf-8");

        // Support both JSON and YAML
        let config: LocalEvalConfig;
        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
          const { parse: parseYaml } = await import("yaml");
          const parsed = parseYaml(raw);
          // Route ANY structured YAML through normaliseConfig — it accepts
          // `cases:` (native), `tests:` (init/Promptfoo), and the full
          // Promptfoo shape (providers/prompts/defaultScorers/vars). The
          // legacy `parseSimpleYaml` path is only for free-form Promptfoo
          // YAML that has no recognisable top-level keys at all.
          if (Array.isArray(parsed?.cases) || Array.isArray(parsed?.tests) ||
              Array.isArray(parsed?.prompts) || Array.isArray(parsed?.providers)) {
            config = normaliseConfig(parsed);
          } else {
            config = parseSimpleYaml(raw);
          }
        } else {
          // JSON path — also normalise so `evalguard import:promptfoo`
          // output (which uses providers/prompts/defaultScorers/vars) works
          // directly with `evalguard eval:local` without manual editing.
          config = normaliseConfig(JSON.parse(raw));
        }
        const model = opts.model ?? config.model;
        const providerName = opts.provider ?? config.provider ?? detectProvider(model);

        // Resolve API key from env
        const apiKeyEnvMap: Record<string, string> = {
          openai: "OPENAI_API_KEY",
          anthropic: "ANTHROPIC_API_KEY",
          gemini: "GEMINI_API_KEY",
          mistral: "MISTRAL_API_KEY",
          groq: "GROQ_API_KEY",
          deepseek: "DEEPSEEK_API_KEY",
          cohere: "COHERE_API_KEY",
          together: "TOGETHER_API_KEY",
          fireworks: "FIREWORKS_API_KEY",
          perplexity: "PERPLEXITY_API_KEY",
          xai: "XAI_API_KEY",
        };

        const envKey = apiKeyEnvMap[providerName] ?? `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        const apiKey = process.env[envKey] ?? process.env.EVALGUARD_PROVIDER_KEY ?? "";

        if (!apiKey && !["echo", "ollama", "localai", "llamafile", "llamacpp"].includes(providerName)) {
          spinner.fail(`No API key found. Set ${envKey} environment variable.`);
          process.exit(1);
        }

        const provider = createProvider(providerName as any, apiKey);

        const callLLM = async (prompt: string): Promise<string> => {
          const response = await provider.chat(
            [{ role: "user", content: prompt }],
            { model },
          );
          return response.content;
        };

        // Surface Promptfoo-only assertion types that can't run as a
        // built-in scorer (javascript/python/webhook/rouge/bleu …). These
        // were excluded from the scorer run during normalisation — warn the
        // user with a concrete next step instead of dropping them silently.
        for (const { type, suggestion } of config.skippedAssertions ?? []) {
          spinner.warn(`promptfoo \`${type}\` assertion has no built-in scorer → ${suggestion}; skipped this run.`);
        }

        // Validate scorers
        const invalidScorers = config.scorers.filter((s: string) => !BUILT_IN_SCORERS[s]);
        if (invalidScorers.length > 0) {
          spinner.warn(`Unknown scorers: ${invalidScorers.join(", ")}. Available: ${Object.keys(BUILT_IN_SCORERS).join(", ")}`);
        }

        // `spinner.warn()` persistently stops the spinner; restart it so the
        // run-progress text below is actually shown.
        if (!spinner.isSpinning) spinner.start();
        spinner.text = `Running ${config.cases.length} cases with ${config.scorers.length} scorers on ${model}...`;

        // Lazy-load the QuickJS WASM sandbox ONLY if a case actually
        // uses `transform:`. Saves the ~50-150ms cold-start hit for
        // the common case (no transforms) while still failing loudly
        // (via core's noopTransformRunner) when a transform is set
        // but the package isn't installed.
        let transformRunner: unknown = undefined;
        const usesTransforms = config.cases.some(
          (c: { transform?: string }) =>
            typeof c.transform === "string" && c.transform.trim().length > 0,
        );
        if (usesTransforms) {
          try {
            const mod = (await import("@evalguard/quickjs-runner")) as {
              quickjsTransformRunner: unknown;
            };
            transformRunner = mod.quickjsTransformRunner;
          } catch {
            spinner.warn(
              "Eval YAML uses `transform:` but @evalguard/quickjs-runner is not installed. " +
                "Cases with transforms will fail with a helpful error. " +
                "Install: pnpm add @evalguard/quickjs-runner",
            );
          }
        }

        const result = await runEvaluation({
          model,
          prompt: config.prompt,
          cases: config.cases,
          scorers: config.scorers,
          callLLM,
          scorerOptions: config.scorerOptions,
          cache: opts.cache !== false,
          ...(transformRunner ? { transformRunner } : {}),
          ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        });

        spinner.stop();

        // Store results locally for compare/gate/history
        try {
          const { storeRun, generateId } = await import("./store.js");
          const passed = result.cases.filter((c: any) => c.passed).length;
          storeRun({
            id: generateId(),
            type: "eval",
            name: config.name ?? path.basename(file, ".json"),
            model,
            provider: providerName,
            timestamp: new Date().toISOString(),
            passRate: result.passRate,
            score: result.score,
            maxScore: result.maxScore,
            passed,
            failed: result.cases.length - passed,
            total: result.cases.length,
            latencyMs: result.totalLatency,
            config: file,
            results: result.cases,
          });
        } catch { /* store is optional */ }

        // Display results
        const passColor = result.passRate >= 0.8 ? chalk.green : result.passRate >= 0.5 ? chalk.yellow : chalk.red;

        console.log();
        console.log(chalk.bold(`  ${config.name ?? path.basename(file, ".json")}`));
        console.log(chalk.dim(`  Model: ${model} | Provider: ${providerName}`));
        console.log();

        if (opts.verbose) {
          for (const c of result.cases) {
            const icon = c.passed ? chalk.green("✓") : chalk.red("✗");
            console.log(`  ${icon} ${chalk.dim(c.input.slice(0, 60))}${c.input.length > 60 ? "..." : ""}`);
            console.log(`    Output: ${chalk.dim(c.actualOutput.slice(0, 80))}${c.actualOutput.length > 80 ? "..." : ""}`);
            for (const [scorer, sr] of Object.entries(c.scorerResults)) {
              const sIcon = (sr as any).passed ? chalk.green("✓") : chalk.red("✗");
              console.log(`    ${sIcon} ${scorer}: ${(sr as any).score.toFixed(2)} ${chalk.dim((sr as any).reason ?? "")}`);
            }
            console.log();
          }
        }

        // Summary
        const passed = result.cases.filter((c: any) => c.passed).length;
        const failed = result.cases.length - passed;
        console.log(`  ${passColor("●")} ${chalk.bold("Results")}: ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)} (${(result.passRate * 100).toFixed(1)}%)`);
        const cacheInfo = result.cacheHits ? ` | Cache hits: ${result.cacheHits}/${result.cases.length}` : "";
        console.log(`  ${chalk.dim(`Score: ${result.score.toFixed(2)}/${result.maxScore} | Latency: ${result.totalLatency}ms${cacheInfo}`)}`);
        console.log();

        // Output file
        if (opts.output) {
          const outputData = buildOutput(config, result);
          writeOutput(opts.output, outputData, formatJSON, formatCSV, formatHTML, formatHumanEval, formatJUnit);
        }

        process.exit(failed > 0 ? 1 : 0);
      } catch (err) {
        spinner.fail(`Eval failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

function detectProvider(model: string): string {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("mistral-")) return "mistral";
  if (model.includes("llama") || model.includes("mixtral")) return "groq";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("command-")) return "cohere";
  return "openai";
}

/**
 * Normalise an arbitrary config object into the shape eval:local expects.
 *
 * Accepts:
 *  1. EvalGuard native shape:
 *       { model, prompt, scorers: string[], cases: [{input, expectedOutput}] }
 *  2. `evalguard import:promptfoo` output shape:
 *       {
 *         providers: [{provider, model}],
 *         prompts: [string],
 *         defaultScorers: [{scorer, value}],
 *         cases: [{vars: {...}, scorers: [...]}]
 *       }
 *
 * Without this, the flow `import:promptfoo → eval:local` crashed with
 * "Cannot read properties of undefined (reading 'startsWith')" because
 * config.model was undefined.
 */
export function normaliseConfig(raw: any): LocalEvalConfig {
  // `evalguard init` and Promptfoo both use `tests:` instead of `cases:`.
  // Accept either spelling — this is the back-compat seam that makes the
  // `init → eval:local` flow actually work (previously init produced
  // `tests:` which normaliseConfig silently dropped → 0 tests run).
  if (raw && Array.isArray(raw.tests) && !Array.isArray(raw.cases)) {
    raw = { ...raw, cases: raw.tests };
  }

  // Already EvalGuard-native. Fast-path the verbatim return ONLY when no case
  // carries per-case `assert:`/`scorers:` blocks — those need the full pipeline
  // below to thread each case's value onto its own `expectedOutput` (otherwise
  // a value-based per-case assert is silently dropped and every case scores
  // 0.00 with "No expected string provided").
  const hasPerCaseAsserts =
    Array.isArray(raw.cases) &&
    raw.cases.some(
      (c: any) =>
        c && typeof c === "object" && (Array.isArray(c.assert) || Array.isArray(c.scorers)),
    );
  if (
    raw.model &&
    raw.prompt &&
    Array.isArray(raw.scorers) &&
    Array.isArray(raw.cases) &&
    !hasPerCaseAsserts
  ) {
    return raw as LocalEvalConfig;
  }

  // import:promptfoo shape
  const firstProvider = Array.isArray(raw.providers) && raw.providers[0];
  // Promptfoo and `evalguard init` write providers as `{ id: "openai:gpt-4o-mini" }`
  // or `{ id: "echo" }` (or a bare string) — NOT `{ provider, model }`. Parse the
  // `provider:model` id (first colon splits provider from model) so the documented
  // `init --local → eval:local` flow works out-of-the-box. Previously `{ id: "echo" }`
  // had no `.provider`/`.model`, so it fell through to gpt-4o-mini/openai and demanded
  // OPENAI_API_KEY for a local-only run.
  const providerId =
    typeof firstProvider === "string"
      ? firstProvider
      : firstProvider && typeof firstProvider === "object"
        ? firstProvider.id
        : undefined;
  const colonIdx = typeof providerId === "string" ? providerId.indexOf(":") : -1;
  const idProvider =
    colonIdx >= 0 ? providerId.slice(0, colonIdx) : typeof providerId === "string" ? providerId : undefined;
  const idModel = colonIdx >= 0 ? providerId.slice(colonIdx + 1) : undefined;
  const model =
    raw.model ??
    (typeof firstProvider === "object" && firstProvider ? firstProvider.model : undefined) ??
    idModel ??
    "gpt-4o-mini";
  const provider =
    raw.provider ??
    (typeof firstProvider === "object" && firstProvider ? firstProvider.provider : undefined) ??
    idProvider ??
    detectProvider(model);
  const prompt =
    raw.prompt ??
    (Array.isArray(raw.prompts) && raw.prompts[0]) ??
    "{{input}}";

  // Promptfoo-only assertion types we encountered that have no built-in
  // scorer equivalent (javascript/python/webhook/rouge/bleu …). Deduped by
  // type; surfaced to the user later instead of being silently dropped.
  const skippedAssertions = new Map<string, string>();

  // Flatten scorers: accept string[] OR [{scorer|name|type: string}].
  //
  // The `type` key is the Promptfoo / `evalguard init` `assert:` shape
  // (`{type: "llm-rubric", value: "..."}`). Promptfoo names its assertion
  // types differently from EvalGuard's scorer registry (e.g. `llm-rubric`
  // is `llm-grader` here, `model-graded-fact` is `factuality`, `is-json`
  // is `json-valid`). We map `type`-keyed entries through the canonical
  // ASSERTION_MAP so they resolve to real scorers instead of triggering an
  // "Unknown scorers" warning and being dropped. A `{scorer}`/`{name}`
  // entry or a bare string is ALREADY an EvalGuard scorer name — leave it
  // untouched so we never double-map.
  //
  // A handful of Promptfoo types (the ASSERTION_SUGGESTIONS set) can't
  // become a built-in scorer at all — arbitrary `javascript`/`python`
  // code, `webhook`, and the `rouge`/`bleu` reference-overlap metrics.
  // These are recorded in `skippedAssertions` (so the caller can warn) and
  // excluded from the scorer list — they can't execute, but the user is
  // TOLD rather than left wondering why their assertion vanished.
  function flattenScorers(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((s): string => {
        if (typeof s === "string") return s;
        if (s && typeof s === "object" && "scorer" in s) return String((s as Record<string, unknown>).scorer);
        if (s && typeof s === "object" && "name" in s) return String((s as Record<string, unknown>).name);
        if (s && typeof s === "object" && "type" in s) {
          const type = String((s as Record<string, unknown>).type);
          // Promptfoo-only type with no executable equivalent — record it
          // (so we can warn) and drop it from the scorer run.
          if (type in ASSERTION_SUGGESTIONS && !(type in ASSERTION_MAP)) {
            skippedAssertions.set(type, ASSERTION_SUGGESTIONS[type]);
            return "";
          }
          // Map the Promptfoo type to its EvalGuard scorer; if it isn't a
          // known Promptfoo type, keep it verbatim — it's either a native
          // EvalGuard scorer name or a genuine typo the "Unknown scorers"
          // warning will still catch.
          return ASSERTION_MAP[type] ?? type;
        }
        return "";
      })
      .filter((s) => s.length > 0);
  }

  // Promptfoo applies `defaultTest.assert` to EVERY test case. Harvest it
  // alongside per-case `assert:` blocks so a config that puts shared
  // assertions (e.g. a global `toxicity` gate) in `defaultTest` still runs
  // them — otherwise the documented "point eval:local at your existing
  // file" flow would silently drop those global scorers.
  const defaultAsserts: unknown[] = Array.isArray(raw?.defaultTest?.assert)
    ? raw.defaultTest.assert
    : [];
  // Collect scorer names from top-level `scorers` / `defaultScorers` plus
  // `defaultTest.assert` and per-case `assert:` blocks (init / Promptfoo
  // style). Without harvesting from `assert:` we'd run zero scorers when
  // the user followed `init`.
  const perCaseAsserts: unknown[] = (Array.isArray(raw.cases) ? raw.cases : [])
    .flatMap((c: any) => (Array.isArray(c?.assert) ? c.assert : []));
  const scorers = Array.from(
    new Set(
      flattenScorers(raw.defaultScorers)
        .concat(flattenScorers(raw.scorers))
        .concat(flattenScorers(defaultAsserts))
        .concat(flattenScorers(perCaseAsserts)),
    ),
  );

  // Carry scorer options through — Promptfoo-style `value:` config is what
  // makes `contains-any`, `not-contains`, etc. actually check anything.
  // Dropping it (as we were doing) made every scorer score 0.
  //
  // Each built-in scorer reads its own option key. Map Promptfoo's generic
  // `value:` onto the key the scorer actually reads:
  //
  //   contains / icontains / not-contains → options.substring (string)
  //   contains-any / contains-all / icontains-any → options.values (string[])
  //   exact-match / equals                → options.expected  (string)
  //   starts-with / ends-with             → options.value     (string)
  //   regex / matches                     → options.pattern   (string)
  //   llm-rubric / rubric-based           → options.rubric    (string)
  //
  // A `value` that's already an array flows to `values`; a scalar flows to
  // whatever the scorer reads per the table above.
  const ARRAY_VAL_SCORERS = new Set([
    "contains-any", "contains-all", "icontains-any", "icontains-all",
  ]);
  const SUBSTRING_SCORERS = new Set([
    "contains", "not-contains", "icontains", "inot-contains",
  ]);
  // `semantic-similarity` (the EvalGuard target of Promptfoo's `similar`)
  // reads its reference text from `expected`, same as exact-match/equals.
  const EXPECTED_SCORERS = new Set([
    "exact-match", "equals", "exact", "similar", "semantic-similarity",
  ]);
  const STARTS_ENDS_SCORERS = new Set(["starts-with", "ends-with"]);
  const REGEX_SCORERS = new Set(["regex", "matches", "regex-match"]);
  // Include `llm-grader`: Promptfoo's `llm-rubric` maps to it, so after the
  // type→scorer mapping the option key is `llm-grader`, not `llm-rubric`.
  const RUBRIC_SCORERS = new Set([
    "llm-rubric", "rubric-based", "rubric", "llm-grader",
  ]);

  const scorerOptions: Record<string, Record<string, unknown>> = {};

  // Resolve a raw `assert:`/`scorers:` entry to the canonical EvalGuard
  // scorer name so its options land under the SAME key the scorer list
  // uses. A `scorer`/`name` entry is already canonical; a Promptfoo `type`
  // is mapped through ASSERTION_MAP (e.g. `llm-rubric` → `llm-grader`). The
  // promptfoo-only suggestion types resolve to "" — they don't run, so
  // there's nothing to seed.
  function canonicalScorerName(srec: Record<string, unknown>): string {
    if (typeof srec.scorer === "string") return srec.scorer;
    if (typeof srec.name === "string") return srec.name;
    const type = srec.type;
    if (typeof type === "string") {
      if (type in ASSERTION_SUGGESTIONS && !(type in ASSERTION_MAP)) return "";
      return ASSERTION_MAP[type] ?? type;
    }
    return String(srec.scorer ?? srec.name ?? srec.type ?? "");
  }

  // Map a single raw `assert:`/`scorers:` entry's `value`/`expected`/`options`
  // onto the option keys the resolved scorer actually reads, writing INTO the
  // provided `target` map keyed by the canonical scorer name. Shared by both the
  // run-level seeding (target = the global scorerOptions) and the per-case
  // seeding (target = that case's own map) so the value→key contract is
  // identical in both — the ONLY difference is the destination map, which is
  // exactly what stops two cases' values from colliding.
  function applyScorerEntry(
    srec: Record<string, unknown>,
    target: Record<string, Record<string, unknown>>,
  ): void {
    // Key options under the canonical (post-mapping) scorer name so the
    // eval runner — which iterates the mapped `scorers` list — finds them.
    const name = canonicalScorerName(srec);
    if (!name) return;
    const opts: Record<string, unknown> = { ...(target[name] ?? {}) };
    const rawVal = srec.value;
    if (rawVal !== undefined) {
      if (Array.isArray(rawVal) || ARRAY_VAL_SCORERS.has(name)) {
        opts.values = Array.isArray(rawVal) ? rawVal : [rawVal];
      } else if (SUBSTRING_SCORERS.has(name)) {
        opts.substring = rawVal;
      } else if (EXPECTED_SCORERS.has(name)) {
        opts.expected = rawVal;
      } else if (REGEX_SCORERS.has(name)) {
        opts.pattern = rawVal;
      } else if (RUBRIC_SCORERS.has(name)) {
        opts.rubric = rawVal;
      } else if (STARTS_ENDS_SCORERS.has(name)) {
        opts.value = rawVal;
      } else {
        // Unknown scorer — pass both keys so scorer-specific readers can
        // pick what they recognise.
        opts.value = rawVal;
      }
    }
    if (srec.expected !== undefined) opts.expected = srec.expected;
    if (srec.options !== undefined && typeof srec.options === "object") {
      Object.assign(opts, srec.options as Record<string, unknown>);
    }
    target[name] = opts;
  }

  // Seed the SHARED run-level option map. Used ONLY for genuinely global
  // sources (top-level `scorers:` / `defaultScorers:` / `defaultTest.assert`)
  // whose value legitimately applies to every case.
  function seedOptionsFrom(list: unknown) {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || typeof s !== "object") continue;
      applyScorerEntry(s as Record<string, unknown>, scorerOptions);
    }
  }

  /**
   * Build a PER-CASE scorer-options map from a case's own `assert:`/`scorers:`
   * list — keyed by scorer name, using the SAME value→option-key mapping as the
   * run-level seeding. Threaded to the runner via the case's
   * `caseScorerOptions`, where it overrides the shared map for THIS case only.
   *
   * This is the fix for the per-case-assert collision: case A's
   * `{type: contains, value: "alpha"}` and case B's `{value: "beta"}` no longer
   * overwrite a single global `scorerOptions.contains.substring` (which made the
   * wrong case score 0.00 with "No expected string provided"). Each case carries
   * its OWN options, and a single case can even hold different values for
   * different value-based scorers (e.g. `contains` + `similar`) — impossible to
   * express through the one `expectedOutput` slot.
   *
   * Returns undefined when the case has no per-case scorer config (so the
   * common no-assert case stays allocation-free and the runner default path is
   * byte-for-byte unchanged).
   */
  function buildCaseScorerOptions(
    ...lists: unknown[]
  ): Record<string, Record<string, unknown>> | undefined {
    const target: Record<string, Record<string, unknown>> = {};
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (!s || typeof s !== "object") continue;
        applyScorerEntry(s as Record<string, unknown>, target);
      }
    }
    return Object.keys(target).length > 0 ? target : undefined;
  }

  /**
   * Extract the per-case reference text for the scorers that read it ONLY from
   * `ctx.expected` — `equals`/`exact-match`/`similar`/`semantic-similarity`
   * (the EXPECTED family). Those scorers IGNORE any `options.expected`, so their
   * per-case value can't ride on `caseScorerOptions` like the substring/regex
   * scorers do; it must be threaded onto the case's `expectedOutput`. Returns
   * the FIRST such value found, or undefined when the case has none.
   */
  function perCaseExpectedFrom(...lists: unknown[]): string | undefined {
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (!s || typeof s !== "object") continue;
        const srec = s as Record<string, unknown>;
        const name = canonicalScorerName(srec);
        if (!name || !EXPECTED_SCORERS.has(name)) continue;
        const raw = srec.expected !== undefined ? srec.expected : srec.value;
        if (raw === undefined) continue;
        return Array.isArray(raw) ? raw.map((v) => String(v)).join(",") : String(raw);
      }
    }
    return undefined;
  }

  seedOptionsFrom(raw.defaultScorers);
  seedOptionsFrom(raw.scorers);
  seedOptionsFrom(defaultAsserts);

  // Interpolate Promptfoo `vars` into the prompt template. Without this,
  // `prompt: "User: {{query}}"` sends a literal "{{query}}" string to the
  // LLM and every response is "You haven't asked a question yet".
  function interpolate(tmpl: string, vars: Record<string, unknown>): string {
    return tmpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
      const v = vars[key];
      return v === undefined ? `{{${key}}}` : String(v);
    });
  }

  // Coerce var values to strings — the TransformContext.vars contract
  // is Record<string, string>, but YAML parsers will hand us numbers
  // and booleans untouched. Stringify them at the boundary.
  function stringifyVarValues(vars: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  }

  const cases = (Array.isArray(raw.cases) ? raw.cases : []).map((c: any) => {
    const transformCode = typeof c?.transform === "string" ? c.transform : undefined;

    // Per-case scorer options from THIS case's own `assert:`/`scorers:` block.
    // Threaded to the runner via `caseScorerOptions`, where they override the
    // shared map for this case only — so case A's `contains` value and case B's
    // `contains` value never collide (the bug where the wrong case scored 0.00).
    const caseScorerOptions = buildCaseScorerOptions(c?.assert, c?.scorers);
    // The `equals`/`similar`/`semantic-similarity` family reads its reference
    // text ONLY from `ctx.expected`, so a per-case value for those rides on the
    // case's `expectedOutput` instead of `caseScorerOptions`.
    const perCaseExpected = perCaseExpectedFrom(c?.assert, c?.scorers);

    if (c && typeof c === "object" && typeof c.input === "string") {
      return {
        // An explicit `expectedOutput` always wins over a derived assert value.
        input: c.input,
        expectedOutput: c.expectedOutput ?? perCaseExpected,
        metadata: c.metadata,
        transform: transformCode,
        vars: c?.vars ? stringifyVarValues(c.vars as Record<string, unknown>) : undefined,
        caseScorerOptions,
      };
    }
    // Promptfoo-style: { vars: {query: "..."}, scorers?: [...] }
    const vars = (c?.vars ?? {}) as Record<string, unknown>;
    const hasTemplateVars = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(prompt);
    // If prompt has {{name}} placeholders, interpolate vars directly and use
    // the fully-rendered prompt as the `input`. Otherwise fall back to the
    // first var value.
    const rendered = hasTemplateVars && Object.keys(vars).length > 0
      ? interpolate(prompt, vars)
      : (typeof Object.values(vars)[0] === "string"
          ? (Object.values(vars)[0] as string)
          : JSON.stringify(vars));
    return {
      input: rendered,
      expectedOutput: perCaseExpected,
      metadata: { vars },
      transform: transformCode,
      vars: stringifyVarValues(vars),
      caseScorerOptions,
    };
  });

  // When the case already renders the full prompt via interpolation, the
  // top-level prompt should be `{{input}}` so runEvaluation forwards the
  // case's input verbatim. Otherwise, keep the original prompt template.
  const hasVarTemplated = (Array.isArray(raw.cases) ? raw.cases : []).some(
    (c: any) => c?.vars && Object.keys(c.vars).length > 0,
  );

  return {
    name: raw.name ?? raw.description ?? "eval",
    description: raw.description,
    model,
    provider,
    prompt: hasVarTemplated ? "{{input}}" : prompt,
    scorers: scorers.length > 0 ? scorers : ["contains"],
    cases,
    scorerOptions: Object.keys(scorerOptions).length > 0 ? scorerOptions : undefined,
    skippedAssertions:
      skippedAssertions.size > 0
        ? [...skippedAssertions].map(([type, suggestion]) => ({ type, suggestion }))
        : undefined,
  };
}

function buildOutput(config: LocalEvalConfig, result: any): EvalOutput {
  return {
    description: config.name,
    timestamp: new Date().toISOString(),
    results: result.cases.map((c: any, i: number): EvalResultRow => ({
      testIndex: i,
      input: c.input,
      output: c.actualOutput,
      expected: c.expectedOutput,
      score: c.score,
      passed: c.passed,
      provider: config.provider ?? "unknown",
      latencyMs: c.latency,
      costUsd: 0,
      assertions: Object.entries(c.scorerResults).map(([type, r]: [string, any]) => ({
        type,
        passed: r.passed,
        score: r.score,
        reason: r.reason,
      })),
    })),
    summary: {
      total: result.cases.length,
      passed: result.cases.filter((c: any) => c.passed).length,
      failed: result.cases.filter((c: any) => !c.passed).length,
      passRate: result.passRate,
      duration: result.totalLatency,
    },
  };
}

/**
 * Minimal YAML parser for evalguard.yaml configs.
 * Handles the subset of YAML we generate (simple key-value, lists, nested objects).
 * Falls back gracefully for complex YAML.
 */
function parseSimpleYaml(raw: string): LocalEvalConfig {
  // Strip comments and parse basic structure
  const lines = raw.split("\n");
  const result: Record<string, any> = {};
  let currentKey = "";
  let currentList: any[] | null = null;
  let currentObj: Record<string, any> | null = null;

  for (const line of lines) {
    const trimmed = line.replace(/#.*$/, "").trimEnd();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.+)?$/);
    if (kvMatch && indent === 0) {
      if (currentList && currentKey) {
        result[currentKey] = currentList;
        currentList = null;
      }
      currentKey = kvMatch[1];
      const val = kvMatch[2]?.trim();
      if (val && val !== "|") {
        // Remove quotes
        result[currentKey] = val.replace(/^["']|["']$/g, "");
      }
      currentObj = null;
      continue;
    }

    // List item
    if (trimmed.startsWith("- ") || trimmed === "-") {
      if (!currentList) currentList = [];
      const listVal = trimmed.slice(2).trim();

      // Inline object: { key: val, key: val }
      if (listVal.startsWith("{") && listVal.endsWith("}")) {
        try {
          // Convert YAML-style inline to JSON
          const jsonStr = listVal.replace(/(\w[\w-]*):/g, '"$1":').replace(/'/g, '"');
          currentList.push(JSON.parse(jsonStr));
        } catch {
          currentList.push(listVal);
        }
      } else if (listVal) {
        currentList.push(listVal.replace(/^["']|["']$/g, ""));
      } else {
        currentObj = {};
        currentList.push(currentObj);
      }
      continue;
    }

    // Nested key under list item
    if (indent >= 4 && currentObj) {
      const nestedKv = trimmed.match(/^(\w[\w-]*):\s*(.+)?$/);
      if (nestedKv) {
        const val = nestedKv[2]?.trim().replace(/^["']|["']$/g, "");
        if (val) {
          currentObj[nestedKv[1]] = val;
        }
      }
    }
  }

  // Flush last list
  if (currentList && currentKey) {
    result[currentKey] = currentList;
  }

  // ─── EvalGuard native format (model/prompt/cases/scorers) ───
  if (result.cases && Array.isArray(result.cases)) {
    const model = result.model ?? "gpt-4o-mini";
    const provider = result.provider ?? detectProvider(model);
    return {
      name: result.name ?? result.description ?? "eval",
      description: result.description,
      model,
      provider,
      prompt: result.prompt ?? "{{input}}",
      scorers: Array.isArray(result.scorers) ? result.scorers : ["contains"],
      cases: result.cases,
    };
  }

  // ─── Promptfoo format fallback (providers/prompts/tests) ───
  const providers = result.providers as any[];
  const providerStr = providers?.[0]?.id ?? providers?.[0] ?? "openai:gpt-4o-mini";
  const [providerName, modelName] = providerStr.includes(":")
    ? providerStr.split(":")
    : ["openai", providerStr];

  const prompts = result.prompts as any[];
  const prompt = Array.isArray(prompts) ? prompts[0] : (result.prompt ?? "{{input}}");

  // Parse tests
  const tests = result.tests as any[] ?? [];
  const cases = tests.map((t: any) => {
    const input = typeof t === "string" ? t : JSON.stringify(t.vars ?? t);
    return {
      input,
      expectedOutput: t.expected ?? t.expectedOutput,
    };
  });

  // Extract scorer names from assertions
  const scorers: string[] = [];
  for (const t of tests) {
    if (t.assert && Array.isArray(t.assert)) {
      for (const a of t.assert) {
        if (a.type && !scorers.includes(a.type)) {
          scorers.push(a.type);
        }
      }
    }
  }
  if (scorers.length === 0) scorers.push("contains");

  return {
    name: result.description ?? "eval",
    description: result.description,
    model: modelName ?? "gpt-4o-mini",
    provider: providerName,
    prompt: typeof prompt === "string" ? prompt : String(prompt),
    scorers,
    cases,
  };
}

function writeOutput(
  output: string,
  data: EvalOutput,
  formatJSON: any,
  formatCSV: any,
  formatHTML: any,
  formatHumanEval: any,
  formatJUnit: any,
): void {
  let content: string;
  let filePath: string;

  if (output === "json") {
    content = formatJSON(data);
    filePath = "evalguard-results.json";
  } else if (output === "csv") {
    content = formatCSV(data);
    filePath = "evalguard-results.csv";
  } else if (output === "html") {
    content = formatHTML(data);
    filePath = "evalguard-report.html";
  } else if (output === "human-eval" || output === "humaneval") {
    content = formatHumanEval(data);
    filePath = "evalguard-human-eval.yaml";
  } else if (output === "junit" || output === "junit-xml") {
    content = formatJUnit(data);
    filePath = "evalguard-junit.xml";
  } else {
    // Custom file path — validate against path traversal
    filePath = path.resolve(output);
    const cwd = process.cwd();
    if (!filePath.startsWith(cwd)) {
      console.error(chalk.red(`  ✗ Output path must be within the current directory (got ${filePath})`));
      process.exit(1);
    }
    const lower = output.toLowerCase();
    if (lower.endsWith(".csv")) content = formatCSV(data);
    else if (lower.endsWith(".html")) content = formatHTML(data);
    else if (lower.endsWith(".human-eval.yaml") || lower.endsWith(".humaneval.yaml")) content = formatHumanEval(data);
    else if (lower.endsWith(".junit.xml") || lower.endsWith(".xml")) content = formatJUnit(data);
    else content = formatJSON(data);
  }

  fs.writeFileSync(filePath, content);
  console.log(`  ${chalk.green("✓")} Results saved to ${chalk.cyan(filePath)}`);
}
