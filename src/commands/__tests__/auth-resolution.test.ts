/**
 * Regression guard for `cli-auth-env-only-ignores-login-config`.
 *
 * ~31 authenticated commands used to read the API key from
 * `process.env.EVALGUARD_API_KEY` ONLY and hardcode the base URL, so a user who
 * followed the documented `evalguard login` flow (which writes the credential +
 * URL to `~/.evalguard/config.json`) got "EVALGUARD_API_KEY is not set" on those
 * subcommands. The fix routes every authenticated command through
 * `resolveApiKey()` / `resolveBaseUrl()` from `lib/config`, which reads the env
 * var first (override) and then the login config.
 *
 * The resolver *behavior* (env > config file > default, with normalization) is
 * covered by `lib/__tests__/config.test.ts`. These tests assert, at the source
 * level, that the commands actually USE the resolvers and can never silently
 * regress back to env-only auth.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// This test lives in apps/cli/src/commands/__tests__ — the command sources are
// one directory up.
const COMMANDS_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Every non-test command source file. */
function commandSources(): Array<{ file: string; src: string }> {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((file) => ({
      file,
      src: fs.readFileSync(path.join(COMMANDS_DIR, file), "utf-8"),
    }));
}

/**
 * The commands remediated by this fix. Each must resolve auth through
 * `lib/config` rather than reading the env var directly. `setup` only embeds
 * the resolved key into generated agent configs (no API call), so it uses
 * `resolveApiKey` alone; every other command also resolves the base URL.
 */
const FIXED_COMMANDS = [
  // Category A — two-function (baseUrl()/apiKey()) pattern
  "datasets", "agent-runs", "cost-export", "fine-tune", "ai-bom",
  "governance-risk", "consensus", "incident-rca", "issue-sync", "vuln-lookup",
  "scorecard", "sbom-monitor", "vuln-waiver", "shadow-ai", "rag",
  "clickhouse", "firewall-fairness-report", "rag-automl", "grpc",
  // Category B — getConfig() returning { baseUrl, apiKey }
  "moderation", "voice", "agent-tools", "agent-memory", "evaluators",
  "guardrail-shadow", "data-boundary", "regression-trigger", "abuse-report",
  // Category C — previously read config inline; now normalized via resolvers
  "setup", "share", "retry", "debug",
] as const;

const KEY_ONLY = new Set(["setup"]);

describe("CLI auth resolution (cli-auth-env-only-ignores-login-config)", () => {
  it("no command source reads the API key from process.env.EVALGUARD_API_KEY", () => {
    // Reading `process.env.EVALGUARD_API_KEY` directly is the env-only bug: it
    // ignores the credential written by `evalguard login`. The env override is
    // handled centrally inside `resolveApiKey()` (lib/config), so no command
    // should reference the env var by name.
    const offenders = commandSources()
      .filter(({ src }) => src.includes("process.env.EVALGUARD_API_KEY"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no command hardcodes the env-only base URL fallback", () => {
    // The `process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1"`
    // shape skips `resolveBaseUrl()`'s config lookup + /api/v1 normalization.
    const offenders = commandSources()
      .filter(({ src }) =>
        src.includes('process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1"'),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it.each(FIXED_COMMANDS)(
    "%s.ts resolves auth via lib/config, not env-only",
    (name) => {
      const src = fs.readFileSync(path.join(COMMANDS_DIR, `${name}.ts`), "utf-8");
      expect(src).toContain('from "../lib/config.js"');
      expect(src).toContain("resolveApiKey");
      expect(src).not.toContain("process.env.EVALGUARD_API_KEY");
      if (!KEY_ONLY.has(name)) {
        expect(src).toContain("resolveBaseUrl");
      }
    },
  );

  it("grpc's missing-key error points at `evalguard login`, not `evalguard init`", () => {
    // `evalguard init` scaffolds a project config; it does NOT set an API key,
    // so the old "Run `evalguard init`" hint was a dead end.
    const src = fs.readFileSync(path.join(COMMANDS_DIR, "grpc.ts"), "utf-8");
    expect(src).toContain("Run `evalguard login`");
    expect(src).not.toContain("Run `evalguard init`");
  });
});
