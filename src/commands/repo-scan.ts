/**
 * `evalguard repo-scan` — Wave-I+ wiring.
 *
 * Walks a repository's agent-instruction files (.cursorrules /
 * CLAUDE.md / mcp.json / SKILL.md / system-prompt / agent-prompt)
 * and runs scanRepoFiles against the discovered set. Emits findings
 * as human-readable output (default) or JSON (for CI consumption).
 *
 * Usage:
 *   evalguard repo-scan [--path=.] [--json] [--fail-on=critical|high|medium|low]
 *
 * Designed to be called from the repo-scan GitHub Action (PR-time
 * gate) — but useful locally too. Exit code:
 *
 *   0 — no findings above the threshold
 *   1 — findings above the threshold (gate fail)
 *   2 — internal error
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  low: chalk.gray,
  medium: chalk.yellow,
  high: chalk.hex("#ff8800"),
  critical: chalk.red,
};

interface ScanOptions {
  path: string;
  json: boolean;
  failOn: Severity;
  maxBytes?: number;
  ignorePaths?: readonly string[];
}

/**
 * Glob-style path matcher. Supports:
 *   *        — single path segment wildcard
 *   **       — any number of path segments
 *   relative  paths are matched against the relative path of each
 *             scanned file (root-relative).
 *
 * Kept tiny + dependency-free. Real repos with complex needs can
 * graduate to a real glob library.
 */
export function matchesIgnore(relPath: string, pattern: string): boolean {
  // Normalize to forward slashes for cross-platform.
  const p = relPath.replace(/\\/g, "/");
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\\/g, "/")
        .replace(/[.+^$()|[\]{}]/g, "\\$&")
        .replace(/\*\*/g, "<<DSTAR>>")
        .replace(/\*/g, "[^/]*")
        .replace(/<<DSTAR>>/g, ".*") +
      "$",
  );
  return re.test(p);
}

async function buildFsAdapter() {
  // Lazy import the scanner adapter shape from core (it expects an
  // injected FileSystemAdapter so the same code can run in browser
  // playgrounds + node). Here we wire it to real Node fs.
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
    async stat(p: string): Promise<{ isDirectory: boolean; isFile: boolean; sizeBytes: number }> {
      try {
        const s = await fs.promises.stat(p);
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
      } catch {
        return { isDirectory: false, isFile: false, sizeBytes: 0 };
      }
    },
  };
}

export interface RepoScanRunOptions {
  rootAbs: string;
  failOn: Severity;
  maxBytes: number;
  ignore?: readonly string[];
  ignoreFile?: string;
  /** If false, don't auto-load .evalguard-scan-ignore from rootAbs. */
  conventionalIgnore?: boolean;
}

export interface RepoScanFindingOut {
  file: string;
  line: number;
  column: number;
  patternId: string;
  description: string;
  severity: Severity;
  kind: string;
}

export interface RepoScanRunResult {
  root: string;
  scannedFiles: number;
  bySeverity: Record<Severity, number>;
  byKind: Record<string, number>;
  findings: RepoScanFindingOut[];
  threshold: Severity;
  flagged: number;
  /** Exit code the CLI wrapper should produce: 0 clean, 1 flagged. */
  exitCode: 0 | 1;
}

/**
 * Pure async function — same scan logic as the `.action()` wrapper but
 * returns instead of calling process.exit. Tests can invoke this
 * directly without process.exit hijacks (which races badly under
 * Promise-based action runners).
 */
export async function executeRepoScan(opts: RepoScanRunOptions): Promise<RepoScanRunResult> {
  const core = await import("@evalguard/core");
  const { walkRepoFiles, scanRepoFiles } = core as unknown as {
    walkRepoFiles: (root: string, fs: unknown, opts?: { maxBytes?: number }) => Promise<Array<{ path: string; body: string; kind: string }>>;
    scanRepoFiles: (files: ReadonlyArray<{ path: string; body: string; kind: string }>) => {
      findings: Array<{ file: string; line: number; column: number; patternId: string; description: string; severity: Severity; kind: string }>;
      scannedFiles: number;
      bySeverity: Record<Severity, number>;
      byKind: Record<string, number>;
    };
  };
  const fsAdapter = await buildFsAdapter();
  const ignorePatterns: string[] = [...(opts.ignore ?? [])];
  if (opts.ignoreFile) {
    const ignoreFilePath = path.resolve(opts.ignoreFile);
    if (fs.existsSync(ignoreFilePath)) {
      const raw = fs.readFileSync(ignoreFilePath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        ignorePatterns.push(trimmed);
      }
    }
  }
  const conventionalAllowed = opts.conventionalIgnore !== false;
  const conventionalIgnoreFile = path.join(opts.rootAbs, ".evalguard-scan-ignore");
  if (
    conventionalAllowed &&
    !opts.ignoreFile &&
    fs.existsSync(conventionalIgnoreFile)
  ) {
    const raw = fs.readFileSync(conventionalIgnoreFile, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      ignorePatterns.push(trimmed);
    }
  }
  const allFiles = await walkRepoFiles(opts.rootAbs, fsAdapter, { maxBytes: opts.maxBytes });
  const files = ignorePatterns.length === 0
    ? allFiles
    : allFiles.filter((f) => !ignorePatterns.some((p) => matchesIgnore(f.path, p)));
  const result = scanRepoFiles(files);
  const threshold = SEVERITY_RANK[opts.failOn];
  const flagged = result.findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold);
  return {
    root: opts.rootAbs,
    scannedFiles: result.scannedFiles,
    bySeverity: result.bySeverity,
    byKind: result.byKind,
    findings: result.findings,
    threshold: opts.failOn,
    flagged: flagged.length,
    exitCode: flagged.length > 0 ? 1 : 0,
  };
}

export function registerRepoScan(program: Command): void {
  program
    .command("repo-scan")
    .description("Scan a repo's agent-instruction files for prompt-injection / supply-chain risks")
    .option("--path <dir>", "Root directory to scan", process.cwd())
    .option("--json", "Emit JSON output (for CI consumption)", false)
    .option("--fail-on <severity>", "Exit 1 if any finding ≥ this severity (low|medium|high|critical)", "high")
    .option("--max-bytes <n>", "Max bytes per file before skipping (default 256KB)", "262144")
    .option(
      "--ignore <glob...>",
      "Glob(s) to ignore (e.g. 'docs/**' 'packages/skills/**'). Repeatable.",
    )
    .option(
      "--ignore-file <path>",
      "File containing one glob per line (lines starting with '#' are comments)",
    )
    .option(
      "--no-conventional-ignore",
      "Don't auto-load .evalguard-scan-ignore from the scanned root. " +
        "Use this in PR-gate workflows to prevent attackers from amending " +
        "the ignore-list in the same PR (workflow should pass --ignore-file " +
        "pointing to the BASELINE ignore-list checked out from the PR's base ref).",
    )
    .action(async (opts: { path: string; json: boolean; failOn: string; maxBytes: string; ignore?: string[]; ignoreFile?: string; conventionalIgnore?: boolean }) => {
      const failOn = opts.failOn.toLowerCase() as Severity;
      if (!(failOn in SEVERITY_RANK)) {
        console.error(chalk.red(`Invalid --fail-on '${opts.failOn}'. Use low|medium|high|critical.`));
        process.exit(2);
      }
      const maxBytes = Number(opts.maxBytes);
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        console.error(chalk.red(`Invalid --max-bytes '${opts.maxBytes}'`));
        process.exit(2);
      }

      const rootAbs = path.resolve(opts.path);

      // Pure scan logic lives in executeRepoScan — easier to test
      // without process.exit hijacks. The action wrapper just handles
      // I/O formatting + exit-code dispatch.
      const result = await executeRepoScan({
        rootAbs,
        failOn,
        maxBytes,
        ignore: opts.ignore,
        ignoreFile: opts.ignoreFile,
        conventionalIgnore: opts.conventionalIgnore,
      });

      if (opts.json) {
        const payload = {
          root: result.root,
          scannedFiles: result.scannedFiles,
          bySeverity: result.bySeverity,
          byKind: result.byKind,
          findings: result.findings,
          threshold: result.threshold,
          flagged: result.flagged,
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + os.EOL);
      } else {
        // Human-readable.
        console.log();
        console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — repo-scan"));
        console.log(chalk.dim("  ────────────────────────────────────"));
        console.log();
        console.log(`  Root:     ${chalk.cyan(rootAbs)}`);
        console.log(`  Scanned:  ${chalk.cyan(String(result.scannedFiles))} files`);
        console.log(`  By kind:  ${formatKindCounts(result.byKind)}`);
        console.log();

        if (result.findings.length === 0) {
          console.log(chalk.green("  ✓ No findings"));
          console.log();
          // Don't process.exit here — the bottom-of-action dispatch
          // handles exit-code based on result.exitCode. Calling exit
          // mid-action conflicts with commander's promise-based runner.
          return;
        }

        const { critical, high, medium, low } = result.bySeverity;
        console.log(`  Findings: ${SEVERITY_COLOR.critical(`${critical} critical`)} · ${SEVERITY_COLOR.high(`${high} high`)} · ${SEVERITY_COLOR.medium(`${medium} medium`)} · ${SEVERITY_COLOR.low(`${low} low`)}`);
        console.log();

        // Group by file for readability.
        const byFile = new Map<string, typeof result.findings>();
        for (const f of result.findings) {
          const arr = byFile.get(f.file) ?? [];
          arr.push(f);
          byFile.set(f.file, arr);
        }

        for (const [file, findings] of byFile) {
          console.log(`  ${chalk.bold(file)}`);
          for (const f of findings) {
            const color = SEVERITY_COLOR[f.severity];
            console.log(`    ${color(`[${f.severity}]`)} ${chalk.cyan(f.patternId)} L${f.line} — ${f.description}`);
          }
          console.log();
        }
      }

      if (result.flagged > 0) {
        if (!opts.json) {
          console.log(
            chalk.red(`  ✗ ${result.flagged} finding(s) at or above '${failOn}' — gate failed.`),
          );
          console.log();
        }
        process.exit(1);
      }
      process.exit(0);
    });
}

function formatKindCounts(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" · ");
}
