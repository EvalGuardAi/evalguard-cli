/**
 * `evalguard secret-scan [path]` — G10.
 *
 * Signature-based detection of committed secrets (API keys, private keys,
 * cloud/SaaS tokens) by scanning repo file CONTENTS. Walks the target dir
 * with core's repo walker, runs the curated secret rules over every file,
 * and reports findings as human-readable text (default), JSON, or SARIF
 * 2.1.0 (for GitHub Code Scanning ingestion).
 *
 * The matched secret is ALWAYS redacted — the raw value never leaves core.
 *
 * Usage:
 *   evalguard secret-scan [path] [--json] [--sarif <file>] [--fail-on-secret]
 *
 * Exit code:
 *   0 — no secrets found (or none ≥ the fail threshold)
 *   1 — secrets found at/above the fail threshold (CI gate fail)
 *   2 — internal / argument error
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { parseSeverityGate, severityRank } from "../lib/gate-threshold.js";

type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Decide whether a secret-scan run should FAIL (exit 1) given its reported
 * findings + gate settings. Pure and exported for testing.
 *
 * Gating is ON by DEFAULT at "high" (parity with iac-scan / code-scan) so a bare
 * `secret-scan` in CI actually blocks on committed secrets — the previous default
 * silently exited 0. `failOnSecret` (back-compat) gates on ANY reported secret
 * (down to `minSeverity`); `failOn === "none"` disables gating (report-only).
 */
export function resolveSecretScanGate(
  reported: readonly { severity: Severity }[],
  minSeverity: Severity,
  failOn: string,
  failOnSecret: boolean,
): { shouldFail: boolean; gatedCount: number; gateLabel: string } {
  const fo = (failOn ?? "high").toLowerCase().trim();
  // `severityRank` is a Map lookup and `?? 0` is a FAIL-CLOSED default (gate
  // everything), which is the whole difference from what shipped:
  // `SEVERITY_RANK[fo] ?? SEVERITY_RANK.high` did NOT fall back for a prototype
  // key — `SEVERITY_RANK["constructor"]` is the Object constructor, truthy and
  // non-nullish — so `gateRank` became a function, every
  // `SEVERITY_RANK[f.severity] >= gateRank` was a NaN comparison, `gatedCount`
  // was 0, and `secret-scan --fail-on constructor` exited 0 over committed
  // credentials. See lib/gate-threshold.ts; the flag parser rejects it too, and
  // this is the second line so a direct caller of this exported helper cannot
  // reintroduce the hole.
  const gateRank = failOnSecret
    ? severityRank(minSeverity) ?? 0
    : fo === "none"
      ? Number.POSITIVE_INFINITY
      : severityRank(fo) ?? 0;
  const gatedCount = reported.filter((f) => (severityRank(f.severity) ?? 0) >= gateRank).length;
  return { shouldFail: gatedCount > 0, gatedCount, gateLabel: failOnSecret ? minSeverity : fo };
}

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  low: chalk.gray,
  medium: chalk.yellow,
  high: chalk.hex("#ff8800"),
  critical: chalk.red,
};

interface RepoSecretFindingShape {
  ruleId: string;
  description: string;
  severity: Severity;
  line: number;
  column: number;
  charOffset: number;
  redactedMatch: string;
  matchLength: number;
  file: string;
}

/** Node fs adapter for core's walkRepoFiles (same shape repo-scan uses). */
function buildFsAdapter() {
  return {
    async list(dir: string): Promise<string[]> {
      try {
        return await fs.promises.readdir(dir);
      } catch {
        return [];
      }
    },
    async readText(p: string): Promise<string> {
      try {
        return await fs.promises.readFile(p, "utf-8");
      } catch {
        return "";
      }
    },
    async stat(
      p: string,
    ): Promise<{ isDirectory: boolean; isFile: boolean; sizeBytes: number }> {
      try {
        const s = await fs.promises.stat(p);
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
      } catch {
        return { isDirectory: false, isFile: false, sizeBytes: 0 };
      }
    },
  };
}

/** Files staged for commit (added/copied/modified/renamed). Mirrors the git
 *  command EvalGuard's own pre-commit scanner uses. */
function stagedFiles(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
      { encoding: "utf-8" },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    console.error(chalk.red("  ✗ `git diff --cached` failed — run from a git repository with git installed."));
    process.exit(2);
  }
}

/** Install a pre-commit hook that gates commits on staged-file secret scanning.
 *  Prefers husky if present, else a raw .git/hooks/pre-commit. Idempotent. */
export function installPreCommitHook(cwd: string = process.cwd()): void {
  const cmd = "npx --no-install evalguard secret-scan --staged --fail-on-secret";
  const marker = "secret-scan --staged";
  const huskyDir = path.join(cwd, ".husky");
  const usingHusky = fs.existsSync(huskyDir);
  const hookPath = usingHusky
    ? path.join(huskyDir, "pre-commit")
    : path.join(cwd, ".git", "hooks", "pre-commit");

  if (!usingHusky && !fs.existsSync(path.join(cwd, ".git"))) {
    console.error(chalk.red("  ✗ Not a git repository (no .git). Run from your repo root."));
    process.exit(2);
  }

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf-8");
    if (existing.includes(marker)) {
      console.log(chalk.yellow(`  pre-commit already runs secret-scan --staged (${path.relative(cwd, hookPath)}); nothing to do.`));
      return;
    }
    fs.writeFileSync(hookPath, existing.replace(/\n*$/, "\n") + cmd + "\n");
  } else {
    if (!usingHusky) fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    // husky v9 hooks are plain scripts (no shebang needed); raw git hooks need one.
    fs.writeFileSync(hookPath, usingHusky ? `${cmd}\n` : `#!/bin/sh\n${cmd}\n`);
  }
  if (!usingHusky) fs.chmodSync(hookPath, 0o755);

  console.log(chalk.green(`  ✓ Installed pre-commit hook → ${path.relative(cwd, hookPath)}`));
  console.log(chalk.dim(`    runs: ${cmd}`));
  if (usingHusky) console.log(chalk.dim("    (husky detected)"));
}

export function registerSecretScan(program: Command): void {
  program
    .command("secret-scan")
    .description(
      "Scan repo file contents for committed secrets (API keys, private keys, tokens)",
    )
    .argument("[path]", "Root directory (or single file) to scan", ".")
    .option("--json", "Emit JSON output (for CI consumption)", false)
    .option(
      "--sarif <file>",
      "Write SARIF 2.1.0 findings to <file> (for GitHub Code Scanning upload)",
    )
    .option(
      "--fail-on <severity>",
      "Exit 1 if any finding ≥ this severity (low|medium|high|critical), or 'none' to disable gating. Gates on high+ by DEFAULT (consistent with iac-scan/code-scan).",
      "high",
    )
    .option(
      "--fail-on-secret",
      "Back-compat: gate on ANY reported secret regardless of severity (equivalent to --fail-on <min-severity>).",
      false,
    )
    .option(
      "--min-severity <severity>",
      "Only report findings ≥ this severity (low|medium|high|critical)",
      "low",
    )
    .option("--max-bytes <n>", "Max bytes per file before skipping (default 1MB)", "1048576")
    .option(
      "--ignore-path <substr...>",
      "Skip files whose path contains any of these substrings (e.g. __tests__ fixtures). Repeatable.",
    )
    .option(
      "--staged",
      "Scan ONLY git-staged files (git diff --cached). For use in a pre-commit hook.",
      false,
    )
    .option(
      "--install-hook",
      "Install a git pre-commit hook that runs `secret-scan --staged --fail-on-secret`, then exit.",
      false,
    )
    .action(
      async (
        pathArg: string,
        opts: {
          json: boolean;
          sarif?: string;
          failOn: string;
          failOnSecret: boolean;
          minSeverity: string;
          maxBytes: string;
          ignorePath?: string[];
          staged: boolean;
          installHook: boolean;
        },
      ) => {
        // --install-hook is a one-shot installer, not a scan.
        if (opts.installHook) {
          installPreCommitHook();
          return;
        }
        // Allow-list, never `in` — see lib/gate-threshold.ts.
        const parsedMin = parseSeverityGate(opts.minSeverity);
        const minSeverity = (parsedMin ?? "") as Severity;
        if (parsedMin === null) {
          console.error(
            chalk.red(`Invalid --min-severity '${opts.minSeverity}'. Use low|medium|high|critical.`),
          );
          process.exit(2);
        }
        const maxBytes = Number(opts.maxBytes);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
          console.error(chalk.red(`Invalid --max-bytes '${opts.maxBytes}'`));
          process.exit(2);
        }

        const target = path.resolve(pathArg);
        if (!fs.existsSync(target)) {
          console.error(chalk.red(`  ✗ Path not found: ${target}`));
          process.exit(2);
        }

        const core = (await import("@evalguard/core")) as unknown as {
          walkRepoFiles: (
            root: string,
            fsa: unknown,
            o?: { maxBytes?: number },
          ) => Promise<Array<{ path: string; body: string }>>;
          scanRepoForSecrets: (
            files: ReadonlyArray<{ path: string; body: string }>,
            o?: { maxBytes?: number; ignorePathSubstrings?: readonly string[] },
          ) => {
            scannedFiles: number;
            findings: RepoSecretFindingShape[];
            bySeverity: Record<Severity, number>;
            filesWithFindings: number;
          };
          secretFindingsToSarif: (findings: readonly RepoSecretFindingShape[]) => string;
        };

        const fsAdapter = buildFsAdapter();
        const stat = fs.statSync(target);
        let files: Array<{ path: string; body: string }>;
        if (opts.staged) {
          // Scan only files staged for commit (working-tree content), mirroring
          // EvalGuard's own pre-commit scanner. Exits clean when nothing relevant
          // is staged so it never wastes a commit.
          const staged = stagedFiles();
          if (staged.length === 0) {
            if (!opts.json) console.log(chalk.dim("  No staged files to scan."));
            process.exit(0);
          }
          files = [];
          for (const rel of staged) {
            const abs = path.resolve(rel);
            if (!fs.existsSync(abs)) continue; // staged-then-deleted
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > maxBytes) continue;
            files.push({ path: rel, body: await fs.promises.readFile(abs, "utf-8").catch(() => "") });
          }
        } else if (stat.isFile()) {
          const body = await fs.promises.readFile(target, "utf-8").catch(() => "");
          files = [{ path: path.relative(process.cwd(), target) || path.basename(target), body }];
        } else {
          files = await core.walkRepoFiles(target, fsAdapter, { maxBytes });
        }

        const result = core.scanRepoForSecrets(files, {
          maxBytes,
          ignorePathSubstrings: opts.ignorePath,
        });

        // Map lookup — cannot resolve to a prototype member. `?? 0` gates
        // everything if a threshold ever reaches here unvalidated.
        const threshold = severityRank(minSeverity) ?? 0;
        const reported = result.findings.filter(
          (f) => (severityRank(f.severity) ?? 0) >= threshold,
        );

        // Gate: exit 1 when a reported finding meets the fail-on threshold. Gating
        // is ON by default at "high" (parity with iac-scan / code-scan) so a bare
        // `secret-scan` in CI actually blocks on committed secrets — the previous
        // default silently exited 0. `--fail-on-secret` (back-compat) gates on ANY
        // reported secret; `--fail-on none` disables gating (report-only).
        // `--fail-on constructor` passed the old `in` check, made the gate
        // rank a function, and exited 0 over committed credentials.
        const parsedFailOn = parseSeverityGate(opts.failOn ?? "high", { allowNone: true });
        if (parsedFailOn === null) {
          console.error(
            chalk.red(`Invalid --fail-on '${opts.failOn}'. Use low|medium|high|critical|none.`),
          );
          process.exit(2);
          return;
        }
        const failOn = parsedFailOn;
        const gate = resolveSecretScanGate(reported, minSeverity, failOn, opts.failOnSecret);
        const shouldFail = gate.shouldFail;

        // SARIF file output.
        if (opts.sarif) {
          const outPath = path.resolve(opts.sarif);
          const cwd = process.cwd();
          // Containment: must be cwd or below (separator boundary, not bare startsWith).
          if (outPath !== cwd && !outPath.startsWith(cwd + path.sep)) {
            console.error(
              chalk.red(`  ✗ SARIF output path must be within current directory (got ${outPath})`),
            );
            process.exit(2);
          }
          fs.writeFileSync(outPath, core.secretFindingsToSarif(reported));
          console.log(
            `  ${chalk.green("✓")} Wrote ${reported.length} secret finding(s) to ${chalk.cyan(opts.sarif)}`,
          );
          process.exit(shouldFail ? 1 : 0);
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                scannedFiles: result.scannedFiles,
                filesWithFindings: result.filesWithFindings,
                bySeverity: result.bySeverity,
                findingsCount: reported.length,
                findings: reported,
              },
              null,
              2,
            ) + "\n",
          );
          process.exit(shouldFail ? 1 : 0);
        }

        // Human-readable.
        console.log();
        console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — secret-scan"));
        console.log(chalk.dim("  ────────────────────────────────────"));
        console.log();
        console.log(`  Root:     ${chalk.cyan(target)}`);
        console.log(`  Scanned:  ${chalk.cyan(String(result.scannedFiles))} files`);
        console.log();

        if (reported.length === 0) {
          console.log(chalk.green("  ✓ No committed secrets found"));
          console.log();
          process.exit(0);
        }

        const { critical, high, medium, low } = result.bySeverity;
        console.log(
          `  Findings: ${SEVERITY_COLOR.critical(`${critical} critical`)} · ${SEVERITY_COLOR.high(`${high} high`)} · ${SEVERITY_COLOR.medium(`${medium} medium`)} · ${SEVERITY_COLOR.low(`${low} low`)}`,
        );
        console.log();

        const byFile = new Map<string, RepoSecretFindingShape[]>();
        for (const f of reported) {
          const arr = byFile.get(f.file) ?? [];
          arr.push(f);
          byFile.set(f.file, arr);
        }
        for (const [file, fileFindings] of byFile) {
          console.log(`  ${chalk.bold(file)}`);
          for (const f of fileFindings) {
            const color = SEVERITY_COLOR[f.severity];
            console.log(
              `    ${color(`[${f.severity}]`)} ${chalk.cyan(f.ruleId)} L${f.line}:${f.column} — ${f.description} ${chalk.dim(`(${f.redactedMatch})`)}`,
            );
          }
          console.log();
        }

        if (shouldFail) {
          console.log(
            chalk.red(
              `  ✗ ${gate.gatedCount} secret(s) at or above '${gate.gateLabel}' — gate failed (exit 1). Pass --fail-on none for report-only.`,
            ),
          );
          console.log();
          process.exit(1);
        }
        process.exit(0);
      },
    );
}
