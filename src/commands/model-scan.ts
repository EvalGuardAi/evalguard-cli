/**
 * `evalguard model-scan` — Scan model files for backdoors/trojans
 * Checks pickle, PyTorch (.pt/.pth), ONNX, and SafeTensors files
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  type: string;
  message: string;
  offset?: number;
  context?: string;
}

// Dangerous pickle opcodes that can execute arbitrary code
const DANGEROUS_PICKLE_OPS = [
  { bytes: Buffer.from([0x52]), name: "REDUCE", severity: "critical" as const, desc: "Calls arbitrary callable with args" },
  { bytes: Buffer.from([0x81]), name: "NEWOBJ", severity: "high" as const, desc: "Creates new object instance" },
  { bytes: Buffer.from([0x92]), name: "NEWOBJ_EX", severity: "high" as const, desc: "Creates new object with kwargs" },
  { bytes: Buffer.from([0x83]), name: "STACK_GLOBAL", severity: "critical" as const, desc: "Pushes global by name from stack" },
  { bytes: Buffer.from([0x63]), name: "GLOBAL", severity: "critical" as const, desc: "Pushes global variable" },
  { bytes: Buffer.from([0x69]), name: "INST", severity: "critical" as const, desc: "Instantiates class" },
  { bytes: Buffer.from([0x62]), name: "BUILD", severity: "medium" as const, desc: "Calls __setstate__ or updates __dict__" },
];

// Suspicious Python imports commonly used in malicious pickles
const SUSPICIOUS_IMPORTS = [
  { pattern: "os.system", severity: "critical" as const, desc: "System command execution" },
  { pattern: "os.popen", severity: "critical" as const, desc: "Process execution with pipe" },
  { pattern: "subprocess", severity: "critical" as const, desc: "Subprocess execution" },
  { pattern: "builtins.eval", severity: "critical" as const, desc: "Arbitrary code evaluation" },
  { pattern: "builtins.exec", severity: "critical" as const, desc: "Arbitrary code execution" },
  { pattern: "builtins.__import__", severity: "critical" as const, desc: "Dynamic module import" },
  { pattern: "webbrowser", severity: "high" as const, desc: "Browser launch capability" },
  { pattern: "socket", severity: "high" as const, desc: "Network socket access" },
  { pattern: "http.client", severity: "high" as const, desc: "HTTP client (data exfiltration)" },
  { pattern: "urllib", severity: "high" as const, desc: "URL handling (data exfiltration)" },
  { pattern: "ctypes", severity: "high" as const, desc: "C-level memory access" },
  { pattern: "shutil.rmtree", severity: "critical" as const, desc: "Recursive directory deletion" },
  { pattern: "pickle.loads", severity: "medium" as const, desc: "Nested pickle deserialization" },
  { pattern: "marshal.loads", severity: "high" as const, desc: "Marshal deserialization (code objects)" },
  { pattern: "compile", severity: "medium" as const, desc: "Code compilation" },
  { pattern: "codecs.decode", severity: "medium" as const, desc: "Potential obfuscation via codec" },
];

// Obfuscation indicators
const OBFUSCATION_PATTERNS = [
  { pattern: "\\x", severity: "medium" as const, desc: "Hex-escaped bytes (potential obfuscation)" },
  { pattern: "base64", severity: "medium" as const, desc: "Base64 encoding (potential obfuscation)" },
  { pattern: "zlib.decompress", severity: "medium" as const, desc: "Compressed payload (potential obfuscation)" },
  { pattern: "lambda", severity: "low" as const, desc: "Lambda function in model data" },
  { pattern: "exec(", severity: "critical" as const, desc: "Direct exec call in model data" },
  { pattern: "eval(", severity: "critical" as const, desc: "Direct eval call in model data" },
];

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function scanFile(filePath: string): Finding[] {
  const findings: Finding[] = [];
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);

  // Read file (limit to first 50MB for very large models)
  const maxRead = Math.min(stat.size, 50 * 1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(maxRead);
  fs.readSync(fd, buf, 0, maxRead, 0);
  fs.closeSync(fd);

  const content = buf.toString("latin1"); // Binary-safe string

  // Check file type
  if (ext === ".safetensors") {
    findings.push({
      severity: "info",
      type: "format",
      message: "SafeTensors format detected - this is the safest model format (no code execution)",
    });
    // SafeTensors files should not contain executable code
    for (const imp of SUSPICIOUS_IMPORTS) {
      if (content.includes(imp.pattern)) {
        findings.push({
          severity: "critical",
          type: "suspicious_import",
          message: `SafeTensors file contains suspicious string "${imp.pattern}" - ${imp.desc}`,
          offset: content.indexOf(imp.pattern),
        });
      }
    }
    return findings;
  }

  // Pickle/PyTorch scan
  if ([".pkl", ".pickle", ".pt", ".pth", ".bin"].includes(ext)) {
    // Check for pickle magic number
    const hasPickleMagic = buf[0] === 0x80;
    if (hasPickleMagic) {
      findings.push({
        severity: "info",
        type: "format",
        message: `Pickle format v${buf[1]} detected - pickle files can execute arbitrary code on load`,
      });
    }

    // PyTorch files are ZIP archives containing pickles
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    if (isZip) {
      findings.push({
        severity: "info",
        type: "format",
        message: "PyTorch ZIP archive detected - contains pickle data that can execute code on load",
      });
    }

    // Scan for dangerous pickle opcodes
    for (const op of DANGEROUS_PICKLE_OPS) {
      let idx = 0;
      let count = 0;
      while ((idx = buf.indexOf(op.bytes, idx)) !== -1) {
        count++;
        idx += 1;
      }
      if (count > 0) {
        findings.push({
          severity: op.severity,
          type: "pickle_opcode",
          message: `${op.name} opcode found ${count}x - ${op.desc}`,
        });
      }
    }

    // Scan for suspicious imports
    for (const imp of SUSPICIOUS_IMPORTS) {
      const idx = content.indexOf(imp.pattern);
      if (idx !== -1) {
        const contextStart = Math.max(0, idx - 20);
        const contextEnd = Math.min(content.length, idx + imp.pattern.length + 20);
        const context = content.slice(contextStart, contextEnd).replace(/[^\x20-\x7e]/g, ".");
        findings.push({
          severity: imp.severity,
          type: "suspicious_import",
          message: `Found "${imp.pattern}" - ${imp.desc}`,
          offset: idx,
          context,
        });
      }
    }
  }

  // ONNX scan
  if (ext === ".onnx") {
    findings.push({
      severity: "info",
      type: "format",
      message: "ONNX format detected - generally safer than pickle but can contain custom ops",
    });

    // Check for custom operators that could hide malicious code
    if (content.includes("custom_op") || content.includes("CustomOp")) {
      findings.push({
        severity: "medium",
        type: "custom_op",
        message: "Custom operator detected - review for unexpected behavior",
      });
    }
  }

  // Universal obfuscation checks
  for (const ob of OBFUSCATION_PATTERNS) {
    const idx = content.indexOf(ob.pattern);
    if (idx !== -1) {
      findings.push({
        severity: ob.severity,
        type: "obfuscation",
        message: `Found "${ob.pattern}" - ${ob.desc}`,
        offset: idx,
      });
    }
  }

  return findings;
}

function scanDirectory(dirPath: string): Map<string, Finding[]> {
  const results = new Map<string, Finding[]>();
  const scanExtensions = new Set([".pkl", ".pickle", ".pt", ".pth", ".bin", ".onnx", ".safetensors"]);

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (scanExtensions.has(path.extname(entry.name).toLowerCase())) {
        const findings = scanFile(fullPath);
        results.set(fullPath, findings);
      }
    }
  }

  walk(dirPath);
  return results;
}

export function registerModelScan(program: Command): void {
  program
    .command("model-scan")
    .description("Scan model files for backdoors, trojans, and suspicious code")
    .argument("<path>", "Path to model file or directory")
    .option("-f, --format <format>", "Output format: text or json", "text")
    .option("-s, --severity <level>", "Minimum severity to report: critical, high, medium, low, info", "low")
    .action((targetPath: string, opts: { format: string; severity: string }) => {
      const resolved = path.resolve(targetPath);

      if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`Path not found: ${resolved}`));
        process.exit(1);
      }

      const minSeverity = SEVERITY_ORDER[opts.severity] ?? 3;
      const stat = fs.statSync(resolved);
      let allResults: Map<string, Finding[]>;

      if (stat.isDirectory()) {
        allResults = scanDirectory(resolved);
      } else {
        allResults = new Map([[resolved, scanFile(resolved)]]);
      }

      if (allResults.size === 0) {
        console.log(chalk.dim("\n  No scannable model files found (.pkl, .pt, .pth, .onnx, .safetensors)\n"));
        return;
      }

      // Filter by severity
      for (const [file, findings] of allResults) {
        const filtered = findings.filter((f) => SEVERITY_ORDER[f.severity] <= minSeverity);
        allResults.set(file, filtered);
      }

      // JSON output
      if (opts.format === "json") {
        const jsonOutput: Record<string, unknown>[] = [];
        for (const [file, findings] of allResults) {
          jsonOutput.push({
            file,
            findings: findings.map((f) => ({ ...f })),
            hasCritical: findings.some((f) => f.severity === "critical"),
            hasHigh: findings.some((f) => f.severity === "high"),
          });
        }
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Text output
      console.log();
      console.log(chalk.bold("  EvalGuard Model Security Scan"));
      console.log(chalk.dim("  " + "-".repeat(70)));

      let totalCritical = 0;
      let totalHigh = 0;
      let totalFindings = 0;

      for (const [file, findings] of allResults) {
        const relPath = path.relative(process.cwd(), file);
        const critical = findings.filter((f) => f.severity === "critical").length;
        const high = findings.filter((f) => f.severity === "high").length;
        totalCritical += critical;
        totalHigh += high;
        totalFindings += findings.length;

        const fileIcon = critical > 0 ? chalk.red("!!!") : high > 0 ? chalk.yellow("!!") : chalk.green("OK");
        console.log();
        console.log(`  ${fileIcon} ${chalk.bold(relPath)}`);

        if (findings.length === 0) {
          console.log(chalk.dim("      No issues found"));
          continue;
        }

        // Sort findings by severity
        const sorted = [...findings].sort(
          (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        );

        for (const f of sorted) {
          const sevColor =
            f.severity === "critical" ? chalk.red.bold :
            f.severity === "high" ? chalk.red :
            f.severity === "medium" ? chalk.yellow :
            f.severity === "low" ? chalk.dim :
            chalk.dim;
          const sevLabel = sevColor(f.severity.toUpperCase().padEnd(8));
          console.log(`      ${sevLabel} ${f.message}`);
          if (f.context) {
            console.log(chalk.dim(`               context: ...${f.context}...`));
          }
        }
      }

      // Summary
      console.log();
      console.log(chalk.dim("  " + "-".repeat(70)));
      console.log(
        `  Scanned ${chalk.bold(String(allResults.size))} file(s), ` +
        `${chalk.bold(String(totalFindings))} finding(s): ` +
        `${totalCritical > 0 ? chalk.red.bold(`${totalCritical} critical`) : chalk.dim("0 critical")}, ` +
        `${totalHigh > 0 ? chalk.red(`${totalHigh} high`) : chalk.dim("0 high")}`
      );

      if (totalCritical > 0) {
        console.log();
        console.log(chalk.red.bold("  WARNING: Critical findings detected. Do NOT load this model without review."));
        console.log(chalk.dim("  Consider using SafeTensors format instead of pickle-based formats."));
      }

      console.log();

      // Exit code: 1 if critical findings
      if (totalCritical > 0) {
        process.exit(1);
      }
    });
}
