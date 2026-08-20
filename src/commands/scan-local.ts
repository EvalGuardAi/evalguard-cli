/**
 * `evalguard scan:local <file>` — Run red team security scan locally
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { parseSeverityGate, severityRank } from "../lib/gate-threshold.js";

// Real CLI version, stamped into every artifact so a report says which build
// produced it. Read from package.json — never a hardcoded literal that drifts.
const CLI_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

type RedTeamPlugin = any;
type TransformStrategy = any;
type Grader = any;
type SecurityScanResult = any;
type ScanFinding = any;

/** Artifact formats `scan:local` can write. */
export type ScanArtifactFormat = "json" | "sarif" | "html";

type ScanSeverity = "low" | "medium" | "high" | "critical";

/**
 * Decide whether a `scan:local` run should FAIL (exit 1). Pure + exported for
 * testing.
 *
 * EXIT-CODE FAIL-OPEN (audit 2026-07-25): this used to be
 * `process.exit(result.criticalCount > 0 ? 1 : 0)`. A scan that found twelve
 * successful HIGH-severity jailbreaks and zero CRITICALs printed
 * "HIGH 12 high severity issues" and then exited 0 — the CI job went green and
 * the vulnerabilities shipped. Gate on high+ by DEFAULT, matching
 * secret-scan / iac-scan / code-scan, with `--fail-on` to widen (medium/low) or
 * disable (`none`) the gate.
 */
export function resolveScanLocalGate(
  counts: { criticalCount?: number; highCount?: number; mediumCount?: number; lowCount?: number },
  failOn: string,
): { shouldFail: boolean; gatedCount: number; gateLabel: string } {
  const fo = (failOn ?? "high").toLowerCase().trim();
  if (fo === "none") return { shouldFail: false, gatedCount: 0, gateLabel: "none" };
  // Fail CLOSED (rank 0 = gate everything) on a threshold this gate cannot
  // understand. `SCAN_SEVERITY_RANK[fo] ?? …` did not fall back for a prototype
  // key — `RANK["constructor"]` is the Object constructor — so `rank` became a
  // function, every `RANK[sev] >= rank` was NaN-false, and
  // `scan:local --fail-on constructor` reported 0 gated findings over 2 critical
  // and 12 high jailbreaks. `in` had the same hole on the label line below.
  const parsed = parseSeverityGate(fo);
  const rank = parsed === null ? 0 : severityRank(parsed) ?? 0;
  const label = parsed ?? `${fo} (unrecognised — gating everything)`;
  const bySeverity: Array<[ScanSeverity, number]> = [
    ["critical", counts.criticalCount ?? 0],
    ["high", counts.highCount ?? 0],
    ["medium", counts.mediumCount ?? 0],
    ["low", counts.lowCount ?? 0],
  ];
  const gatedCount = bySeverity
    .filter(([sev]) => (severityRank(sev) ?? 0) >= rank)
    .reduce((sum, [, n]) => sum + n, 0);
  return { shouldFail: gatedCount > 0, gatedCount, gateLabel: label };
}

/**
 * Infer the artifact format from an output path's extension so
 * `--output report.sarif` does the obvious thing without a second flag. An
 * unrecognised extension yields `undefined` and the caller falls back to the
 * explicit `--format` (default `json`).
 */
export function formatFromPath(outPath: string): ScanArtifactFormat | undefined {
  const lower = outPath.toLowerCase();
  if (lower.endsWith(".sarif") || lower.endsWith(".sarif.json")) return "sarif";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".json")) return "json";
  return undefined;
}

/**
 * CI provenance harvested from the environment, used to stamp the SARIF log
 * and the HTML report with the repository/commit/branch the scan ran against.
 *
 * Read from the standard CI variables — nothing is invented. On a developer
 * laptop every field is absent and the exporters simply omit those sections.
 * `automationId` is what lets a re-run REPLACE the previous alert set instead
 * of stacking a duplicate one.
 */
export function ciProvenance(
  env: NodeJS.ProcessEnv = process.env,
): { repositoryUri?: string; revisionId?: string; branch?: string; srcRoot?: string; automationId?: string } {
  const repo = env.GITHUB_REPOSITORY;
  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const ref = env.GITHUB_REF;
  const out: ReturnType<typeof ciProvenance> = {};
  if (repo) out.repositoryUri = `${serverUrl.replace(/\/+$/, "")}/${repo}`;
  if (env.GITHUB_SHA) out.revisionId = env.GITHUB_SHA;
  if (ref) out.branch = ref;
  if (env.GITHUB_WORKSPACE) {
    out.srcRoot = `file://${env.GITHUB_WORKSPACE.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`;
  }
  if (ref) out.automationId = `evalguard-red-team/${ref}`;
  return out;
}

interface LocalScanConfig {
  model?: string;
  provider?: string;
  prompt: string;
  systemPrompt?: string;
  purpose?: string;
  attackTypes?: string[];
  plugins?: string[];
  strategies?: string[];
  graders?: string[];
  maxConcurrency?: number;
  output?: string;
  // Nested shapes also accepted by `evalguard validate` — normalized below so a
  // validated config never crashes scan:local.
  target?: { model?: string; provider?: string };
  redteam?: {
    plugins?: string[];
    strategies?: string[];
    graders?: string[];
    attackTypes?: string[];
    numTests?: number;
    maxConcurrency?: number;
  };
  // Some scaffolded configs (e.g. `init -t security-scan`) declare the target via
  // a `providers` list — the shape `evalguard eval` uses — instead of `model:`.
  // Accept it as a model source so a validated scan config runs on scan:local
  // without an extra `model:` / --model (regression: the security-scan template
  // failed with "No model specified" out of the box, 2026-07-16).
  providers?: Array<string | { id?: string; model?: string }>;
  // The `init -t security-scan` template declares the hardened system prompt ONLY
  // under `prompts:` (a bare string, `{ content }`, or `{ file }`), NOT under the
  // flat `prompt`/`systemPrompt` the scanner reads. Accept it so the scan tests
  // the user's actual prompt instead of an empty one (audit M4).
  prompts?: Array<string | { file?: string; content?: string; label?: string }>;
}

/** Provider prefixes recognised in a `provider:model` id (the promptfoo /
 *  `init` convention). Only these are stripped, so a model id whose first colon
 *  segment is NOT a provider (e.g. an Ollama tag like `llama3:8b`) is left
 *  untouched. */
const KNOWN_PROVIDER_PREFIXES = new Set([
  "openai", "anthropic", "gemini", "google", "mistral", "groq", "deepseek",
  "cohere", "together", "fireworks", "perplexity", "xai", "azure", "bedrock",
  "echo", "ollama", "localai", "llamafile", "llamacpp",
]);

/**
 * Strip a leading `provider:` prefix from a model id when the prefix is a KNOWN
 * provider (`openai:gpt-4o-mini` → `gpt-4o-mini`, provider `openai`). The
 * `init -t security-scan` template scaffolds `providers: [{ id: "openai:gpt-4o-mini" }]`,
 * so without this the scanner sent the literal provider-prefixed id as the model
 * — which the OpenAI API rejects (audit M4). Colon-free ids and unknown-prefix
 * ids (e.g. `llama3:8b`) are returned unchanged.
 * Exported for unit testing.
 */
export function stripProviderPrefix(id: string): { provider?: string; model: string } {
  const colonIdx = id.indexOf(":");
  if (colonIdx < 0) return { model: id };
  const prefix = id.slice(0, colonIdx);
  if (KNOWN_PROVIDER_PREFIXES.has(prefix.toLowerCase())) {
    return { provider: prefix, model: id.slice(colonIdx + 1) };
  }
  return { model: id };
}

/**
 * Resolve the target system prompt a scan should red-team, in precedence order:
 *   config.prompt → config.systemPrompt → config.prompts[0]
 * where a `prompts[0]` entry may be a bare string, `{ content }`, or `{ file }`
 * (read relative to `baseDir`). Returns the resolved prompt (possibly empty).
 *
 * The `init -t security-scan` template puts the hardened prompt ONLY under
 * `prompts: [{ file: prompts/system.txt }]`; the scanner reads `config.prompt`,
 * so it used to red-team an EMPTY system prompt yet report findings — implying
 * the user's prompt had been tested (audit M4). Exported for unit testing.
 */
export function resolveScanPrompt(
  config: LocalScanConfig,
  baseDir: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"),
): string {
  const direct = config.prompt ?? config.systemPrompt;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;

  const first = config.prompts?.[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    if (typeof first.content === "string") return first.content;
    if (typeof first.file === "string") {
      try {
        return readFile(path.resolve(baseDir, first.file));
      } catch {
        return "";
      }
    }
  }
  return "";
}

/** First provider entry's model id — supports `providers: ["openai:gpt-4o"]`
 *  and `providers: [{ id: "openai:gpt-4o" }]` (the shape `init` scaffolds). */
function firstProviderModel(
  providers?: Array<string | { id?: string; model?: string }>,
): string | undefined {
  const p = providers?.[0];
  if (!p) return undefined;
  return typeof p === "string" ? p : (p.id ?? p.model);
}

/**
 * Resolve a vertical attack-pack id (canonical or legacy alias) to its plugin
 * ids using the consolidated registry accessor from @evalguard/core. Throws a
 * clear error for an unknown vertical. Exported for unit testing (the .action()
 * closure calls process.exit).
 */
export function selectVerticalPlugins(
  verticalId: string,
  getVerticalPack: (id: string) => { id: string; plugins: readonly string[] } | undefined,
  listVerticals?: () => readonly { id: string }[],
): string[] {
  const pack = getVerticalPack(verticalId);
  if (!pack) {
    const known = listVerticals ? listVerticals().map((v) => v.id).join(", ") : "";
    throw new Error(
      `Unknown vertical: ${verticalId}.${known ? ` Available: ${known}` : ""}`,
    );
  }
  return [...pack.plugins];
}

export function registerScanLocal(program: Command): void {
  program
    .command("scan:local")
    .description("Run red team security scan locally (no API key needed)")
    .argument("<file>", "Path to scan config JSON/YAML file")
    .option("--model <model>", "Override model")
    .option("--provider <provider>", "Override provider")
    .option("--vertical <id>", "Run a named vertical attack pack (e.g. healthcare, telecom, finance)")
    .option("--output <format>", "Output format: json or file path")
    .option(
      "--format <fmt>",
      "Format for --output: json, sarif (SARIF 2.1.0 for GitHub Code Scanning), or html (self-contained offline report). Inferred from the --output extension when omitted.",
    )
    .option("--sarif <file>", "Additionally write a SARIF 2.1.0 log to this path")
    .option("--html <file>", "Additionally write a single-file offline HTML report to this path")
    .option("--verbose", "Show each finding", false)
    .option(
      "--fail-on <severity>",
      "Exit 1 if the scan reports any vulnerability ≥ this severity (low|medium|high|critical), or 'none' to disable gating. Gates on high+ by DEFAULT (consistent with secret-scan/iac-scan/code-scan).",
      "high",
    )
    .action(async (file: string, opts: { model?: string; provider?: string; vertical?: string; output?: string; format?: string; sarif?: string; html?: string; verbose?: boolean; failOn?: string }) => {
      const core = await import("@evalguard/core");
      const { runSecurityScan, ATTACK_TYPES, ALL_PLUGINS, ALL_STRATEGIES, ALL_GRADERS, createProvider, getVerticalPack, listVerticals } = core as any;

      // Validate the format up-front so a two-minute scan cannot end in
      // "unknown format" with the results thrown away.
      if (opts.format && !["json", "sarif", "html"].includes(opts.format.toLowerCase())) {
        console.error(chalk.red(`Unknown --format "${opts.format}". Use json, sarif, or html.`));
        process.exit(1);
      }

      // Same reasoning: reject a bad --fail-on BEFORE a multi-minute scan, and
      // never silently degrade to a weaker gate.
      const failOn = parseSeverityGate(opts.failOn ?? "high", { allowNone: true });
      if (failOn === null) {
        console.error(
          chalk.red(`Unknown --fail-on "${opts.failOn}". Use low, medium, high, critical, or none.`),
        );
        process.exit(1);
        return;
      }

      const spinner = ora("Loading scan config...").start();

      try {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(`File not found: ${filePath}`);
          process.exit(1);
        }

        const raw = fs.readFileSync(filePath, "utf-8");
        let config: LocalScanConfig;
        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
          const { parse: parseYaml } = await import("yaml");
          config = parseYaml(raw);
        } else {
          config = JSON.parse(raw);
        }
        let model: string, providerName: string;
        try {
          ({ model, providerName } = normalizeScanConfig(config, opts));
        } catch (e) {
          spinner.fail(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }

        // --vertical selects the consolidated vertical pack's plugins, unioned
        // with any plugins already listed in the config.
        if (opts.vertical) {
          let packPluginIds: string[];
          try {
            packPluginIds = selectVerticalPlugins(opts.vertical, getVerticalPack, listVerticals);
          } catch (e) {
            spinner.fail(e instanceof Error ? e.message : String(e));
            process.exit(1);
          }
          config.plugins = Array.from(new Set([...(config.plugins ?? []), ...packPluginIds]));
          spinner.text = `Selected vertical '${opts.vertical}' → ${packPluginIds.length} plugins`;
        }

        const apiKey = resolveApiKey(providerName);
        // FAIL CLOSED: a red-team scan MUST call the target model. With no key,
        // every probe call fails and the scan misreports ALL attacks as PASSED —
        // a dangerous false "secure" result for a security tool. Match eval:local
        // (which already hard-fails on a missing key). (2026-07-16 real-usage E2E:
        // `scan:local` reported 200/200 PASSED with no OPENAI_API_KEY.)
        if (!apiKey) {
          spinner.fail(
            `No API key found for provider "${providerName}". Set ${providerEnvVar(providerName)} ` +
              `(or EVALGUARD_PROVIDER_KEY). A red-team scan must call the target model — without a ` +
              `key every probe fails and would be misreported as PASSED.`,
          );
          process.exit(1);
        }

        // Resolve the target system prompt from `prompt`/`systemPrompt` or the
        // `prompts:` list (string / `{ content }` / `{ file }`) the `init
        // -t security-scan` template uses. Without this the scan red-teamed an
        // EMPTY prompt yet reported findings (audit M4). WARN LOUDLY rather than
        // silently scanning nothing when no prompt can be resolved.
        config.prompt = resolveScanPrompt(config, path.dirname(filePath));
        if (!config.prompt.trim()) {
          spinner.warn(
            "Scan target prompt is EMPTY — no system prompt resolved from `prompt`, " +
              "`systemPrompt`, or `prompts[].file`/`.content`. The scan will probe the " +
              "model with NO system prompt; results do NOT reflect your hardened prompt.",
          );
          // spinner.warn() stops the spinner — restart it so the scan-progress
          // text below is still shown.
          if (!spinner.isSpinning) spinner.start();
        }

        const provider = createProvider(providerName as any, apiKey);
        const callLLM = async (prompt: string): Promise<string> => {
          const response = await provider.chat([{ role: "user", content: prompt }], { model });
          return response.content;
        };

        // Resolve plugins, strategies, graders
        const pluginMap = Object.fromEntries(ALL_PLUGINS.map((p: any) => [p.id, p]));
        const strategyMap = Object.fromEntries(ALL_STRATEGIES.map((s: any) => [s.id, s]));
        const graderMap = Object.fromEntries(ALL_GRADERS.map((g: any) => [g.id, g]));

        const plugins: RedTeamPlugin[] | undefined = config.plugins?.map((id: string) => {
          if (!pluginMap[id]) throw new Error(`Unknown plugin: ${id}. Available: ${ALL_PLUGINS.map((p: any) => p.id).join(", ")}`);
          return pluginMap[id];
        });

        const strategies: TransformStrategy[] | undefined = config.strategies?.map((id: string) => {
          if (!strategyMap[id]) throw new Error(`Unknown strategy: ${id}. Available: ${ALL_STRATEGIES.map((s: any) => s.id).join(", ")}`);
          return strategyMap[id];
        });

        const graders: Grader[] | undefined = config.graders?.map((id: string) => {
          if (!graderMap[id]) throw new Error(`Unknown grader: ${id}. Available: ${ALL_GRADERS.map((g: any) => g.id).join(", ")}`);
          return graderMap[id];
        });

        const mode = plugins ? "plugin pipeline" : "legacy";
        const count = plugins ? `${plugins.length} plugins` : `${config.attackTypes?.length ?? ATTACK_TYPES.length} attack types`;
        spinner.text = `Scanning with ${count} (${mode}) on ${model}...`;

        const result = await runSecurityScan({
          prompt: config.prompt,
          systemPrompt: config.systemPrompt,
          purpose: config.purpose,
          attackTypes: (config.attackTypes ?? ATTACK_TYPES.map((a: any) => a.type)),
          callLLM,
          plugins,
          strategies,
          graders,
          maxConcurrency: config.maxConcurrency,
        });

        spinner.stop();
        displayScanResults(result, opts.verbose ?? false);

        // ─── Artifacts ───
        //
        // The same findings, rendered for wherever the reader already is:
        //   json  — machine-readable, what the PR-comment mapper parses
        //   sarif — GitHub Code Scanning / any SARIF viewer, line-anchored
        //   html  — one self-contained file, opens offline with no login
        const findings: ScanFinding[] = result.findings ?? [];
        const provenance = ciProvenance();

        const renderArtifact = (fmt: ScanArtifactFormat): string => {
          if (fmt === "sarif") {
            return core.exportToSARIFString(findings, {
              toolVersion: CLI_VERSION,
              toolUri: "https://evalguard.ai",
              includeCodeFlows: true,
              ...provenance,
            });
          }
          if (fmt === "html") {
            return core.renderFindingsHtmlReport(findings, {
              toolVersion: CLI_VERSION,
              target: `${providerName}:${model}`,
              durationMs: result.duration,
              repositoryUri: provenance.repositoryUri,
              revisionId: provenance.revisionId,
              branch: provenance.branch,
            });
          }
          return JSON.stringify(result, null, 2);
        };

        const written: { path: string; fmt: ScanArtifactFormat }[] = [];

        if (opts.output) {
          const explicit = opts.format?.toLowerCase() as ScanArtifactFormat | undefined;
          // `--output json` is the long-standing shorthand for "write the
          // default JSON file"; keep it working.
          const isShorthand = opts.output === "json";
          const fmt: ScanArtifactFormat =
            explicit ?? (isShorthand ? "json" : formatFromPath(opts.output)) ?? "json";
          const defaultName =
            fmt === "sarif" ? "evalguard-scan.sarif" : fmt === "html" ? "evalguard-scan.html" : "evalguard-scan.json";
          const outPath = isShorthand ? defaultName : opts.output;
          fs.writeFileSync(outPath, renderArtifact(fmt), "utf-8");
          written.push({ path: outPath, fmt });
        }

        if (opts.sarif) {
          fs.writeFileSync(opts.sarif, renderArtifact("sarif"), "utf-8");
          written.push({ path: opts.sarif, fmt: "sarif" });
        }

        if (opts.html) {
          fs.writeFileSync(opts.html, renderArtifact("html"), "utf-8");
          written.push({ path: opts.html, fmt: "html" });
        }

        for (const w of written) {
          console.log(
            `  ${chalk.green("✓")} ${w.fmt.toUpperCase()} report saved to ${chalk.cyan(w.path)}`,
          );
        }

        const gate = resolveScanLocalGate(result, failOn);
        if (gate.shouldFail) {
          console.log(
            chalk.red(
              `  ✗ ${gate.gatedCount} vulnerabilit${gate.gatedCount === 1 ? "y" : "ies"} at or above ` +
                `"${gate.gateLabel}" severity — failing the build (--fail-on ${gate.gateLabel}).`,
            ),
          );
        }
        process.exit(gate.shouldFail ? 1 : 0);
      } catch (err) {
        spinner.fail(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

function displayScanResults(result: SecurityScanResult, verbose: boolean): void {
  console.log();
  console.log(chalk.bold("  Security Scan Results"));
  console.log(chalk.dim(`  Duration: ${result.duration}ms | Total tests: ${result.totalTests}`));
  console.log();

  if (verbose) {
    for (const f of result.findings) {
      const icon = f.passed ? chalk.green("✓") : chalk.red("✗");
      const sev = f.severity === "critical" ? chalk.bgRed(` ${f.severity} `) :
                  f.severity === "high" ? chalk.red(f.severity) :
                  f.severity === "medium" ? chalk.yellow(f.severity) :
                  chalk.dim(f.severity);
      console.log(`  ${icon} [${sev}] ${f.title}`);
      if (!f.passed) {
        console.log(`    ${chalk.dim(f.description)}`);
      }
    }
    console.log();
  }

  const passRate = (result.passRate * 100).toFixed(1);
  const passColor = result.passRate >= 0.8 ? chalk.green : result.passRate >= 0.5 ? chalk.yellow : chalk.red;

  console.log(`  ${passColor("●")} Pass Rate: ${chalk.bold(passRate + "%")}`);

  if (result.criticalCount > 0) console.log(`  ${chalk.bgRed(" CRITICAL ")} ${result.criticalCount} critical vulnerabilities`);
  if (result.highCount > 0) console.log(`  ${chalk.red("HIGH")} ${result.highCount} high severity issues`);
  if (result.mediumCount > 0) console.log(`  ${chalk.yellow("MEDIUM")} ${result.mediumCount} medium severity issues`);
  if (result.lowCount > 0) console.log(`  ${chalk.dim("LOW")} ${result.lowCount} low severity issues`);
  console.log();
}

/**
 * Normalize a scan config into the flat fields the scanner reads, supporting the
 * SAME nested shapes `evalguard validate` accepts (`target.*` / `redteam.*`).
 * Mutates `config` (fills the flat fields) and returns the resolved model +
 * provider. Throws a clear error when no model can be resolved — previously a
 * config with model only under `target` left `config.model` undefined and
 * `detectProvider(undefined)` crashed with
 * "Cannot read properties of undefined (reading 'startsWith')".
 * Exported for direct unit testing (the .action() closure calls process.exit).
 */
export function normalizeScanConfig(
  config: LocalScanConfig,
  opts: { model?: string; provider?: string } = {},
): { model: string; providerName: string } {
  config.model = config.model ?? config.target?.model ?? firstProviderModel(config.providers);
  config.provider = config.provider ?? config.target?.provider;
  config.plugins = config.plugins ?? config.redteam?.plugins;
  config.strategies = config.strategies ?? config.redteam?.strategies;
  config.graders = config.graders ?? config.redteam?.graders;
  config.attackTypes = config.attackTypes ?? config.redteam?.attackTypes;
  config.maxConcurrency =
    config.maxConcurrency ?? config.redteam?.maxConcurrency ?? config.redteam?.numTests;

  const rawModel = opts.model ?? config.model;
  if (!rawModel) {
    throw new Error(
      "No model specified. Set 'model' (or target.model) in the config, or pass --model <model>.",
    );
  }
  // Strip a leading `provider:` prefix (`openai:gpt-4o-mini` → `gpt-4o-mini`) so
  // the scanner sends a bare model id the provider API accepts, and adopt the
  // prefix as the provider when none was set explicitly (audit M4).
  const { provider: prefixProvider, model } = stripProviderPrefix(rawModel);
  config.model = model;
  const providerName =
    opts.provider ?? config.provider ?? prefixProvider ?? detectProvider(model);
  return { model, providerName };
}

function detectProvider(model: string): string {
  if (!model || typeof model !== "string") return "openai";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("mistral-")) return "mistral";
  if (model.includes("llama") || model.includes("mixtral")) return "groq";
  if (model.startsWith("deepseek-")) return "deepseek";
  return "openai";
}

const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", deepseek: "DEEPSEEK_API_KEY",
  cohere: "COHERE_API_KEY", together: "TOGETHER_API_KEY",
};

/** The env var a provider's key is read from (e.g. openai → OPENAI_API_KEY). */
export function providerEnvVar(provider: string): string {
  return PROVIDER_ENV_VARS[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function resolveApiKey(provider: string): string {
  return process.env[providerEnvVar(provider)] ?? process.env.EVALGUARD_PROVIDER_KEY ?? "";
}
