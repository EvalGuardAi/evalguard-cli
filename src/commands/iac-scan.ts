/**
 * `evalguard iac-scan [path]` — G8.
 *
 * Statically scans Dockerfiles, Kubernetes / Helm manifests, docker-compose
 * files and Terraform for **AI-infrastructure-scoped** misconfigurations:
 *
 *   - a model / inference server bound to 0.0.0.0 with no auth,
 *   - an exposed AI-service port (MLflow 5000, Ray 8265/6379, Jupyter 8888,
 *     Triton 8000/8001, vLLM 8000, TGI 80, …) with no auth / NetworkPolicy,
 *   - a hardcoded secret baked into an image ENV / build arg,
 *   - a privileged GPU container without resource limits.
 *
 * Reuses the infra-scan AI-service catalog (the same fingerprints the
 * `infra scan` exposure probe uses) and the repo-scan file walk. Output is
 * human-readable (default), JSON (--json) or SARIF 2.1.0 (--sarif <file>,
 * for GitHub Code Scanning). Stateless — no migration, no API key required.
 *
 * Exit codes:
 *   0 — no findings at/above the --fail-on threshold
 *   1 — findings at/above the threshold (CI gate fail)
 *   2 — internal / usage error
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSeverityGate, severityRank } from "../lib/gate-threshold.js";

type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  low: chalk.gray,
  medium: chalk.yellow,
  high: chalk.hex("#ff8800"),
  critical: chalk.red,
};

interface IacFinding {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  recommendation: string;
}

/** Should a discovered file be scanned as an IaC manifest? */
function isIacCandidate(relPath: string): boolean {
  const base = relPath.replace(/\\/g, "/");
  const name = base.slice(base.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return true;
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return true;
  if (name.endsWith(".tf") || name.endsWith(".tf.json")) return true;
  return false;
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", "target", ".venv", "venv",
]);

/** Walk a directory collecting IaC-candidate files (sync, dependency-free). */
function walkIacFiles(root: string, maxBytes: number): Array<{ filename: string; content: string }> {
  const out: Array<{ filename: string; content: string }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(root, full) || e.name;
      if (!isIacCandidate(rel)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.size > maxBytes) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      out.push({ filename: rel.replace(/\\/g, "/"), content });
    }
  }
  return out;
}

export interface IacScanRunOptions {
  targetAbs: string;
  failOn: Severity;
  maxBytes: number;
}

export interface IacScanRunResult {
  target: string;
  scannedFiles: number;
  findings: IacFinding[];
  bySeverity: Record<Severity, number>;
  threshold: Severity;
  flagged: number;
  exitCode: 0 | 1;
}

/**
 * Pure-ish executor: collects manifests, runs the core scanner, computes the
 * gate. Separated from the action wrapper so tests can invoke it without the
 * process.exit hijack races commander's promise runner is prone to.
 */
export async function executeIacScan(opts: IacScanRunOptions): Promise<IacScanRunResult> {
  const { scanIacFiles } = (await import("@evalguard/core")) as unknown as {
    scanIacFiles: (files: ReadonlyArray<{ filename: string; content: string }>) => {
      scannedFiles: number;
      findings: IacFinding[];
      bySeverity: Record<Severity, number>;
    };
  };

  let files: Array<{ filename: string; content: string }>;
  const st = fs.statSync(opts.targetAbs);
  if (st.isDirectory()) {
    files = walkIacFiles(opts.targetAbs, opts.maxBytes);
  } else {
    // Single file: scan regardless of extension (the core sniffs the type).
    const content = fs.readFileSync(opts.targetAbs, "utf-8");
    files = [{ filename: path.basename(opts.targetAbs), content }];
  }

  const result = scanIacFiles(files);
  // `severityRank`, not `SEVERITY_RANK[...]`: a Map lookup cannot return a
  // prototype member, so a threshold that slipped past the flag parser fails
  // CLOSED (gate everything) instead of comparing every finding against a
  // function and flagging nothing.
  const threshold = severityRank(opts.failOn);
  if (threshold === null) {
    throw new Error(
      `iac-scan: unusable --fail-on '${String(opts.failOn)}' — refusing to run a gate that cannot compare.`,
    );
  }
  const flagged = result.findings.filter((f) => (severityRank(f.severity) ?? 0) >= threshold);
  return {
    target: opts.targetAbs,
    scannedFiles: result.scannedFiles,
    findings: result.findings,
    bySeverity: result.bySeverity,
    threshold: opts.failOn,
    flagged: flagged.length,
    exitCode: flagged.length > 0 ? 1 : 0,
  };
}

/** SARIF 2.1.0 wrapper around the core emitter (lazy-loaded with the scanner). */
async function findingsToSarif(findings: IacFinding[]): Promise<string> {
  const { iacFindingsToSarif } = (await import("@evalguard/core")) as unknown as {
    iacFindingsToSarif: (findings: IacFinding[]) => string;
  };
  return iacFindingsToSarif(findings);
}

export function registerIacScan(program: Command): void {
  program
    .command("iac-scan")
    .description(
      "Statically scan Dockerfiles / K8s / Helm / compose / Terraform for AI-infra misconfigs " +
        "(exposed model servers, AI-service ports, baked secrets, privileged GPU containers)",
    )
    .argument("[path]", "File or directory to scan", ".")
    .option("--json", "Emit JSON output (for CI consumption)", false)
    .option("--sarif <file>", "Write SARIF 2.1.0 to <file> (for GitHub Code Scanning)")
    .option("--fail-on <severity>", "Exit 1 if any finding ≥ this severity (low|medium|high|critical)", "high")
    .option("--max-bytes <n>", "Max bytes per file before skipping (default 1MB)", "1048576")
    .action(
      async (
        pathArg: string,
        opts: { json: boolean; sarif?: string; failOn: string; maxBytes: string },
      ) => {
        // Allow-list, never `in`: `--fail-on constructor` satisfied the old
        // prototype-chain check, made `SEVERITY_RANK[failOn]` a function, and
        // turned every `rank >= threshold` into a NaN comparison — so the gate
        // exited 0 over a tree of criticals. See lib/gate-threshold.ts.
        const parsedFailOn = parseSeverityGate(opts.failOn);
        if (parsedFailOn === null) {
          console.error(chalk.red(`Invalid --fail-on '${opts.failOn}'. Use low|medium|high|critical.`));
          process.exit(2);
          return;
        }
        const failOn = parsedFailOn as Severity;
        const maxBytes = Number(opts.maxBytes);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
          console.error(chalk.red(`Invalid --max-bytes '${opts.maxBytes}'`));
          process.exit(2);
        }

        const targetAbs = path.resolve(pathArg);
        if (!fs.existsSync(targetAbs)) {
          console.error(chalk.red(`  ✗ Path not found: ${targetAbs}`));
          process.exit(2);
        }

        const result = await executeIacScan({ targetAbs, failOn, maxBytes });

        // SARIF file output.
        if (opts.sarif) {
          const outPath = path.resolve(opts.sarif);
          const cwd = process.cwd();
          // Containment: outPath must be cwd itself or below it (sep boundary
          // so "/x/proj-evil" can't slip past a "/x/proj" prefix check).
          if (outPath !== cwd && !outPath.startsWith(cwd + path.sep)) {
            console.error(chalk.red(`  ✗ SARIF output path must be within current directory (got ${outPath})`));
            process.exit(2);
          }
          fs.writeFileSync(outPath, await findingsToSarif(result.findings));
          if (!opts.json) {
            console.log(`  ${chalk.green("✓")} Wrote ${result.findings.length} finding(s) to ${chalk.cyan(opts.sarif)}`);
          }
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                target: result.target,
                scannedFiles: result.scannedFiles,
                bySeverity: result.bySeverity,
                findings: result.findings,
                threshold: result.threshold,
                flagged: result.flagged,
              },
              null,
              2,
            ) + os.EOL,
          );
        } else {
          console.log();
          console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — AI-infra IaC scan"));
          console.log(chalk.dim("  ───────────────────────────────────────"));
          console.log();
          console.log(`  Target:   ${chalk.cyan(targetAbs)}`);
          console.log(`  Scanned:  ${chalk.cyan(String(result.scannedFiles))} manifest file(s)`);
          console.log();

          if (result.findings.length === 0) {
            console.log(chalk.green("  ✓ No AI-infra misconfigurations found"));
            console.log();
          } else {
            const { critical, high, medium, low } = result.bySeverity;
            console.log(
              `  Findings: ${SEVERITY_COLOR.critical(`${critical} critical`)} · ` +
                `${SEVERITY_COLOR.high(`${high} high`)} · ` +
                `${SEVERITY_COLOR.medium(`${medium} medium`)} · ` +
                `${SEVERITY_COLOR.low(`${low} low`)}`,
            );
            console.log();

            const byFile = new Map<string, IacFinding[]>();
            for (const f of result.findings) {
              const arr = byFile.get(f.file) ?? [];
              arr.push(f);
              byFile.set(f.file, arr);
            }
            for (const [file, findings] of byFile) {
              console.log(`  ${chalk.bold(file)}`);
              for (const f of findings) {
                const color = SEVERITY_COLOR[f.severity];
                console.log(`    ${color(`[${f.severity}]`)} ${chalk.cyan(f.ruleId)} L${f.line} — ${f.title}`);
                console.log(chalk.dim(`        → ${f.recommendation}`));
              }
              console.log();
            }
          }
        }

        if (result.flagged > 0) {
          if (!opts.json) {
            console.log(chalk.red(`  ✗ ${result.flagged} finding(s) at or above '${failOn}' — gate failed.`));
            console.log();
          }
          process.exit(1);
        }
        process.exit(0);
      },
    );
}
