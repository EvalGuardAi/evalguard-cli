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
 *   0 — the tree was fully examined and nothing sits above the threshold
 *   1 — findings above the threshold (gate fail)
 *   2 — internal error (bad flags)
 *   3 — NOTHING WAS EXAMINED, or the examination was incomplete. Never
 *       conflate this with 0: a scan that did not read the tree has not
 *       cleared it. See RepoScanStatus below.
 *
 * The exit-code contract deliberately reserves a distinct code for "found
 * nothing scannable" rather than folding that case into success: a scanner
 * that discovered no supported target files has produced no evidence, so
 * reporting 0 would be a false pass in any CI gate consuming this command.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSeverityGate } from "../lib/gate-threshold.js";

type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Parse a `--fail-on` value. Returns null for anything that is not one of the
 * four severities.
 *
 * The obvious `if (v in SEVERITY_RANK)` guard is UNSOUND and was the shipped
 * one: `in` walks the prototype chain, so `constructor`, `__proto__`,
 * `toString`, `valueOf`, `hasOwnProperty`, … all pass. `SEVERITY_RANK[v]` is
 * then a function or an object, every `rank >= threshold` comparison coerces
 * to NaN and is false, `flagged` is 0, and the gate exits 0 on a repo full of
 * criticals. `--fail-on constructor` was a one-flag, spelled-like-a-typo way
 * to permanently green a PR gate.
 *
 * The implementation now lives in `lib/gate-threshold.ts` alongside the numeric
 * gate parser, because the same bug was still shipping in iac-scan, secret-scan
 * and scan:local. This wrapper keeps repo-scan's own `Severity` type and its
 * public name; it is not a second copy.
 */
export function parseSeverity(raw: string): Severity | null {
  const parsed = parseSeverityGate(raw);
  return parsed === null ? null : (parsed as Severity);
}

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

/**
 * Everything the walk could NOT look at. Core's `walkRepoFiles` takes an
 * injected FileSystemAdapter (so the same scanner runs in the browser
 * playground) and an adapter that swallows its errors — which this one used
 * to do, silently — turns "we were denied" into "we found nothing", i.e. a
 * clean gate. Every entry recorded here is a hole in the scan's coverage and
 * `executeRepoScan` gates on it.
 */
export interface RepoScanDiagnostics {
  /** Directories whose listing failed: missing root, not a directory, EACCES. */
  unreadableDirs: string[];
  /** Regular files we selected for scanning but whose contents failed to load. */
  unreadableFiles: string[];
  /**
   * Files skipped by core's `maxBytes` cap. Informational for most kinds —
   * gating for agent-instruction kinds, see `oversizedScannable` below: a
   * `.cursorrules` padded past the cap is scanned as if it did not exist,
   * which is a one-commit gate bypass.
   */
  oversized: Array<{ path: string; sizeBytes: number }>;
  /**
   * Entries whose stat() failed — dangling symlinks, races. Recorded but NOT
   * gated on: git cannot carry an unreadable directory bit, so a dangling
   * symlink is a normal repo state and failing it closed would just teach
   * everyone to append `|| true` to the gate.
   */
  unstatable: string[];
}

export function emptyDiagnostics(): RepoScanDiagnostics {
  return { unreadableDirs: [], unreadableFiles: [], oversized: [], unstatable: [] };
}

/** Injected in tests to simulate an unreadable file without chmod games. */
type ReadTextFn = (p: string) => Promise<string>;

function buildFsAdapter(
  diag: RepoScanDiagnostics,
  maxBytes: number,
  readText?: ReadTextFn,
) {
  // Lazy import the scanner adapter shape from core (it expects an
  // injected FileSystemAdapter so the same code can run in browser
  // playgrounds + node). Here we wire it to real Node fs.
  const read: ReadTextFn = readText ?? ((p) => fs.promises.readFile(p, "utf-8"));
  return {
    async list(dir: string): Promise<string[]> {
      try {
        return await fs.promises.readdir(dir);
      } catch {
        diag.unreadableDirs.push(dir);
        return [];
      }
    },
    async readText(p: string): Promise<string> {
      try {
        return await read(p);
      } catch {
        // Returning "" here is what core's walker expects, but an empty body
        // scans clean by construction — so the caller MUST see this.
        diag.unreadableFiles.push(p);
        return "";
      }
    },
    async stat(p: string): Promise<{ isDirectory: boolean; isFile: boolean; sizeBytes: number }> {
      try {
        const s = await fs.promises.stat(p);
        // Mirror of core's `if (st.sizeBytes > maxBytes) continue` — recorded
        // here because the walker drops the file with no trace, and a dropped
        // file is indistinguishable from a clean one downstream.
        if (s.isFile() && s.size > maxBytes) diag.oversized.push({ path: p, sizeBytes: s.size });
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
      } catch {
        diag.unstatable.push(p);
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
  /** Test seam: substitute the file reader (simulate EACCES deterministically). */
  readTextOverride?: (p: string) => Promise<string>;
}

export interface RepoScanFindingOut {
  file: string;
  line: number;
  /**
   * Column is not produced by core's `scanRepoFiles` (it reports file + line
   * + snippet only), so this is absent in practice. Optional, not a required
   * field that is silently always undefined.
   */
  column?: number;
  patternId: string;
  description: string;
  severity: Severity;
  kind: string;
}

/**
 * Did the scan actually look at the tree?
 *
 *   ok              — walked the tree, read every file we selected.
 *   nothing-scanned — the walk produced zero files. Missing root, root is a
 *                     file, unreadable root, empty directory. A real checkout
 *                     is never empty, so this always means "wrong path" or
 *                     "the checkout step did not run".
 *   all-ignored     — files were discovered and the ignore-list removed every
 *                     one of them (e.g. a `**` line landed in
 *                     `.evalguard-scan-ignore` in the same PR as the payload).
 *   incomplete      — the tree was partly examined: a directory could not be
 *                     listed, a selected file could not be read, or an
 *                     agent-instruction file was dropped by the `--max-bytes`
 *                     cap. Each of those is a region the scanner never saw.
 *
 * Anything other than `ok` must not exit 0. A gate that says "pass" about
 * bytes it never read is worse than no gate, because it is trusted.
 */
export type RepoScanStatus = "ok" | "nothing-scanned" | "all-ignored" | "incomplete";

export interface RepoScanRunResult {
  root: string;
  scannedFiles: number;
  /** Files the walk produced, BEFORE the ignore-list was applied. */
  discoveredFiles: number;
  /** Files removed by --ignore / --ignore-file / .evalguard-scan-ignore. */
  ignoredFiles: number;
  bySeverity: Record<Severity, number>;
  byKind: Record<string, number>;
  findings: RepoScanFindingOut[];
  threshold: Severity;
  flagged: number;
  status: RepoScanStatus;
  /** Human-readable reason when status !== "ok". */
  statusDetail?: string;
  diagnostics: RepoScanDiagnostics;
  /**
   * Exit code the CLI wrapper should produce.
   *   0 — examined the tree, nothing at/above the threshold
   *   1 — findings at/above the threshold
   *   3 — the scan did not (fully) examine the tree; see `status`
   */
  exitCode: 0 | 1 | 3;
}

/**
 * Pure async function — same scan logic as the `.action()` wrapper but
 * returns instead of calling process.exit. Tests can invoke this
 * directly without process.exit hijacks (which races badly under
 * Promise-based action runners).
 */
export async function executeRepoScan(opts: RepoScanRunOptions): Promise<RepoScanRunResult> {
  const core = await import("@evalguard/core");
  const { walkRepoFiles, scanRepoFiles, classifyFile } = core as unknown as {
    walkRepoFiles: (root: string, fs: unknown, opts?: { maxBytes?: number }) => Promise<Array<{ path: string; body: string; kind: string }>>;
    scanRepoFiles: (files: ReadonlyArray<{ path: string; body: string; kind: string }>) => {
      findings: Array<{ file: string; line: number; column?: number; patternId: string; description: string; severity: Severity; kind: string }>;
      scannedFiles: number;
      bySeverity: Record<Severity, number>;
      byKind: Record<string, number>;
    };
    /** Reused — NOT reimplemented — so "is this file scannable?" cannot drift. */
    classifyFile: (p: string) => string;
  };
  const diagnostics = emptyDiagnostics();
  const fsAdapter = buildFsAdapter(diagnostics, opts.maxBytes, opts.readTextOverride);
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

  /* ── coverage gate ─────────────────────────────────────────────────────
   * Decide whether this scan is entitled to say "clean". Computed from what
   * the walk COULD NOT reach, never from the finding count — a finding count
   * of 0 is exactly what an unexamined tree produces.
   */
  const rootPrefix = opts.rootAbs.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const toRel = (abs: string): string => {
    const norm = abs.replace(/\\/g, "/");
    return norm.startsWith(rootPrefix) ? norm.slice(rootPrefix.length) : norm;
  };
  // A file over the byte cap only blinds the gate if it is a kind the scanner
  // would have had rules for. A 4 MB PNG or lockfile is correctly skipped.
  const oversizedScannable = diagnostics.oversized.filter(
    (o) => classifyFile(toRel(o.path)) !== "other",
  );
  // Ignored files are the operator's explicit choice, so an unreadable file
  // that the ignore-list would have dropped anyway is not a blind spot.
  const unreadableSelected = diagnostics.unreadableFiles.filter((abs) => {
    const rel = toRel(abs);
    return !ignorePatterns.some((p) => matchesIgnore(rel, p));
  });

  let status: RepoScanStatus = "ok";
  let statusDetail: string | undefined;
  if (allFiles.length === 0) {
    status = "nothing-scanned";
    statusDetail =
      diagnostics.unreadableDirs.length > 0
        ? `could not list ${diagnostics.unreadableDirs.length} director(ies), starting at '${opts.rootAbs}' — wrong --path, or the checkout never happened`
        : `'${opts.rootAbs}' contained no files`;
  } else if (files.length === 0) {
    status = "all-ignored";
    statusDetail = `all ${allFiles.length} discovered file(s) were removed by the ignore-list (${ignorePatterns.length} pattern(s)) — the scanner examined nothing`;
  } else if (
    diagnostics.unreadableDirs.length > 0 ||
    unreadableSelected.length > 0 ||
    oversizedScannable.length > 0
  ) {
    status = "incomplete";
    const parts: string[] = [];
    if (diagnostics.unreadableDirs.length > 0) parts.push(`${diagnostics.unreadableDirs.length} unlistable director(ies)`);
    if (unreadableSelected.length > 0) parts.push(`${unreadableSelected.length} unreadable file(s)`);
    if (oversizedScannable.length > 0) {
      parts.push(
        `${oversizedScannable.length} agent-instruction file(s) over --max-bytes=${opts.maxBytes} ` +
          `(${oversizedScannable.map((o) => `${toRel(o.path)}:${o.sizeBytes}B`).slice(0, 5).join(", ")}) — ` +
          `raise --max-bytes or the payload hides behind the cap`,
      );
    }
    statusDetail = parts.join("; ");
  }

  return {
    root: opts.rootAbs,
    scannedFiles: result.scannedFiles,
    discoveredFiles: allFiles.length,
    ignoredFiles: allFiles.length - files.length,
    bySeverity: result.bySeverity,
    byKind: result.byKind,
    findings: result.findings,
    threshold: opts.failOn,
    flagged: flagged.length,
    status,
    statusDetail,
    diagnostics,
    // Findings win over coverage: both fail the gate, and a confirmed critical
    // is the more actionable of the two. But `status !== "ok"` can NEVER be 0.
    exitCode: flagged.length > 0 ? 1 : status === "ok" ? 0 : 3,
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
      const failOn = parseSeverity(opts.failOn);
      if (failOn === null) {
        console.error(chalk.red(`Invalid --fail-on '${opts.failOn}'. Use low|medium|high|critical.`));
        process.exit(2);
        return;
      }
      const maxBytes = Number(opts.maxBytes);
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        console.error(chalk.red(`Invalid --max-bytes '${opts.maxBytes}'`));
        process.exit(2);
        return;
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
          discoveredFiles: result.discoveredFiles,
          ignoredFiles: result.ignoredFiles,
          bySeverity: result.bySeverity,
          byKind: result.byKind,
          findings: result.findings,
          threshold: result.threshold,
          flagged: result.flagged,
          // Coverage, not findings. A consumer that reads `flagged === 0` as
          // "clean" without checking `status` is reading the wrong field —
          // that is exactly the bug this exists to make impossible to miss.
          status: result.status,
          statusDetail: result.statusDetail ?? null,
          diagnostics: result.diagnostics,
          exitCode: result.exitCode,
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + os.EOL);
      } else {
        // Human-readable.
        console.log();
        console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — repo-scan"));
        console.log(chalk.dim("  ────────────────────────────────────"));
        console.log();
        console.log(`  Root:     ${chalk.cyan(rootAbs)}`);
        console.log(
          `  Scanned:  ${chalk.cyan(String(result.scannedFiles))} files` +
            (result.ignoredFiles > 0 ? chalk.dim(`  (${result.ignoredFiles} ignored of ${result.discoveredFiles} discovered)`) : ""),
        );
        console.log(`  By kind:  ${formatKindCounts(result.byKind)}`);
        console.log();

        if (result.findings.length === 0) {
          // "No findings" is only good news when the tree was examined. Say
          // which one it is — never print a green tick over a blind scan.
          if (result.status === "ok") {
            console.log(chalk.green("  ✓ No findings"));
          } else {
            console.log(chalk.red("  ✗ No findings — because nothing was examined"));
          }
          console.log();
        } else {
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

        if (result.status !== "ok") {
          console.log(chalk.red(`  ✗ Incomplete scan (${result.status}): ${result.statusDetail}`));
          console.log(chalk.dim("    Exit 3 — coverage, not findings. Fix the path/ignore-list/cap and re-run."));
          console.log();
        }
      }

      if (result.flagged > 0 && !opts.json) {
        console.log(
          chalk.red(`  ✗ ${result.flagged} finding(s) at or above '${failOn}' — gate failed.`),
        );
        console.log();
      }

      // Only hard-exit on failure. On success we fall off the end so Node
      // flushes stdout first — `process.exit(0)` can truncate a piped
      // `--json` payload, and this workflow has already been burned once by
      // a scan whose stdout was not what the next step assumed
      // (.github/workflows/repo-scan.yml, the ERR_PNPM_RECURSIVE_EXEC note).
      if (result.exitCode !== 0) process.exit(result.exitCode);
    });
}

function formatKindCounts(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" · ");
}
