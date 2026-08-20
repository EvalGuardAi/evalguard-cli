/**
 * `evalguard code-scan [path]` — Scan source code for LLM-related vulns
 * (prompt injection, leaked AI keys, unsafe LLM call patterns).
 *
 * Outputs human-readable text by default; `--output <file>` emits JSON
 * suitable for CI consumption (line-level PR review comments via gh api).
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

interface CodeFindingJson {
  file: string;
  line: number;
  column: number;
  type: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  description: string;
  recommendation?: string;
  cweId?: string;
  code: string;
}

/**
 * Map code-scan findings to a SARIF 2.1.0 log. SARIF was designed for static
 * analysis, so each finding's file/line/column maps directly to a result
 * physicalLocation — this is the format GitHub Code Scanning ingests (upload the
 * file via `github/codeql-action/upload-sarif`). Severity → SARIF level:
 * critical/high → error, medium → warning, low/info → note.
 */
function toSarif(findings: CodeFindingJson[]): string {
  const levelFor = (sev: string): "error" | "warning" | "note" =>
    sev === "critical" || sev === "high" ? "error" : sev === "medium" ? "warning" : "note";
  const ruleMap = new Map<string, Record<string, unknown>>();
  for (const f of findings) {
    if (!ruleMap.has(f.type)) {
      ruleMap.set(f.type, {
        id: f.type,
        name: f.type,
        shortDescription: { text: f.description.slice(0, 160) },
        ...(f.cweId ? { properties: { cwe: f.cweId } } : {}),
      });
    }
  }
  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "EvalGuard",
            informationUri: "https://evalguard.ai",
            rules: Array.from(ruleMap.values()),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.type,
          level: levelFor(f.severity),
          message: { text: f.recommendation ? `${f.description} — ${f.recommendation}` : f.description },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file.replace(/\\/g, "/") },
                region: {
                  startLine: Math.max(1, f.line),
                  startColumn: Math.max(1, f.column),
                  snippet: { text: f.code },
                },
              },
            },
          ],
          ...(f.cweId ? { properties: { cwe: f.cweId } } : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

export function registerCodeScan(program: Command): void {
  program
    .command("code-scan")
    .description("Scan source code for LLM-related vulnerabilities (prompt injection, key leaks, unsafe call patterns)")
    .argument("[path]", "Path to file or directory to scan", ".")
    .option("--output <file>", "Write JSON findings to <file> instead of stdout")
    .option("--format <fmt>", "Output format: text, json, or sarif (SARIF 2.1.0 for GitHub Code Scanning)", "text")
    .option("--severity <level>", "Minimum severity to report (critical, high, medium, low, info)", "low")
    .option("--exclude <patterns>", "Comma-separated directory names to exclude (in addition to defaults)")
    .option("--max-file-size <bytes>", "Skip files larger than this (default: 1MB)", "1000000")
    .option("--language <langs>", "Comma-separated languages to scan (typescript, javascript, python). Default: all supported.")
    .action(async (
      pathArg: string,
      opts: {
        output?: string;
        format?: string;
        severity?: string;
        exclude?: string;
        maxFileSize?: string;
        language?: string;
      }
    ) => {
      const { CodeScanner } = (await import("@evalguard/core")) as {
        CodeScanner: new () => {
          scanFile: (filePath: string) => {
            filePath: string;
            language: string;
            findings: Array<{
              line: number;
              column: number;
              type: string;
              severity: "critical" | "high" | "medium" | "low" | "info";
              description: string;
              recommendation?: string;
              cweId?: string;
              code: string;
            }>;
            linesScanned: number;
          };
          scanDirectory: (
            dirPath: string,
            options?: {
              exclude?: string[];
              maxFileSize?: number;
              languages?: string[];
            }
          ) => Array<{
            filePath: string;
            language: string;
            findings: Array<{
              line: number;
              column: number;
              type: string;
              severity: "critical" | "high" | "medium" | "low" | "info";
              description: string;
              recommendation?: string;
              cweId?: string;
              code: string;
            }>;
            linesScanned: number;
          }>;
          lastScanStats: { filesScanned: number; filesWithFindings: number };
        };
      };

      const scanner = new CodeScanner();
      const target = path.resolve(pathArg);

      if (!fs.existsSync(target)) {
        console.error(chalk.red(`  ✗ Path not found: ${target}`));
        process.exit(1);
      }

      const minSeverity = SEVERITY_ORDER[opts.severity ?? "low"] ?? SEVERITY_ORDER.low!;
      const exclude = opts.exclude ? opts.exclude.split(",").map((s) => s.trim()) : undefined;
      const maxFileSize = Number.parseInt(opts.maxFileSize ?? "1000000", 10);
      const languages = opts.language
        ? opts.language.split(",").map((s) => s.trim())
        : undefined;

      const stat = fs.statSync(target);
      const results = stat.isDirectory()
        ? scanner.scanDirectory(target, { exclude, maxFileSize, languages })
        : [scanner.scanFile(target)];

      // `scanDirectory` returns ONLY files that HAVE findings, so `results.length`
      // is NOT the number of files scanned — report the scanner's true count
      // (single-file path scans exactly one file).
      const filesScanned = stat.isDirectory() ? scanner.lastScanStats.filesScanned : 1;

      // Flatten + filter by severity, attach absolute file paths
      const findings: CodeFindingJson[] = [];
      for (const r of results) {
        for (const f of r.findings) {
          if ((SEVERITY_ORDER[f.severity] ?? 99) > minSeverity) continue;
          findings.push({
            file: path.relative(process.cwd(), r.filePath),
            line: f.line,
            column: f.column,
            type: f.type,
            severity: f.severity,
            description: f.description,
            recommendation: f.recommendation,
            cweId: f.cweId,
            code: f.code,
          });
        }
      }

      // The CI gate. Computed ONCE here so every output path applies it — the
      // `--format json` / `--format sarif` stdout branches used to `return`
      // with exit 0, so `npx @evalguard/cli code-scan --format sarif > eg.sarif`
      // reported success while the SARIF it just wrote contained a hardcoded
      // API key. A machine-readable format must not silently weaken the gate.
      const blockingCount = findings.filter(
        (f) => f.severity === "critical" || f.severity === "high"
      ).length;

      // JSON file output (CI consumption)
      if (opts.output) {
        const outPath = path.resolve(opts.output);
        const cwd = process.cwd();
        // Containment: outPath must be cwd itself or BELOW it. A bare
        // startsWith(cwd) is escapable — "/home/u/proj-evil" startsWith
        // "/home/u/proj" — so require the path separator boundary.
        if (outPath !== cwd && !outPath.startsWith(cwd + path.sep)) {
          console.error(chalk.red(`  ✗ Output path must be within current directory (got ${outPath})`));
          process.exit(1);
        }
        fs.writeFileSync(
          outPath,
          opts.format === "sarif"
            ? toSarif(findings)
            : JSON.stringify(
                {
                  version: "1",
                  generatedAt: new Date().toISOString(),
                  target: path.relative(cwd, target),
                  filesScanned,
                  findingsCount: findings.length,
                  severityCounts: {
                    critical: findings.filter((f) => f.severity === "critical").length,
                    high: findings.filter((f) => f.severity === "high").length,
                    medium: findings.filter((f) => f.severity === "medium").length,
                    low: findings.filter((f) => f.severity === "low").length,
                    info: findings.filter((f) => f.severity === "info").length,
                  },
                  findings,
                },
                null,
                2
              )
        );
        console.log(`  ${chalk.green("✓")} Wrote ${findings.length} finding(s) to ${chalk.cyan(opts.output)}`);
        // Exit 1 if any critical/high — lets CI gate on this
        if (blockingCount > 0) process.exit(1);
        return;
      }

      // SARIF stdout (GitHub Code Scanning)
      if (opts.format === "sarif") {
        console.log(toSarif(findings));
        if (blockingCount > 0) process.exit(1);
        return;
      }

      // JSON stdout
      if (opts.format === "json") {
        console.log(JSON.stringify({ findings }, null, 2));
        if (blockingCount > 0) process.exit(1);
        return;
      }

      // Text output
      console.log();
      console.log(chalk.bold("  EvalGuard Code Security Scan"));
      console.log(chalk.dim("  " + "-".repeat(70)));

      if (findings.length === 0) {
        console.log(chalk.green("  ✓ No vulnerabilities found"));
        console.log(chalk.dim(`    Scanned ${filesScanned} file(s)`));
        return;
      }

      const byFile = new Map<string, CodeFindingJson[]>();
      for (const f of findings) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file)!.push(f);
      }

      let totalCritical = 0;
      let totalHigh = 0;

      for (const [file, fileFindings] of byFile) {
        const critical = fileFindings.filter((f) => f.severity === "critical").length;
        const high = fileFindings.filter((f) => f.severity === "high").length;
        totalCritical += critical;
        totalHigh += high;

        const icon = critical > 0 ? chalk.red("!!!") : high > 0 ? chalk.yellow("!!") : chalk.dim("--");
        console.log();
        console.log(`  ${icon} ${chalk.bold(file)}`);

        const sorted = [...fileFindings].sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        );

        for (const f of sorted) {
          const sevColor =
            f.severity === "critical" ? chalk.red.bold :
            f.severity === "high" ? chalk.red :
            f.severity === "medium" ? chalk.yellow :
            chalk.dim;
          console.log(
            `      ${sevColor(f.severity.toUpperCase().padEnd(8))} L${f.line}:${f.column} ${chalk.bold(f.type)}`
          );
          console.log(chalk.dim(`               ${f.description}`));
          if (f.recommendation) {
            console.log(chalk.dim(`               → ${f.recommendation}`));
          }
        }
      }

      console.log();
      console.log(chalk.dim("  " + "-".repeat(70)));
      console.log(
        `  Scanned ${chalk.bold(String(filesScanned))} file(s), found ${chalk.bold(String(findings.length))} finding(s) ` +
        `in ${chalk.bold(String(byFile.size))} file(s) ` +
        `(${chalk.red.bold(totalCritical)} critical, ${chalk.red(totalHigh)} high)`
      );

      if (totalCritical > 0 || totalHigh > 0) process.exit(1);
    });
}
