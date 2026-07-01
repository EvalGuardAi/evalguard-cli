/**
 * `evalguard logs` — View recent eval/scan run logs
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const LOG_DIR = path.join(os.homedir(), ".evalguard", "logs");

function getLogFiles(type?: string): string[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));
  if (type) {
    return files.filter((f) => f.startsWith(type));
  }
  return files;
}

function tailFile(filePath: string, lines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines);
}

function formatLogLine(line: string): string {
  if (!line.trim()) return "";
  // Colorize log levels
  if (line.includes("[ERROR]") || line.includes("[FAIL]")) {
    return chalk.red(line);
  }
  if (line.includes("[WARN]")) {
    return chalk.yellow(line);
  }
  if (line.includes("[PASS]") || line.includes("[OK]")) {
    return chalk.green(line);
  }
  if (line.includes("[INFO]")) {
    return chalk.dim(line);
  }
  return line;
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("View recent eval/scan run logs")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Follow log output (watch for new lines)", false)
    .option("-t, --type <type>", "Filter by type: eval or scan")
    .option("--list", "List available log files", false)
    .action(async (opts: { lines: string; follow: boolean; type?: string; list: boolean }) => {
      // Ensure log directory exists
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      }

      const logFiles = getLogFiles(opts.type);

      if (opts.list) {
        if (logFiles.length === 0) {
          console.log(chalk.dim("\n  No log files found.\n"));
          return;
        }
        console.log();
        console.log(chalk.bold("  Log Files"));
        console.log(chalk.dim("  " + "-".repeat(60)));
        for (const f of logFiles.sort().reverse()) {
          const stat = fs.statSync(path.join(LOG_DIR, f));
          const size = (stat.size / 1024).toFixed(1);
          const date = stat.mtime.toLocaleString();
          console.log(`  ${chalk.cyan(f.padEnd(40))} ${chalk.dim(`${size} KB`)}  ${chalk.dim(date)}`);
        }
        console.log();
        return;
      }

      // Find the most recent log file
      if (logFiles.length === 0) {
        // Check results.json as a fallback log source
        const resultsFile = path.join(os.homedir(), ".evalguard", "results.json");
        if (fs.existsSync(resultsFile)) {
          try {
            const runs = JSON.parse(fs.readFileSync(resultsFile, "utf-8")) as Array<Record<string, unknown>>;
            const filteredRuns = opts.type
              ? runs.filter((r) => r.type === opts.type)
              : runs;
            const recentRuns = filteredRuns.slice(-parseInt(opts.lines, 10));

            if (recentRuns.length === 0) {
              console.log(chalk.dim("\n  No log entries found.\n"));
              return;
            }

            console.log();
            console.log(chalk.bold("  Recent Run Log"));
            console.log(chalk.dim("  " + "-".repeat(70)));
            for (const run of recentRuns.reverse()) {
              const passRate = run.passRate as number;
              const color = passRate >= 0.8 ? chalk.green : passRate >= 0.5 ? chalk.yellow : chalk.red;
              const icon = passRate >= 0.8 ? chalk.green("PASS") : chalk.red("FAIL");
              console.log(
                `  ${chalk.dim(run.timestamp as string)} [${icon}] ${chalk.bold(String(run.name).slice(0, 30))} ` +
                `${color((passRate * 100).toFixed(0) + "%")} ${chalk.dim(`(${run.model})`)}`
              );
            }
            console.log();
          } catch {
            console.log(chalk.dim("\n  No log entries found.\n"));
          }
        } else {
          console.log(chalk.dim("\n  No log files found. Run an eval or scan first.\n"));
        }
        return;
      }

      const latestFile = logFiles.sort().reverse()[0];
      const logPath = path.join(LOG_DIR, latestFile);
      const numLines = parseInt(opts.lines, 10);

      console.log(chalk.dim(`  Reading ${latestFile}`));
      console.log(chalk.dim("  " + "-".repeat(60)));

      const lines = tailFile(logPath, numLines);
      for (const line of lines) {
        const formatted = formatLogLine(line);
        if (formatted) console.log(`  ${formatted}`);
      }

      if (opts.follow) {
        console.log(chalk.dim("\n  Watching for new log entries... (Ctrl+C to stop)\n"));
        let lastSize = fs.statSync(logPath).size;

        const watcher = setInterval(() => {
          try {
            const stat = fs.statSync(logPath);
            if (stat.size > lastSize) {
              const fd = fs.openSync(logPath, "r");
              const buf = Buffer.alloc(stat.size - lastSize);
              fs.readSync(fd, buf, 0, buf.length, lastSize);
              fs.closeSync(fd);
              const newLines = buf.toString("utf-8").split("\n");
              for (const line of newLines) {
                const formatted = formatLogLine(line);
                if (formatted) console.log(`  ${formatted}`);
              }
              lastSize = stat.size;
            }
          } catch {
            // File may have been rotated
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(watcher);
          console.log(chalk.dim("\n  Stopped watching.\n"));
          process.exit(0);
        });

        // Keep the process alive
        await new Promise(() => {});
      }

      console.log();
    });
}
