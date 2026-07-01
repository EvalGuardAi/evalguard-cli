/**
 * `evalguard share` — Share eval/scan results via a shareable URL
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { getRun } from "./store.js";

export function registerShare(program: Command): void {
  program
    .command("share")
    .description("Share eval/scan results via a shareable URL")
    .argument("<runId>", "Run ID to share")
    .option("--expires <hours>", "Link expiration in hours (default: 72)", "72")
    .option("--password", "Require a password to view the shared results", false)
    .action(async (runId: string, opts: { expires: string; password: boolean }) => {
      const run = getRun(runId);
      if (!run) {
        console.error(chalk.red(`Run not found: ${runId}`));
        console.log(chalk.dim("  Use `evalguard history` to list available runs."));
        process.exit(1);
      }

      const spinner = ora("Creating share link...").start();

      try {
        // ESM: use node: imports, not require() (live-E2E 2026-06-16: `evalguard
        // share` was DOA with "require is not defined" inside this ESM module).
        const configPath = path.join(os.homedir(), ".evalguard", "config.json");
        const config = fs.existsSync(configPath)
          ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
          : {};

        const baseUrl = process.env.EVALGUARD_BASE_URL ?? config.baseUrl ?? "https://evalguard.ai/api/v1";
        const apiKey = process.env.EVALGUARD_API_KEY ?? config.apiKey;

        if (!apiKey) {
          spinner.fail("Not authenticated. Run `evalguard login` first.");
          process.exit(1);
        }

        const expiresHours = parseInt(opts.expires, 10);
        if (isNaN(expiresHours) || expiresHours < 1) {
          spinner.fail("Invalid --expires value. Must be a positive integer.");
          process.exit(1);
        }

        const res = await fetch(`${baseUrl}/shares`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            runId: run.id,
            runData: run,
            expiresInHours: expiresHours,
            passwordProtected: opts.password,
          }),
        });

        const data = (await res.json().catch(() => ({ message: res.statusText }))) as Record<string, unknown>;

        if (!res.ok) {
          throw new Error(`API error ${res.status}: ${data.message ?? "Unknown error"}`);
        }

        const shareData = (data.data ?? data) as Record<string, unknown>;
        const shareUrl = shareData.url as string;
        const sharePassword = shareData.password as string | undefined;

        spinner.succeed("Share link created");
        console.log();
        console.log(`  ${chalk.bold("URL:")}      ${chalk.cyan(shareUrl)}`);
        console.log(`  ${chalk.bold("Expires:")}  ${expiresHours} hours`);
        if (sharePassword) {
          console.log(`  ${chalk.bold("Password:")} ${chalk.yellow(sharePassword)}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(`Failed to create share link: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
