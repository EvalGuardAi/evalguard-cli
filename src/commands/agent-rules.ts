/**
 * `evalguard agent-rules` — generate rule packs for AI coding agents from
 * EvalGuard's own detectors, so the guidance an assistant follows at generation
 * time is exactly what EvalGuard enforces at runtime.
 *
 * Two corpora, one command:
 *
 *   secure-coding  generic application-security rules derived from the SAST
 *                  pattern library (SQLi, XSS, hardcoded keys). Four targets.
 *                  Competitor-gap Phase 5 (Arnica convergence).
 *
 *   agent-mcp      agent- and MCP-specific rules derived from EvalGuard's agent
 *                  detectors — untrusted tool output, MCP allowlisting, tool
 *                  pinning, approval gates, agent secrets, lethal trifecta,
 *                  excessive agency. Seven targets, each in that assistant's
 *                  real file format.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  renderAllRulePacks,
  renderRulePack,
  type RuleTarget,
  CORPUS_TARGETS,
  CORPUS_TARGET_LIST,
  collectRules,
  renderAllCorpusPacks,
  renderCorpusPack,
  resolveCorpusTarget,
  CATEGORY_ORDER,
  type CorpusRenderOptions,
  type CorpusRulePack,
  type RuleCategory,
  type RuleSeverity,
} from "@evalguard/core";

const LEGACY_TARGETS: RuleTarget[] = ["cursor", "claude", "agents", "copilot"];
const CORPORA = ["secure-coding", "agent-mcp", "both"] as const;
type Corpus = (typeof CORPORA)[number];
const SEVERITIES: RuleSeverity[] = ["critical", "high", "medium"];

interface WrittenPack {
  filename: string;
  content: string;
}

/** Legacy 4-target render. Byte-identical to the pre-corpus behaviour. */
function legacyPacks(targetOpt: string, categories?: string[]): WrittenPack[] {
  const ruleOpts = categories && categories.length > 0 ? { categories } : {};
  if (targetOpt === "all") return renderAllRulePacks(ruleOpts);

  // Corpus target names that have no secure-coding equivalent are simply not
  // emitted for this corpus — reported by the caller, never silently ignored.
  const legacy = targetOpt === "codex" ? "agents" : targetOpt;
  if (!LEGACY_TARGETS.includes(legacy as RuleTarget)) return [];
  return [renderRulePack(legacy as RuleTarget, ruleOpts)];
}

function corpusPacks(targetOpt: string, opts: CorpusRenderOptions): CorpusRulePack[] {
  if (targetOpt === "all") return renderAllCorpusPacks(opts);
  const resolved = resolveCorpusTarget(targetOpt);
  return resolved ? [renderCorpusPack(resolved, opts)] : [];
}

export function registerAgentRules(program: Command): void {
  program
    .command("agent-rules")
    .description(
      "Generate agent/MCP + secure-coding rule packs for 7 AI coding assistants (.mdc / .clinerules / CLAUDE.md / .windsurfrules / AGENTS.md / CONVENTIONS.md / copilot-instructions.md) from EvalGuard's detectors",
    )
    .option(
      "-t, --target <target>",
      `Target: ${CORPUS_TARGET_LIST.join(", ")} (or the legacy alias "agents"), or all`,
      "all",
    )
    .option("-o, --out <dir>", "Output directory (repo root)", ".")
    // `--corpus` deliberately takes no short flag: `-c` already means
    // `--category` in the shipped command and must keep meaning that.
    .option("--corpus <corpus>", `Which rules to emit: ${CORPORA.join(", ")}`, "both")
    .option("-c, --category <category...>", "Restrict to these rule categories")
    .option("--min-severity <severity>", `Minimum severity: ${SEVERITIES.join(", ")}`)
    .option("--rule <rule...>", "Extra org-specific rules appended verbatim")
    .option("--dry-run", "Print what would be written without touching the filesystem", false)
    .action(
      (opts: {
        target: string;
        out: string;
        corpus: string;
        category?: string[];
        minSeverity?: string;
        rule?: string[];
        dryRun: boolean;
      }) => {
        // ── Validate every input up front; never emit a half-understood pack ──
        if (!CORPORA.includes(opts.corpus as Corpus)) {
          console.error(chalk.red(`Invalid --corpus "${opts.corpus}". Use: ${CORPORA.join(", ")}`));
          process.exit(1);
        }
        const corpus = opts.corpus as Corpus;

        const knownTarget =
          opts.target === "all" || resolveCorpusTarget(opts.target) !== undefined;
        if (!knownTarget) {
          console.error(
            chalk.red(
              `Invalid --target "${opts.target}". Use: ${CORPUS_TARGET_LIST.join(", ")}, agents, or all`,
            ),
          );
          process.exit(1);
        }

        if (opts.minSeverity && !SEVERITIES.includes(opts.minSeverity as RuleSeverity)) {
          console.error(
            chalk.red(`Invalid --min-severity "${opts.minSeverity}". Use: ${SEVERITIES.join(", ")}`),
          );
          process.exit(1);
        }

        // A category filter that matches nothing would quietly write an empty
        // rules file, which is worse than no file at all — fail closed.
        let corpusCategories: RuleCategory[] | undefined;
        if (opts.category && opts.category.length > 0 && corpus !== "secure-coding") {
          const unknown = opts.category.filter(
            (c) => !(CATEGORY_ORDER as readonly string[]).includes(c),
          );
          if (unknown.length > 0) {
            console.error(
              chalk.red(
                `Unknown --category ${unknown.map((c) => `"${c}"`).join(", ")} for corpus "${corpus}". Valid: ${CATEGORY_ORDER.join(", ")}`,
              ),
            );
            process.exit(1);
          }
          corpusCategories = opts.category as RuleCategory[];
        }

        // ── Report any rule dropped for an unresolvable detector citation ────
        // A rule we cannot trace to a detector does not ship, and the operator
        // is told rather than handed a quietly shorter file.
        const { dropped } = collectRules({
          categories: corpusCategories,
          minSeverity: opts.minSeverity as RuleSeverity | undefined,
        });
        if (dropped.length > 0) {
          console.error(
            chalk.red(
              `${dropped.length} rule(s) cite a detector that no longer resolves and were NOT emitted:`,
            ),
          );
          for (const d of dropped) {
            console.error(chalk.red(`  ${d.id} — ${d.module}: ${d.missingSymbols.join(", ")}`));
          }
          process.exit(1);
        }

        // ── Render ───────────────────────────────────────────────────────────
        const packs: WrittenPack[] = [];
        if (corpus === "secure-coding") {
          packs.push(...legacyPacks(opts.target, opts.category));
        } else {
          packs.push(
            ...corpusPacks(opts.target, {
              categories: corpusCategories,
              minSeverity: opts.minSeverity as RuleSeverity | undefined,
              extraRules: opts.rule,
              includeSecureCoding: corpus === "both",
            }),
          );
        }

        if (packs.length === 0) {
          console.error(
            chalk.red(
              `Target "${opts.target}" produces no output for corpus "${corpus}".` +
                (corpus === "secure-coding"
                  ? ` The secure-coding corpus covers: ${LEGACY_TARGETS.join(", ")}.`
                  : ""),
            ),
          );
          process.exit(1);
        }

        // ── Write ────────────────────────────────────────────────────────────
        for (const pack of packs) {
          const dest = path.resolve(opts.out, pack.filename);
          if (opts.dryRun) {
            console.log(
              `${chalk.yellow("would write")} ${chalk.cyan(pack.filename)} ${chalk.dim(`(${pack.content.length} bytes)`)}`,
            );
            continue;
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, pack.content, "utf-8");
          console.log(`${chalk.green("✓")} wrote ${chalk.cyan(pack.filename)}`);
        }

        if (corpus !== "secure-coding") {
          const assistants = packs
            .map((p) => {
              const spec = CORPUS_TARGET_LIST.map((t) => CORPUS_TARGETS[t]).find(
                (s) => s.filename === p.filename,
              );
              return spec?.assistant;
            })
            .filter((a): a is string => Boolean(a));
          if (assistants.length > 0) {
            console.log(chalk.dim(`\nAssistants covered: ${assistants.join(", ")}`));
          }
        }
        console.log(
          chalk.dim(
            "Commit these so your AI coding agent follows EvalGuard's policy at generation time.",
          ),
        );
      },
    );
}
