/**
 * `evalguard delete` — Delete eval/scan runs from local storage
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

const DB_DIR = path.join(os.homedir(), ".evalguard");
const DB_FILE = path.join(DB_DIR, "results.json");

interface StoredRun {
  id: string;
  name: string;
  type: string;
  timestamp: string;
}

function loadDb(): StoredRun[] {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDb(runs: StoredRun[]): void {
  fs.writeFileSync(DB_FILE, JSON.stringify(runs, null, 2), { mode: 0o600 });
}

function askConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export function registerDelete(program: Command): void {
  program
    .command("delete [runId]")
    .description("Delete eval/scan runs from local storage")
    .option("--all", "Delete all stored runs", false)
    .option("--before <date>", "Delete runs before this date (ISO format)")
    .option("--confirm", "Skip confirmation prompt", false)
    .option("--dry-run", "Preview which runs would be deleted without modifying anything", false)
    .action(async (runId: string | undefined, opts: { all: boolean; before?: string; confirm: boolean; dryRun?: boolean }) => {
      const runs = loadDb();

      if (runs.length === 0) {
        console.log(chalk.dim("\n  No runs stored. Nothing to delete.\n"));
        return;
      }

      let toDelete: StoredRun[] = [];
      let toKeep: StoredRun[] = [];

      if (opts.all) {
        toDelete = runs;
        toKeep = [];
      } else if (opts.before) {
        const beforeDate = new Date(opts.before);
        if (isNaN(beforeDate.getTime())) {
          console.error(chalk.red("Invalid date format. Use ISO format (e.g., 2024-01-15)."));
          process.exit(1);
        }
        for (const run of runs) {
          if (new Date(run.timestamp) < beforeDate) {
            toDelete.push(run);
          } else {
            toKeep.push(run);
          }
        }
      } else if (runId) {
        const found = runs.find((r) => r.id === runId);
        if (!found) {
          console.error(chalk.red(`Run not found: ${runId}`));
          console.log(chalk.dim("  Use `evalguard history` to list available runs."));
          process.exit(1);
        }
        toDelete = [found];
        toKeep = runs.filter((r) => r.id !== runId);
      } else {
        console.error(chalk.red("Specify a run ID, --all, or --before <date>."));
        process.exit(1);
      }

      if (toDelete.length === 0) {
        console.log(chalk.dim("\n  No matching runs found.\n"));
        return;
      }

      // Show what will be deleted
      console.log();
      const header = opts.dryRun
        ? chalk.bold(`  [dry-run] ${toDelete.length} run(s) WOULD be deleted:`)
        : chalk.bold(`  ${toDelete.length} run(s) to delete:`);
      console.log(header);
      for (const run of toDelete.slice(0, 10)) {
        console.log(chalk.dim(`    ${run.id} — ${run.name} (${run.timestamp})`));
      }
      if (toDelete.length > 10) {
        console.log(chalk.dim(`    ... and ${toDelete.length - 10} more`));
      }
      console.log();

      // E2 (2026-05-19): --dry-run short-circuits BEFORE both the
      // confirmation prompt and the disk write. We never mutate state
      // in dry-run mode — safe to pipe into scripts and to use as a
      // pre-flight check from CI.
      if (opts.dryRun) {
        console.log(chalk.dim(`  [dry-run] No changes written. ${toKeep.length} run(s) would remain.`));
        console.log();
        return;
      }

      // Confirm
      if (!opts.confirm) {
        const confirmed = await askConfirmation(
          chalk.yellow(`  Delete ${toDelete.length} run(s)? This cannot be undone. [y/N] `)
        );
        if (!confirmed) {
          console.log(chalk.dim("  Cancelled."));
          return;
        }
      }

      saveDb(toKeep);
      console.log(chalk.green("✓") + ` Deleted ${toDelete.length} run(s). ${toKeep.length} remaining.`);
      console.log();
    });
}
