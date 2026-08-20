/**
 * `evalguard profile …` — named connection profiles (contexts).
 *
 * ── Why this exists (audit 2026-08-05, MEDIUM-HIGH) ─────────────────────────
 *
 * `~/.evalguard/config.json` was a single flat `{apiKey, baseUrl, projectId}`
 * and `evalguard login` OVERWROTE it. Every enterprise runs at least two
 * installs — the SaaS and a self-hosted one, or dev/stage/prod — so switching
 * meant re-running `login` (destroying the other credential) or juggling
 * EVALGUARD_API_KEY / EVALGUARD_BASE_URL by hand in every shell. This is the
 * `kubectl config use-context` / `aws --profile` shape those users already
 * expect.
 *
 *   evalguard profile list
 *   evalguard profile current
 *   evalguard profile create <name> [--key …] [--url …] [--project …] [--use]
 *   evalguard profile use <name>            (alias: switch)
 *   evalguard profile delete <name>         (alias: rm)
 *
 * ── Precedence (documented here and in the CLI README) ──────────────────────
 *
 *   profile : EVALGUARD_PROFILE   > config.currentProfile > "default"
 *   apiKey  <- EVALGUARD_API_KEY  > <profile>.apiKeyEnc (decrypted) > <profile>.apiKey
 *   baseUrl : EVALGUARD_BASE_URL  > <profile>.baseUrl      > https://evalguard.ai/api/v1
 *
 * Env vars still win, unchanged. Profiles slot in UNDER them, so every existing
 * CI job that exports EVALGUARD_API_KEY behaves exactly as it did.
 *
 * ── Existing users are not stranded ─────────────────────────────────────────
 *
 * A pre-profiles flat config is adopted as the `default` profile at read time,
 * with no write and no user action (lib/config.ts#normalizeConfigFile), and
 * writes mirror the active profile back to the top level of the same file so a
 * pinned older CLI keeps reading it.
 */
import { Command } from "commander";
import chalk from "chalk";
import {
  DEFAULT_BASE_URL,
  activeProfileName,
  assertValidProfileName,
  configFilePath,
  deleteProfile,
  describeProtection,
  getProfile,
  isLegacyFlatConfigFile,
  listProfileNames,
  loadConfigFile,
  maskApiKey,
  normalizeBaseUrl,
  plaintextRemedy,
  profileSecretProtection,
  setCurrentProfile,
  upsertProfile,
  type CLIConfig,
  type ConfigFile,
  type SecretProtectionState,
} from "../lib/config.js";
import { platformDefaultBackend } from "../lib/secret-store.js";

/** One row of `profile list`, resolved the way the CLI actually resolves it. */
export interface ProfileRow {
  name: string;
  current: boolean;
  baseUrl: string;
  /** Display only — masked, or a label. NEVER the secret, in any branch. */
  apiKey: string;
  /** How the key is stored at rest: "none" | "plaintext" | a backend name. */
  protection: SecretProtectionState;
  projectId?: string;
}

/**
 * Build the rows `profile list` prints. Pure, so the display logic is testable
 * without a terminal.
 *
 * Deliberately does NOT decrypt. A protected key renders as a label, not as a
 * masked value — unwrapping every profile's secret just to print four
 * characters of it would spawn a subprocess per row and, on macOS, could raise
 * a Keychain prompt for a command that only wanted to draw a table. A legacy
 * PLAINTEXT key is still masked (it is already sitting in the file readable,
 * and the masked tail is what makes "which key is this" answerable).
 */
export function profileRows(config: ConfigFile, active = activeProfileName(config)): ProfileRow[] {
  return listProfileNames(config).map((name) => {
    const profile = getProfile(name, config);
    const protection = profileSecretProtection(profile);
    return {
      name,
      current: name === active,
      baseUrl: profile.baseUrl ? normalizeBaseUrl(profile.baseUrl) : DEFAULT_BASE_URL,
      apiKey:
        protection === "none"
          ? "(not set)"
          : protection === "plaintext"
            ? `${maskApiKey(profile.apiKey as string)} (plaintext)`
            : `(protected: ${protection})`,
      protection,
      projectId: profile.projectId,
    };
  });
}

/**
 * The env vars that OVERRIDE the active profile right now. Surfaced by
 * `profile current` because "the CLI is not using the profile I selected" is
 * otherwise a genuinely confusing five minutes.
 */
export function activeOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.EVALGUARD_PROFILE?.trim()) out.push(`EVALGUARD_PROFILE=${env.EVALGUARD_PROFILE.trim()}`);
  if (env.EVALGUARD_API_KEY?.trim()) out.push("EVALGUARD_API_KEY (overrides the profile's apiKey)");
  if (env.EVALGUARD_BASE_URL?.trim()) out.push("EVALGUARD_BASE_URL (overrides the profile's baseUrl)");
  if (env.EVALGUARD_SECRET_BACKEND?.trim()) {
    out.push(
      `EVALGUARD_SECRET_BACKEND=${env.EVALGUARD_SECRET_BACKEND.trim()} (how the NEXT save stores the key)`,
    );
  }
  return out;
}

/**
 * The nudge shown when a profile's key is still sitting in the file in the
 * clear. Returned rather than printed so it is testable, and so `--json`
 * callers can surface it too.
 */
export function plaintextWarning(rows: ProfileRow[]): string | undefined {
  const bare = rows.filter((r) => r.protection === "plaintext").map((r) => r.name);
  if (bare.length === 0) return undefined;
  return (
    `${bare.length === 1 ? "Profile" : "Profiles"} ${bare.join(", ")}: the API key is stored ` +
    `UNENCRYPTED. File permissions are not encryption. ${plaintextRemedy()}`
  );
}

function renderRows(rows: ProfileRow[]): string[] {
  const lines: string[] = [];
  lines.push(`  ${chalk.bold("Profiles")} ${chalk.dim(`(${rows.length})`)}`);
  const width = Math.max(8, ...rows.map((r) => r.name.length));
  for (const row of rows) {
    const marker = row.current ? chalk.green("*") : " ";
    const name = row.current ? chalk.cyan(row.name.padEnd(width)) : chalk.dim(row.name.padEnd(width));
    lines.push(`  ${marker} ${name}  ${row.baseUrl}  ${chalk.dim(row.apiKey)}`);
  }
  return lines;
}

export function registerProfile(program: Command): void {
  const profile = program
    .command("profile")
    .description("Manage named connection profiles (SaaS vs self-hosted, dev/stage/prod)");

  // ── profile list ──
  profile
    .command("list")
    .alias("ls")
    .description("List saved profiles (the active one is marked *)")
    .option("--file <path>", "Config file (defaults to ~/.evalguard/config.json)")
    .option("--json", "Machine-readable output", false)
    .action((opts: { file?: string; json: boolean }) => {
      const file = opts.file ?? configFilePath();
      const config = loadConfigFile(file);
      const rows = profileRows(config);
      if (opts.json) {
        console.log(JSON.stringify({ currentProfile: activeProfileName(config), profiles: rows }, null, 2));
        return;
      }
      console.log();
      for (const line of renderRows(rows)) console.log(line);
      const bare = plaintextWarning(rows);
      if (bare) {
        console.log();
        console.log(`  ${chalk.yellow("⚠")} ${chalk.yellow(bare)}`);
      }
      if (isLegacyFlatConfigFile(file)) {
        console.log();
        console.log(
          chalk.dim(
            `  Your existing config was adopted as the "default" profile. It is rewritten in the\n` +
              `  new format the next time anything saves — nothing to do.`,
          ),
        );
      }
      console.log();
    });

  // ── profile current ──
  profile
    .command("current")
    .description("Show the active profile and anything overriding it")
    .option("--file <path>", "Config file (defaults to ~/.evalguard/config.json)")
    .option("--json", "Machine-readable output", false)
    .action((opts: { file?: string; json: boolean }) => {
      const file = opts.file ?? configFilePath();
      const config = loadConfigFile(file);
      const name = activeProfileName(config);
      const row = profileRows(config, name).find((r) => r.name === name);
      const overrides = activeOverrides();
      const known = Object.prototype.hasOwnProperty.call(config.profiles, name);

      const protection = row?.protection ?? "none";

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              currentProfile: name,
              exists: known,
              baseUrl: row?.baseUrl ?? DEFAULT_BASE_URL,
              apiKey: row?.apiKey ?? "(not set)",
              // How the key is stored at rest, and what a save would use next.
              keyProtection: protection,
              keyProtectionDetail: describeProtection(protection),
              secretBackend: platformDefaultBackend(),
              projectId: row?.projectId,
              envOverrides: overrides,
              configFile: file,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log();
      console.log(`  ${chalk.bold("Profile")}   ${chalk.cyan(name)}${known ? "" : chalk.red("  (not saved)")}`);
      console.log(`  ${chalk.dim("Base URL")}  ${row?.baseUrl ?? DEFAULT_BASE_URL}`);
      console.log(`  ${chalk.dim("API key")}   ${row?.apiKey ?? "(not set)"}`);
      if (protection !== "none") {
        const detail = describeProtection(protection);
        console.log(
          `  ${chalk.dim("At rest")}   ${protection === "plaintext" ? chalk.yellow(detail) : chalk.green(detail)}`,
        );
      }
      if (row?.projectId) console.log(`  ${chalk.dim("Project")}   ${row.projectId}`);
      console.log(`  ${chalk.dim("Config")}    ${file}`);
      const bare = row ? plaintextWarning([row]) : undefined;
      if (bare) {
        console.log();
        console.log(`  ${chalk.yellow("⚠")} ${chalk.yellow(bare)}`);
      }
      if (overrides.length > 0) {
        console.log();
        console.log(`  ${chalk.yellow("Environment overrides in effect:")}`);
        for (const o of overrides) console.log(`    ${o}`);
      }
      console.log();
    });

  // ── profile create ──
  profile
    .command("create")
    .description("Create or update a named profile without touching the others")
    .argument("<name>", "Profile name")
    .option("--key <apiKey>", "API key for this profile")
    .option("--url <baseUrl>", "API base URL for this profile (self-hosted install)")
    .option("--project <projectId>", "Default project id for this profile")
    .option("--from <name>", "Copy settings from an existing profile first")
    .option("--use", "Switch to it after creating", false)
    .option("--file <path>", "Config file (defaults to ~/.evalguard/config.json)")
    .action(
      (
        name: string,
        opts: { key?: string; url?: string; project?: string; from?: string; use: boolean; file?: string },
      ) => {
        const file = opts.file ?? configFilePath();
        try {
          assertValidProfileName(name);
          const config = loadConfigFile(file);
          const base: CLIConfig = opts.from ? { ...getProfile(opts.from, config) } : {};
          if (opts.from && !Object.prototype.hasOwnProperty.call(config.profiles, opts.from)) {
            throw new Error(
              `No profile named ${JSON.stringify(opts.from)} to copy from. Saved profiles: ` +
                `${listProfileNames(config).join(", ") || "(none)"}.`,
            );
          }
          if (opts.key) base.apiKey = opts.key;
          // Normalize here for the same reason `login` does: a base URL missing
          // the /api/v1 prefix 404s every authenticated subcommand
          // (audit: cli-login-base-url-missing-api-v1).
          if (opts.url) base.baseUrl = normalizeBaseUrl(opts.url);
          if (opts.project) base.projectId = opts.project;

          upsertProfile(name, base, { switchTo: opts.use, file });
          console.log(chalk.green("✓") + ` Profile ${chalk.cyan(name)} saved to ${chalk.dim(file)}`);
          if (opts.key) {
            // Report what ACTUALLY happened to the key, read back from the
            // file — not what we intended. A fallback to plaintext already
            // warned on stderr; this is the line that keeps stdout honest too.
            const stored = profileSecretProtection(getProfile(name, loadConfigFile(file)));
            console.log(`  ${chalk.dim("Key at rest:")} ${describeProtection(stored)}`);
          }
          if (opts.use) console.log(`  Now using ${chalk.cyan(name)}.`);
          else console.log(chalk.dim(`  Switch to it with \`evalguard profile use ${name}\`.`));
        } catch (err) {
          console.error(chalk.red(`Error: ${(err as Error).message}`));
          process.exitCode = 1;
        }
      },
    );

  // ── profile use ──
  profile
    .command("use")
    .alias("switch")
    .description("Switch the active profile")
    .argument("<name>", "Profile name")
    .option("--file <path>", "Config file (defaults to ~/.evalguard/config.json)")
    .action((name: string, opts: { file?: string }) => {
      const file = opts.file ?? configFilePath();
      try {
        setCurrentProfile(name, file);
        console.log(chalk.green("✓") + ` Now using profile ${chalk.cyan(name)}.`);
        if (process.env.EVALGUARD_PROFILE?.trim()) {
          console.warn(
            chalk.yellow(
              `⚠ EVALGUARD_PROFILE="${process.env.EVALGUARD_PROFILE.trim()}" is set and takes ` +
                `precedence over this for the current shell.`,
            ),
          );
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // ── profile delete ──
  profile
    .command("delete")
    .alias("rm")
    .description("Delete a profile (the others are untouched)")
    .argument("<name>", "Profile name")
    .option("--file <path>", "Config file (defaults to ~/.evalguard/config.json)")
    .action((name: string, opts: { file?: string }) => {
      const file = opts.file ?? configFilePath();
      try {
        const after = deleteProfile(name, file);
        console.log(chalk.green("✓") + ` Deleted profile ${chalk.cyan(name)}.`);
        console.log(chalk.dim(`  Now using ${after.currentProfile}.`));
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
