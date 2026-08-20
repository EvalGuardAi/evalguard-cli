/**
 * `evalguard cert-gap` — certification readiness + gap analysis (local, offline).
 *
 * Scores an organisation's CURRENT control states against the requirements of a
 * target certification scheme (ISO/IEC 42001, ISO/IEC 27001, SOC 2 Type II, or
 * an EU AI Act conformity assessment) and reports the blocking gaps, the
 * remediation effort, and the audit stage to book next.
 *
 *   evalguard cert-gap --scheme iso_42001 --list                    # starter states file
 *   evalguard cert-gap --scheme iso_42001 --states controls.json
 *   evalguard cert-gap --scheme soc2_type2 --states controls.json --json
 *   evalguard cert-gap --scheme iso_27001 --states controls.json --min-readiness 80
 *
 * HONESTY BOUND: this scores control states YOU declare. It is a planning and
 * CI-gate tool, not an audit, and it does not certify anything. Only an
 * accredited certification body can.
 *
 * Fully local — the analyzer (`analyzeCertificationGap` in
 * @evalguard/core/certification/cert-gap-analyzer) is pure and deterministic,
 * so this command needs no API key and no network.
 */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import {
  analyzeCertificationGap,
  getCertRequirements,
  type CertControlState,
  type CertificationScheme,
  type CertificationGapAnalysis,
} from "@evalguard/core";
import { parseGateThreshold } from "../lib/gate-threshold.js";

const SCHEMES: readonly CertificationScheme[] = [
  "iso_42001",
  "iso_27001",
  "soc2_type2",
  "eu_ai_act_conformity",
];

const STATES: readonly CertControlState[] = ["met", "partial", "gap", "not_applicable"];

export function parseScheme(raw: string | undefined): CertificationScheme {
  const value = (raw ?? "").trim();
  if (!SCHEMES.includes(value as CertificationScheme)) {
    throw new Error(
      `unknown --scheme "${raw ?? ""}". Supported: ${SCHEMES.join(", ")}`,
    );
  }
  return value as CertificationScheme;
}

/**
 * Parse + VALIDATE a states file against the scheme's requirement catalog.
 *
 * Fails closed on an unknown requirement id or an unknown state value rather
 * than falling through to the analyzer's `defaultState`. A typo'd id would
 * otherwise be silently dropped and its requirement scored as a gap — the
 * operator would read a readiness number that does not describe the controls
 * they actually declared, in either direction, with no signal at all.
 */
export function parseStates(
  scheme: CertificationScheme,
  raw: unknown,
): Record<string, CertControlState> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("--states file must be a JSON object of { requirementId: state }");
  }
  const known = new Set(getCertRequirements(scheme).map((r) => r.id));
  const out: Record<string, CertControlState> = {};
  const unknownIds: string[] = [];
  const badStates: string[] = [];

  for (const [id, state] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(id)) {
      unknownIds.push(id);
      continue;
    }
    if (typeof state !== "string" || !STATES.includes(state as CertControlState)) {
      badStates.push(`${id}=${JSON.stringify(state)}`);
      continue;
    }
    out[id] = state as CertControlState;
  }

  if (unknownIds.length > 0) {
    throw new Error(
      `--states contains requirement id(s) not in ${scheme}: ${unknownIds.join(", ")}. ` +
        `Run \`evalguard cert-gap --scheme ${scheme} --list\` for the catalog.`,
    );
  }
  if (badStates.length > 0) {
    throw new Error(
      `--states contains invalid state value(s): ${badStates.join(", ")}. ` +
        `Valid states: ${STATES.join(" | ")}`,
    );
  }
  return out;
}

const STAGE_LABEL: Record<CertificationGapAnalysis["stage"], string> = {
  not_ready: "not ready — foundational controls missing",
  readiness_assessment: "book a readiness assessment",
  stage_1: "ready for a Stage 1 (documentation) audit",
  stage_2: "ready for a Stage 2 (implementation) audit",
  certifiable: "no blocking gaps — ready to certify",
};

function renderHuman(a: CertificationGapAnalysis): void {
  const scoreColor =
    a.readinessScore >= 85 ? chalk.green : a.readinessScore >= 60 ? chalk.yellow : chalk.red;
  console.log("");
  console.log(chalk.bold(a.schemeName));
  console.log(
    `  Readiness ${scoreColor(`${a.readinessScore}/100`)} · ${
      a.certifiable ? chalk.green("certifiable") : chalk.red(`${a.blockingGaps.length} blocking gap(s)`)
    } · ${chalk.dim(STAGE_LABEL[a.stage])}`,
  );
  console.log(
    chalk.dim(
      `  ${a.summary.met} met · ${a.summary.partial} partial · ${a.summary.gap} gap · ${a.summary.notApplicable} n/a (of ${a.summary.total})`,
    ),
  );

  if (a.gaps.length > 0) {
    console.log("");
    console.log(chalk.bold("  Gaps (blocking first):"));
    for (const g of a.gaps) {
      const mark = g.blocking ? chalk.red("●") : chalk.yellow("○");
      console.log(
        `  ${mark} ${chalk.bold(g.requirement.id)} ${chalk.dim(`[${g.requirement.domain}]`)} ${g.state} · ~${g.remediationEffortDays}d`,
      );
      console.log(`      ${chalk.dim(g.recommendation)}`);
    }
  }

  console.log("");
  console.log(
    `  Estimated remediation: ${chalk.bold(`${a.estimatedRemediationDays} engineer-days`)}` +
      (a.certifiable
        ? ""
        : ` · time to certify ≈ ${chalk.bold(`${a.estimatedTimeToCertifyWeeks} weeks`)} (incl. audit lead time)`),
  );
  console.log(
    chalk.dim(
      "  Scored from the control states you declared. This is a planning aid, not an audit — only an accredited body can certify.",
    ),
  );
  console.log("");
}

export function registerCertGap(program: Command): void {
  program
    .command("cert-gap")
    .description(
      "Certification readiness + gap analysis (ISO 42001 / ISO 27001 / SOC 2 Type II / EU AI Act conformity)",
    )
    .requiredOption("--scheme <scheme>", `one of: ${SCHEMES.join(", ")}`)
    .option("--states <path>", "JSON file: { requirementId: met|partial|gap|not_applicable }")
    .option("--list", "print the scheme's requirement catalog as a starter states file")
    .option(
      "--default-state <state>",
      "state assumed for a requirement absent from --states (default: gap)",
    )
    .option("--audit-lead-weeks <n>", "audit lead time added on top of remediation (default 4)")
    .option("--min-readiness <n>", "exit 1 if the readiness score is below this (CI gate)")
    .option("--json", "output raw JSON")
    .action(
      (options: {
        scheme: string;
        states?: string;
        list?: boolean;
        defaultState?: string;
        auditLeadWeeks?: string;
        minReadiness?: string;
        json?: boolean;
      }) => {
        let scheme: CertificationScheme;
        try {
          scheme = parseScheme(options.scheme);
        } catch (err) {
          console.error(chalk.red("✗ ") + (err as Error).message);
          process.exit(2);
          return;
        }

        if (options.list) {
          const reqs = getCertRequirements(scheme);
          if (options.json) {
            console.log(JSON.stringify(reqs, null, 2));
          } else {
            // A paste-ready starter states file: every requirement at "gap".
            const starter: Record<string, CertControlState> = {};
            for (const r of reqs) starter[r.id] = "gap";
            console.log(chalk.dim(`// ${scheme} — ${reqs.length} requirements`));
            for (const r of reqs) {
              console.log(
                chalk.dim(
                  `// ${r.id.padEnd(22)} [${r.domain}] ${r.title}${r.mandatory ? " (mandatory)" : ""}`,
                ),
              );
            }
            console.log(JSON.stringify(starter, null, 2));
          }
          return;
        }

        if (!options.states) {
          console.error(
            chalk.red("✗ ") +
              "--states <path> is required (or use --list to print a starter states file)",
          );
          process.exit(2);
          return;
        }

        let states: Record<string, CertControlState>;
        try {
          const parsed: unknown = JSON.parse(readFileSync(options.states, "utf8"));
          states = parseStates(scheme, parsed);
        } catch (err) {
          console.error(chalk.red("✗ ") + (err as Error).message);
          process.exit(2);
          return;
        }

        let defaultState: CertControlState | undefined;
        if (options.defaultState !== undefined) {
          if (!STATES.includes(options.defaultState as CertControlState)) {
            console.error(
              chalk.red("✗ ") +
                `invalid --default-state "${options.defaultState}". Valid: ${STATES.join(" | ")}`,
            );
            process.exit(2);
            return;
          }
          defaultState = options.defaultState as CertControlState;
        }

        const auditLeadWeeks =
          options.auditLeadWeeks === undefined
            ? undefined
            : parseGateThreshold(options.auditLeadWeeks, "--audit-lead-weeks", { min: 0, max: 520 });

        const analysis = analyzeCertificationGap(scheme, states, {
          ...(defaultState ? { defaultState } : {}),
          ...(auditLeadWeeks === undefined ? {} : { auditLeadWeeks }),
        });

        if (options.json) {
          console.log(JSON.stringify(analysis, null, 2));
        } else {
          renderHuman(analysis);
        }

        if (
          options.minReadiness !== undefined &&
          analysis.readinessScore <
            parseGateThreshold(options.minReadiness, "--min-readiness", { min: 0, max: 100 })
        ) {
          process.exit(1);
        }
      },
    );
}
