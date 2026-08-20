/**
 * `evalguard whoami` — show current authentication status.
 *
 * Resolves the API key + base URL through the SAME env-first precedence chain as
 * every other authenticated command (`resolveApiKey`/`resolveBaseUrl`: env
 * `EVALGUARD_API_KEY`/`EVALGUARD_BASE_URL` > `~/.evalguard/config.json` >
 * default) and prints the NORMALIZED base URL. It also EXITS NON-ZERO when no
 * credential resolves, so it can be used as a guard (`evalguard whoami || exit 1`)
 * in CI. The previous inline implementation read only the config file and exited
 * 0 in BOTH the authed and unauthed branches (audit M1:
 * cli-whoami-env-blind-always-exit-0).
 */
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, maskApiKey, resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { validateApiKey } from "../lib/cloud-client.js";
import { readFileSync } from "node:fs";

/** This CLI's own version, sent as the client-version header by `validateApiKey`. */
function cliVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show current authentication status (verifies the key against the server)")
    .action(async () => {
      const config = loadConfig();
      const apiKey = resolveApiKey(config);
      const baseUrl = resolveBaseUrl(config);

      if (apiKey) {
        // VERIFY, don't assume (audit 2026-08-08: cli-whoami-unverified-checkmark).
        // This printed "✓ Authenticated" and exited 0 for ANY non-empty string in
        // EVALGUARD_API_KEY, against ANY base URL, without ever opening a socket —
        // a fabricated key pointed at a dead endpoint passed. Because the no-key
        // path DOES exit 1, `evalguard whoami || exit 1` reads as a working CI
        // credential guard while proving nothing about the credential.
        const result = await validateApiKey(apiKey, baseUrl, cliVersion());

        // Both failure branches below set process.exitCode and RETURN rather than
        // calling process.exit() (audit 2026-08-09: cli-whoami-auth-failure-exits-127).
        // validateApiKey has just done a real HTTPS round trip, so undici's
        // keep-alive sockets are still tearing down; process.exit() at that moment
        // trips the libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
        // abort on Windows Node. Measured against the live API with a rejected key:
        //
        //   ✗ Not authenticated — the server rejected this API key.
        //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
        //   exit=127
        //
        // 127 is "command not found" to every shell and CI runner, so the one signal
        // `evalguard whoami || exit 1` exists to produce was replaced by a crash.
        // Same guard as reportFatal (index.ts) and lib/poll.ts failExit.
        if (result.status === "invalid") {
          console.log(chalk.red("✗") + " Not authenticated — the server rejected this API key.");
          console.log(chalk.dim(`  API Key: ${maskApiKey(apiKey)}`));
          console.log(chalk.dim(`  Base URL: ${baseUrl}`));
          console.log(chalk.dim(`  Server said: ${result.message}`));
          process.exitCode = 1;
          return;
        }

        if (result.status === "unverified") {
          // Deliberately NOT a checkmark and deliberately non-zero. "I could not
          // reach the server" is not "you are authenticated", and a guard that
          // passes when the check could not run is the fail-open this command
          // just stopped doing. There is no --skip-verify flag: an opt-out on a
          // fail-closed control is the next bypass.
          console.log(chalk.yellow("?") + " Could NOT verify this API key.");
          console.log(chalk.dim(`  API Key: ${maskApiKey(apiKey)}`));
          console.log(chalk.dim(`  Base URL: ${baseUrl}`));
          console.log(chalk.dim(`  Reason: ${result.reason}`));
          process.exitCode = 1;
          return;
        }

        console.log(chalk.green("✓") + " Authenticated " + chalk.dim("(verified against the server)"));
        console.log(chalk.dim(`  API Key: ${maskApiKey(apiKey)}`));
        console.log(chalk.dim(`  Base URL: ${baseUrl}`));
        if (config.projectId) {
          console.log(chalk.dim(`  Project: ${config.projectId}`));
        }
        return;
      }

      console.log(chalk.yellow("Not authenticated."));
      console.log(
        chalk.dim("  Run `evalguard login --key <your-api-key>` or set EVALGUARD_API_KEY."),
      );
      // Fail closed so `evalguard whoami` is usable as a CI credential guard.
      process.exit(1);
    });
}
