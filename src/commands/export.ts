/**
 * `evalguard export` — Export eval/scan results in multiple formats
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import { getRun, StoredRun } from "./store.js";

function toCSV(run: StoredRun): string {
  const header = "id,type,name,model,provider,timestamp,passRate,score,maxScore,passed,failed,total,latencyMs";
  const row = [
    run.id, run.type, `"${run.name}"`, run.model, run.provider, run.timestamp,
    run.passRate, run.score, run.maxScore, run.passed, run.failed, run.total, run.latencyMs,
  ].join(",");

  const lines = [header, row];

  if (run.results && run.results.length > 0) {
    lines.push("");
    lines.push("# Case Results");
    const caseHeader = Object.keys(run.results[0]).join(",");
    lines.push(caseHeader);
    for (const r of run.results) {
      lines.push(Object.values(r).map((v) => typeof v === "string" ? `"${v}"` : String(v)).join(","));
    }
  }

  return lines.join("\n");
}

function toSARIF(run: StoredRun): string {
  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "evalguard",
            informationUri: "https://evalguard.ai",
            rules: [],
          },
        },
        results: (run.results ?? []).map((r: Record<string, unknown>, i: number) => ({
          ruleId: `case-${i + 1}`,
          level: r.passed ? "note" : "error",
          message: { text: r.reason ?? (r.passed ? "Passed" : "Failed") },
          properties: r,
        })),
        invocations: [
          {
            executionSuccessful: run.passRate >= 0.5,
            properties: {
              model: run.model,
              provider: run.provider,
              passRate: run.passRate,
              score: run.score,
              maxScore: run.maxScore,
            },
          },
        ],
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

function toHTML(run: StoredRun): string {
  const statusColor = run.passRate >= 0.8 ? "#22c55e" : run.passRate >= 0.5 ? "#eab308" : "#ef4444";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>EvalGuard Report - ${run.name}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #0a0a0a; color: #e5e5e5; }
    h1 { color: #fff; } h2 { color: #a3a3a3; margin-top: 32px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: 600; color: #fff; background: ${statusColor}; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #262626; }
    th { color: #a3a3a3; font-size: 0.85em; text-transform: uppercase; }
    .pass { color: #22c55e; } .fail { color: #ef4444; }
    .meta { color: #737373; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>EvalGuard Report</h1>
  <h2>${run.name} <span class="badge">${(run.passRate * 100).toFixed(1)}%</span></h2>
  <p class="meta">ID: ${run.id} | Model: ${run.model} | Provider: ${run.provider} | ${run.timestamp}</p>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Pass Rate</td><td>${(run.passRate * 100).toFixed(1)}%</td></tr>
    <tr><td>Score</td><td>${run.score} / ${run.maxScore}</td></tr>
    <tr><td>Passed</td><td class="pass">${run.passed}</td></tr>
    <tr><td>Failed</td><td class="fail">${run.failed}</td></tr>
    <tr><td>Total</td><td>${run.total}</td></tr>
    <tr><td>Latency</td><td>${run.latencyMs}ms</td></tr>
  </table>
  ${run.results ? `<h2>Case Results</h2><table><tr>${Object.keys(run.results[0] ?? {}).map((k) => `<th>${k}</th>`).join("")}</tr>${run.results.map((r: Record<string, unknown>) => `<tr>${Object.values(r).map((v) => `<td>${String(v)}</td>`).join("")}</tr>`).join("")}</table>` : ""}
</body>
</html>`;
}

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export eval/scan results in CSV, JSON, SARIF, or HTML format")
    .argument("<runId>", "Run ID to export")
    .requiredOption("-f, --format <format>", "Output format: csv, json, sarif, html")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .action((runId: string, opts: { format: string; output?: string }) => {
      const run = getRun(runId);
      if (!run) {
        console.error(chalk.red(`Run not found: ${runId}`));
        console.log(chalk.dim("  Use `evalguard history` to list available runs."));
        process.exit(1);
      }

      const format = opts.format.toLowerCase();
      let content: string;

      switch (format) {
        case "csv":
          content = toCSV(run);
          break;
        case "json":
          content = JSON.stringify(run, null, 2);
          break;
        case "sarif":
          content = toSARIF(run);
          break;
        case "html":
          content = toHTML(run);
          break;
        default:
          console.error(chalk.red(`Unknown format: ${format}. Use csv, json, sarif, or html.`));
          process.exit(1);
      }

      if (opts.output) {
        fs.writeFileSync(opts.output, content, "utf-8");
        console.log(chalk.green("✓") + ` Exported to ${chalk.cyan(opts.output)} (${format})`);
      } else {
        process.stdout.write(content + "\n");
      }
    });
}
