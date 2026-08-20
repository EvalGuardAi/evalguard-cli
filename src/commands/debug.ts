/**
 * `evalguard debug` — Debug provider/scorer configuration and connectivity
 */
import { Command } from "commander";
import chalk from "chalk";
import {
  DEFAULT_BASE_URL,
  activeProfileName,
  configFilePath,
  describeProtection,
  getProfile,
  listProfileNames,
  loadConfigFile,
  profileSecretProtection,
  resolveApiKey,
  resolveBaseUrl,
} from "../lib/config.js";
import * as fs from "fs";
import * as path from "path";
import { boundedFetch, decodeJsonBody, describeShape, expectField } from "../lib/http.js";

// Read THROUGH lib/config, not by re-parsing the file here. This command used
// to JSON.parse ~/.evalguard/config.json and read a top-level `apiKey`, which
// after named profiles landed would have reported the compatibility mirror
// rather than the profile actually in effect — `debug` is the command people
// run precisely when the two disagree.
const CONFIG_DIR = path.dirname(configFilePath());
const CONFIG_FILE = configFilePath();

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_AI_API_KEY", "GOOGLE_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  cohere: ["COHERE_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  replicate: ["REPLICATE_API_TOKEN"],
};

export function registerDebug(program: Command): void {
  program
    .command("debug")
    .description("Debug provider/scorer configuration and API connectivity")
    .option("-p, --provider <name>", "Test a specific provider connection")
    .option("-v, --verbose", "Show detailed output including env var values (masked)", false)
    .action(async (opts: { provider?: string; verbose: boolean }) => {
      // AUDIT 2026-08-09 (cli-debug-auth-failure-exits-0). This command ran a
      // real authenticated probe of the API, printed
      //
      //   ✗ https://…/api/health — HTTP 401 (36ms)          EXIT 0
      //
      // and returned success: the file carried NO process.exit / process.exitCode
      // site at all. `evalguard debug` is the documented connectivity/auth
      // preflight, so a CI step that runs it as a gate read a REJECTED CREDENTIAL
      // as a healthy environment.
      //
      // The rule now is mechanical and matches what the operator sees: every red
      // `✗` line is a hard failure and exits 1. Yellow `!` lines stay advisory and
      // exit 0 — "no API key configured" / "no config file" are legitimate states
      // for a fresh checkout, and failing them would break `evalguard debug` as a
      // pre-login diagnostic. `hardFailures` is only ever incremented next to a
      // `✗`, so the two cannot drift apart.
      let hardFailures = 0;
      const fail = (line: string): void => {
        hardFailures++;
        console.log(line);
      };

      console.log();
      console.log(chalk.bold("  EvalGuard Debug Info"));
      console.log(chalk.dim("  " + "-".repeat(60)));

      // 1. CLI Config
      console.log();
      console.log(chalk.bold("  Configuration"));
      if (fs.existsSync(CONFIG_FILE)) {
        try {
          const file = loadConfigFile(CONFIG_FILE);
          const profileName = activeProfileName(file);
          const config = getProfile(profileName, file);
          const names = listProfileNames(file);
          console.log(
            `  ${chalk.dim("  Profile:")}  ${chalk.cyan(profileName)}` +
              (names.length > 1 ? chalk.dim(`   (of ${names.join(", ")})`) : ""),
          );
          // resolveApiKey(), NOT config.apiKey: since profile secrets are held
          // at rest as `apiKeyEnc` (DPAPI / Keychain / libsecret), the raw
          // `apiKey` field is absent for every protected profile. Reading it
          // directly made `evalguard debug` — the command people run precisely
          // when auth is misbehaving — report "API Key: not set" for a profile
          // that was working perfectly.
          const apiKey = resolveApiKey(config);
          if (apiKey) {
            const masked = apiKey.substring(0, 7) + "..." + apiKey.substring(apiKey.length - 4);
            const protection = profileSecretProtection(config);
            const note =
              protection === "plaintext"
                ? chalk.yellow(`  (${describeProtection(protection)})`)
                : chalk.dim(`  (${describeProtection(protection)})`);
            console.log(`  ${chalk.green("✓")} API Key:   ${chalk.dim(masked)}${note}`);
          } else {
            console.log(`  ${chalk.yellow("!")} API Key:   ${chalk.dim("not set")}`);
          }
          console.log(`  ${chalk.dim("  Base URL:")} ${config.baseUrl ?? DEFAULT_BASE_URL}`);
          if (config.projectId) {
            console.log(`  ${chalk.dim("  Project:")}  ${config.projectId}`);
          }
        } catch {
          fail(`  ${chalk.red("✗")} Config file exists but is corrupt: ${CONFIG_FILE}`);
        }
      } else {
        console.log(`  ${chalk.yellow("!")} No config file found at ${chalk.dim(CONFIG_FILE)}`);
        console.log(chalk.dim("    Run `evalguard login` to authenticate."));
      }

      // 2. EvalGuard env vars
      console.log();
      console.log(chalk.bold("  Environment Variables"));
      const evalguardEnv = [
        "EVALGUARD_PROFILE",
        "EVALGUARD_API_KEY",
        "EVALGUARD_BASE_URL",
        "EVALGUARD_PROJECT_ID",
        "EVALGUARD_CONFIG_FILE",
      ];
      for (const key of evalguardEnv) {
        const val = process.env[key];
        if (val) {
          const masked = opts.verbose ? val.substring(0, 7) + "..." + val.substring(val.length - 4) : "(set)";
          console.log(`  ${chalk.green("✓")} ${key} = ${chalk.dim(masked)}`);
        } else {
          console.log(`  ${chalk.dim("-")} ${key} ${chalk.dim("not set")}`);
        }
      }

      // 3. Provider env vars
      console.log();
      console.log(chalk.bold("  Provider API Keys"));
      const providersToCheck = opts.provider
        ? { [opts.provider]: PROVIDER_ENV_VARS[opts.provider] ?? [`${opts.provider.toUpperCase()}_API_KEY`] }
        : PROVIDER_ENV_VARS;

      for (const [provider, envVars] of Object.entries(providersToCheck)) {
        const found = envVars.filter((v) => process.env[v]);
        if (found.length > 0) {
          console.log(`  ${chalk.green("✓")} ${provider.padEnd(12)} ${chalk.dim(found.join(", "))}`);
        } else {
          console.log(`  ${chalk.dim("-")} ${provider.padEnd(12)} ${chalk.dim(envVars.join(", ") + " not set")}`);
        }
      }

      // 4. API connectivity test
      console.log();
      console.log(chalk.bold("  API Connectivity"));
      try {
        const baseUrl = resolveBaseUrl();
        const apiKey = resolveApiKey();

        if (!apiKey) {
          console.log(`  ${chalk.yellow("!")} Skipped — no API key configured`);
        } else {
          // The health endpoint lives at `/api/health`, NOT under the versioned
          // API root. Probing `${baseUrl}/health` (= `/api/v1/health`) always
          // 404'd; strip the `/api/v1` suffix for the health check.
          const healthUrl = `${baseUrl.replace(/\/api\/v1\/?$/, "")}/api/health`;
          const start = Date.now();
          const res = await boundedFetch(healthUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000),
          });
          const latency = Date.now() - start;

          if (res.ok) {
            // AUDIT 2026-08-09 (cli-debug-status-only-health-check).
            //
            // `if (res.ok)` alone made this a STATUS-CODE check wearing the
            // clothes of a health check. Measured on the built CLI against a
            // stub answering HTTP 200, `evalguard debug` printed
            //
            //     ✓ http://127.0.0.1:8870/api/health (41ms)
            //
            // for ALL of: `this is not JSON at all {{{`, an empty body, a 204,
            // `null`, `"ok"`, `{"hello":"world"}`, `{"success":true,"data":null}`,
            // `{"success":true,"data":{}}`, an explicit `{"success":false,…}`,
            // an nginx 502 page served as 200, and 2 MB of filler — 11 of 14
            // fault modes, and the worst row in the whole matrix. This is the
            // command a customer runs to ask "is this working?", and a 200 from
            // a captive portal, a stale CDN edge or a misrouted proxy answered
            // yes on behalf of a backend that was never reached.
            //
            // A health check must read the health ANSWER. The route
            // (apps/web/src/app/api/health/route.ts:274) always sends
            // `{ status: "ok" | "degraded" | "error", … }`, and `degraded` is a
            // real, distinct state that must not be flattened into either ✓ or
            // ✗ — a degraded backend is exactly what someone runs `debug` to
            // discover.
            let status: string | null = null;
            let detail = "";
            try {
              const body = await decodeJsonBody(res, "GET /api/health");
              const raw = expectField(body, "status", "GET /api/health");
              if (typeof raw === "string") status = raw;
              else detail = `its \`status\` is ${describeShape(raw)}, not a string`;
            } catch (e) {
              detail = e instanceof Error ? e.message : String(e);
            }

            if (status === "ok") {
              console.log(`  ${chalk.green("✓")} ${healthUrl} ${chalk.dim(`(${latency}ms)`)}`);
            } else if (status === "degraded") {
              // Advisory, not a hard failure: the app is up and serving, some
              // dependency is slow. Yellow `!` keeps exit 0 like the other
              // advisories, so `debug` stays usable as a preflight.
              console.log(
                `  ${chalk.yellow("!")} ${healthUrl} — reports ${chalk.yellow("degraded")} ` +
                  chalk.dim(`(${latency}ms)`),
              );
              console.log(chalk.dim("    The API is up but at least one dependency is unhealthy."));
            } else if (status !== null) {
              fail(
                `  ${chalk.red("✗")} ${healthUrl} — reports ${chalk.red(status)} ` +
                  chalk.dim(`(${latency}ms)`),
              );
            } else {
              fail(
                `  ${chalk.red("✗")} ${healthUrl} — answered HTTP ${res.status} but the body is ` +
                  `not this endpoint's health report ` + chalk.dim(`(${latency}ms)`),
              );
              console.log(chalk.dim(`    ${detail}`));
              console.log(
                chalk.dim(
                  "    A 200 from a proxy, captive portal or cached edge looks identical to a " +
                    "healthy API until the body is read.",
                ),
              );
            }
          } else {
            fail(`  ${chalk.red("✗")} ${healthUrl} — HTTP ${res.status} ${chalk.dim(`(${latency}ms)`)}`);
            if (res.status === 401 || res.status === 403) {
              console.log(
                chalk.dim("    The server REJECTED this API key. Run `evalguard login --key <key>`."),
              );
            }
          }
        }
      } catch (err) {
        fail(`  ${chalk.red("✗")} Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 5. Local storage info
      console.log();
      console.log(chalk.bold("  Local Storage"));
      const dbFile = path.join(CONFIG_DIR, "results.json");
      if (fs.existsSync(dbFile)) {
        const stat = fs.statSync(dbFile);
        try {
          const runs = JSON.parse(fs.readFileSync(dbFile, "utf-8")) as unknown[];
          console.log(`  ${chalk.green("✓")} ${runs.length} runs stored (${(stat.size / 1024).toFixed(1)} KB)`);
        } catch {
          console.log(`  ${chalk.yellow("!")} Storage file exists but is corrupt`);
        }
      } else {
        console.log(`  ${chalk.dim("-")} No local runs stored yet`);
      }

      // 6. Node/platform info
      console.log();
      console.log(chalk.bold("  Runtime"));
      console.log(`  ${chalk.dim("Node:")}     ${process.version}`);
      console.log(`  ${chalk.dim("Platform:")} ${process.platform} ${process.arch}`);
      console.log(`  ${chalk.dim("CWD:")}      ${process.cwd()}`);

      // Check for evalguard config files in CWD
      const configFiles = ["evalguard.yaml", "evalguard.yml", "evalguard.config.json"];
      const foundConfigs = configFiles.filter((f) => fs.existsSync(path.join(process.cwd(), f)));
      if (foundConfigs.length > 0) {
        console.log(`  ${chalk.green("✓")} Config:   ${foundConfigs.join(", ")}`);
      } else {
        console.log(`  ${chalk.dim("-")} No evalguard config in CWD`);
      }

      console.log();
      if (hardFailures > 0) {
        console.log(
          chalk.red(
            `  ${hardFailures} check(s) FAILED — see the ✗ line(s) above.`,
          ),
        );
        console.log();
        // process.exitCode, not process.exit(): the health probe's undici
        // keep-alive sockets are still in teardown here, and process.exit()
        // mid-teardown trips the libuv `!(handle->flags & UV_HANDLE_CLOSING)`
        // abort on Windows Node — which replaces the intended 1 with a 127 and
        // an assertion dump. Same guard as reportFatal / lib/poll.ts failExit.
        process.exitCode = 1;
      }
    });
}
