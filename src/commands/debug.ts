/**
 * `evalguard debug` — Debug provider/scorer configuration and connectivity
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".evalguard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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
      console.log();
      console.log(chalk.bold("  EvalGuard Debug Info"));
      console.log(chalk.dim("  " + "-".repeat(60)));

      // 1. CLI Config
      console.log();
      console.log(chalk.bold("  Configuration"));
      if (fs.existsSync(CONFIG_FILE)) {
        try {
          const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, string>;
          const apiKey = config.apiKey;
          if (apiKey) {
            const masked = apiKey.substring(0, 7) + "..." + apiKey.substring(apiKey.length - 4);
            console.log(`  ${chalk.green("✓")} API Key:   ${chalk.dim(masked)}`);
          } else {
            console.log(`  ${chalk.yellow("!")} API Key:   ${chalk.dim("not set")}`);
          }
          console.log(`  ${chalk.dim("  Base URL:")} ${config.baseUrl ?? "https://evalguard.ai/api/v1"}`);
          if (config.projectId) {
            console.log(`  ${chalk.dim("  Project:")}  ${config.projectId}`);
          }
        } catch {
          console.log(`  ${chalk.red("✗")} Config file exists but is corrupt: ${CONFIG_FILE}`);
        }
      } else {
        console.log(`  ${chalk.yellow("!")} No config file found at ${chalk.dim(CONFIG_FILE)}`);
        console.log(chalk.dim("    Run `evalguard login` to authenticate."));
      }

      // 2. EvalGuard env vars
      console.log();
      console.log(chalk.bold("  Environment Variables"));
      const evalguardEnv = ["EVALGUARD_API_KEY", "EVALGUARD_BASE_URL", "EVALGUARD_PROJECT_ID"];
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
        let config: Record<string, string> = {};
        if (fs.existsSync(CONFIG_FILE)) {
          config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
        }
        const baseUrl = process.env.EVALGUARD_BASE_URL ?? config.baseUrl ?? "https://evalguard.ai/api/v1";
        const apiKey = process.env.EVALGUARD_API_KEY ?? config.apiKey;

        if (!apiKey) {
          console.log(`  ${chalk.yellow("!")} Skipped — no API key configured`);
        } else {
          // The health endpoint lives at `/api/health`, NOT under the versioned
          // API root. Probing `${baseUrl}/health` (= `/api/v1/health`) always
          // 404'd; strip the `/api/v1` suffix for the health check.
          const healthUrl = `${baseUrl.replace(/\/api\/v1\/?$/, "")}/api/health`;
          const start = Date.now();
          const res = await fetch(healthUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000),
          });
          const latency = Date.now() - start;

          if (res.ok) {
            console.log(`  ${chalk.green("✓")} ${healthUrl} ${chalk.dim(`(${latency}ms)`)}`);
          } else {
            console.log(`  ${chalk.red("✗")} ${healthUrl} — HTTP ${res.status} ${chalk.dim(`(${latency}ms)`)}`);
          }
        }
      } catch (err) {
        console.log(`  ${chalk.red("✗")} Connection failed: ${err instanceof Error ? err.message : String(err)}`);
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
    });
}
