/**
 * Shared CLI configuration helpers — NAMED PROFILES + the auth resolution chain.
 *
 * The `evalguard login` command persists credentials to `~/.evalguard/config.json`
 * (mode 0o600). Subcommands MUST resolve the API key and base URL through a
 * single precedence chain so the documented login flow actually works everywhere:
 *
 *   profile : process.env.EVALGUARD_PROFILE  ?? file.currentProfile ?? "default"
 *   apiKey  : process.env.EVALGUARD_API_KEY  ?? <profile>.apiKey
 *   baseUrl : process.env.EVALGUARD_BASE_URL ?? <profile>.baseUrl ?? default
 *
 * Before this module existed, keys/siem/models/budget/decision-bom read the key
 * ONLY from the env var and ignored the file, so users who followed the
 * `evalguard login` instructions got "EVALGUARD_API_KEY is not set" on a large
 * fraction of authenticated subcommands (audit: cli-auth-env-only-ignores-login-config).
 *
 * ── Named profiles (audit 2026-08-05, MEDIUM-HIGH) ──────────────────────────
 *
 * This file used to hold ONE flat `{apiKey, baseUrl, projectId}`, and `login`
 * overwrote it. Every enterprise runs at least two installs — SaaS and
 * self-hosted, or dev/stage/prod — so switching meant either re-running `login`
 * (destroying the other credential) or hand-juggling EVALGUARD_API_KEY and
 * EVALGUARD_BASE_URL in the shell. That is the kind of friction that gets a CLI
 * quietly replaced with a wrapper script.
 *
 * On-disk shape (version 2):
 *
 *   {
 *     "version": 2,
 *     "currentProfile": "prod",
 *     "profiles": {
 *       "default":     { "apiKey": "eg_…", "baseUrl": "https://evalguard.ai/api/v1" },
 *       "self-hosted": { "apiKey": "eg_…", "baseUrl": "https://eg.corp.internal/api/v1" }
 *     },
 *     "apiKey": "eg_…", "baseUrl": "…"        <- compatibility mirror, see below
 *   }
 *
 * ── Back-compat, in both directions ─────────────────────────────────────────
 *
 * FORWARD (old file, new CLI): a file with no `profiles` key is a v1 flat
 * config. It is adopted AS the `default` profile at READ time, with no write —
 * so an existing user upgrades, runs any command, and everything keeps working
 * without touching anything. Read-only home directories and CI images keep
 * working too, because reading never needs to write.
 *
 * BACKWARD (new file, old CLI): writes ALSO mirror the active profile's fields
 * at the top level of the same file. A pinned older `@evalguard/cli` — or
 * anything else reading `~/.evalguard/config.json` directly — still finds
 * `baseUrl` / `projectId` exactly where it expects them. The mirror
 * is derived output: on read, `profiles` ALWAYS wins and the mirror is ignored,
 * so hand-editing the top level of a v2 file has no effect (edit the profile,
 * or use `evalguard profile create`).
 *
 * ── Credential at rest (audit 2026-08-06) ───────────────────────────────────
 *
 * The API key is NOT written verbatim any more. `saveConfigFile` hands it to
 * the OS credential store (lib/secret-store.ts: DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux) and persists a `apiKeyEnc` envelope in place of
 * `apiKey`. `mode: 0o600` was never encryption — and on Windows Node's `mode`
 * is very nearly a no-op, so on that platform the file had no protection at
 * all. `resolveApiKey` unwraps the envelope transparently, so every subcommand
 * is unchanged.
 *
 * Two consequences, both deliberate:
 *
 *   - The compatibility mirror no longer carries `apiKey`. Mirroring the
 *     plaintext key at the top level of the very file we just encrypted would
 *     make the encryption decorative. A pinned older CLI therefore says "not
 *     authenticated" instead of silently using a key the new CLI protected;
 *     `EVALGUARD_API_KEY` or `EVALGUARD_SECRET_BACKEND=plaintext` covers that
 *     case explicitly.
 *   - An existing plaintext `apiKey` still RESOLVES (nobody gets stranded),
 *     with a one-shot stderr nudge, and the next save rewrites it protected.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  backendPreference,
  describeBackend,
  isProtectedSecret,
  platformDefaultBackend,
  protectSecret,
  purgeSecret,
  unprotectSecret,
  warnOnInvalidBackendEnv,
  warnOnce,
  type ProtectedSecret,
  type SecretBackendName,
} from "./secret-store.js";
import { boundedFetch, decodeJsonBody } from "./http.js";

/** Default hosted API base URL (includes the /api/v1 prefix). */
export const DEFAULT_BASE_URL = "https://evalguard.ai/api/v1";

/** Name of the profile a migrated flat config becomes, and the fallback. */
export const DEFAULT_PROFILE = "default";

/** On-disk schema version written by this CLI. */
export const CONFIG_VERSION = 2;

export interface CLIConfig {
  /**
   * PLAINTEXT API key. Only ever present on a config written before at-rest
   * protection landed, or when the secret store is explicitly/necessarily
   * `plaintext`. The field name is the honest one on purpose — if the key is
   * in the clear, it is called `apiKey`.
   */
  apiKey?: string;
  /** The protected API key. Mutually exclusive with `apiKey`; see secret-store.ts. */
  apiKeyEnc?: ProtectedSecret;
  baseUrl?: string;
  projectId?: string;
  openaiApiKey?: string;
  /** Unknown keys are preserved verbatim so a newer CLI's fields survive a round trip. */
  [key: string]: unknown;
}

/** The whole config file, normalized to the v2 shape. */
export interface ConfigFile {
  version: number;
  currentProfile: string;
  profiles: Record<string, CLIConfig>;
}

/** Keys that describe the FILE, never a profile's contents. */
const STRUCTURAL_KEYS = new Set(["version", "currentProfile", "profiles"]);

/**
 * Profile names become object keys, appear in shell commands and are printed
 * back to the user, so keep them boring: start alphanumeric, then
 * alphanumerics / dot / dash / underscore.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

export function assertValidProfileName(name: string): void {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name ${JSON.stringify(name)}. Use 1-64 characters: letters, digits, ` +
        `then any of . _ - (must start with a letter or digit).`,
    );
  }
}

/**
 * Absolute path to the persisted CLI config file.
 *
 * `EVALGUARD_CONFIG_FILE` relocates it — useful for CI images with a read-only
 * home, for a per-repo config checked into a devcontainer, and for tests. It
 * only says WHERE the file is; every precedence rule below is unchanged.
 */
export function configFilePath(): string {
  const override = process.env.EVALGUARD_CONFIG_FILE?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".evalguard", "config.json");
}

/** Shallow copy of a profile object, minus anything structural. */
function toProfile(raw: unknown): CLIConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CLIConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function emptyConfigFile(): ConfigFile {
  return { version: CONFIG_VERSION, currentProfile: DEFAULT_PROFILE, profiles: {} };
}

/**
 * Normalize whatever is on disk into the v2 shape.
 *
 * THIS is the migration. A v1 flat `{apiKey, baseUrl, projectId}` becomes
 * `profiles.default`, in memory, with no write — so an existing install keeps
 * working on the first command after the upgrade and nothing is stranded.
 */
export function normalizeConfigFile(raw: unknown): ConfigFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyConfigFile();
  const obj = raw as Record<string, unknown>;

  const rawProfiles = obj.profiles;
  if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
    const profiles: Record<string, CLIConfig> = {};
    for (const [name, value] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (!isValidProfileName(name)) continue;
      profiles[name] = toProfile(value);
    }
    const claimed = typeof obj.currentProfile === "string" ? obj.currentProfile.trim() : "";
    // A `currentProfile` naming something that is not there falls back to
    // `default`. It does NOT conjure that profile into existence: normalizing a
    // read must never invent a profile the user would then see in
    // `profile list` and wonder about.
    const currentProfile =
      claimed && Object.prototype.hasOwnProperty.call(profiles, claimed) ? claimed : DEFAULT_PROFILE;
    return { version: CONFIG_VERSION, currentProfile, profiles };
  }

  // v1 flat config — adopt it wholesale as the default profile.
  return {
    version: CONFIG_VERSION,
    currentProfile: DEFAULT_PROFILE,
    profiles: { [DEFAULT_PROFILE]: toProfile(obj) },
  };
}

/**
 * True when the file on disk is still the pre-profiles flat shape. Used only by
 * `evalguard profile` to tell the user their config was adopted, never to gate
 * behaviour — the migration is unconditional and transparent.
 */
export function isLegacyFlatConfigFile(file: string = configFilePath()): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const profiles = raw.profiles;
    return !(profiles && typeof profiles === "object" && !Array.isArray(profiles));
  } catch {
    return false;
  }
}

/**
 * Read the whole config file. Returns an empty v2 file on any error (missing,
 * malformed JSON, permission) — config is advisory, never fatal to load.
 */
export function loadConfigFile(file: string = configFilePath()): ConfigFile {
  try {
    if (fs.existsSync(file)) {
      return normalizeConfigFile(JSON.parse(fs.readFileSync(file, "utf-8")));
    }
  } catch {
    // Ignore — fall back to env-only / defaults.
  }
  return emptyConfigFile();
}

/**
 * Hand any PLAINTEXT `apiKey` in a profile to the OS credential store,
 * replacing it with an `apiKeyEnc` envelope.
 *
 * Runs for every profile on every write, which is what makes the upgrade
 * automatic: a legacy config with three plaintext keys is protected the first
 * time anything saves, without the user doing a thing. Already-protected
 * profiles are untouched (no envelope is ever re-wrapped), so the common path
 * costs zero subprocess spawns.
 */
function protectProfileSecrets(
  profiles: Record<string, CLIConfig>,
  file: string,
): Record<string, CLIConfig> {
  const out: Record<string, CLIConfig> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    const key = typeof profile.apiKey === "string" ? profile.apiKey : "";
    if (!key) {
      out[name] = profile;
      continue;
    }
    const result = protectSecret(key, { configFile: file, profile: name });
    if (result.kind === "protected") {
      const next: CLIConfig = { ...profile, apiKeyEnc: result.secret };
      delete next.apiKey;
      out[name] = next;
      continue;
    }
    // Plaintext. Say so, on stderr, once. A downgrade the user cannot see is
    // the failure mode this whole change exists to prevent.
    const pref = backendPreference();
    const chose = pref.forced && pref.name === "plaintext";
    warnOnce(
      chose
        ? `⚠ EvalGuard: EVALGUARD_SECRET_BACKEND=plaintext — the API key is stored UNENCRYPTED ` +
            `in ${file}. Prefer EVALGUARD_API_KEY, which never touches disk.`
        : `⚠ EvalGuard: the API key for profile "${name}" is being written to ${file} ` +
            `IN PLAINTEXT (${result.reason}). File permissions are not encryption` +
            (process.platform === "win32" ? ", and Node cannot set POSIX modes on Windows" : "") +
            `; anything running as this user can read it. Install an OS credential store ` +
            `(macOS Keychain / libsecret), or use EVALGUARD_API_KEY, which never touches disk.`,
    );
    const next: CLIConfig = { ...profile, apiKey: key };
    delete next.apiKeyEnc;
    out[name] = next;
  }
  return out;
}

/**
 * Write the config file (0o600, in a 0o700 directory), protecting credentials
 * on the way out and mirroring the active profile's NON-SECRET fields at the
 * top level for older readers. See the module header: the mirror is derived,
 * `profiles` always wins on read, and the mirror deliberately does NOT carry a
 * plaintext key — a decrypted copy sitting beside the ciphertext would make
 * the whole exercise theatre.
 */
export function saveConfigFile(config: ConfigFile, file: string = configFilePath()): void {
  // Protect BEFORE touching the filesystem: a backend the user explicitly
  // demanded and that is unavailable throws here, leaving the existing config
  // intact rather than half-written (and leaving no stray directory behind).
  const profiles = protectProfileSecrets(config.profiles, file);
  config.profiles = profiles;

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const mirror = toProfile(profiles[config.currentProfile] ?? {});
  const payload = {
    version: CONFIG_VERSION,
    currentProfile: config.currentProfile,
    profiles,
    ...mirror,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/** One-shot so a mistyped EVALGUARD_PROFILE warns once, not once per lookup. */
let warnedUnknownProfileEnv = false;

/**
 * The profile in effect: `EVALGUARD_PROFILE` > the file's `currentProfile` >
 * `default`. The env var wins for the same reason EVALGUARD_API_KEY does — a CI
 * job or a one-off `EVALGUARD_PROFILE=stage evalguard …` must not have to
 * mutate the user's config to select a target.
 */
export function activeProfileName(config: ConfigFile = loadConfigFile()): string {
  const fromEnv = process.env.EVALGUARD_PROFILE?.trim();
  if (fromEnv) {
    if (
      !Object.prototype.hasOwnProperty.call(config.profiles, fromEnv) &&
      !warnedUnknownProfileEnv &&
      Object.keys(config.profiles).length > 0
    ) {
      warnedUnknownProfileEnv = true;
      // stderr, not stdout: never corrupt a `--json` payload. Non-fatal,
      // because env vars may legitimately supply the key and base URL outright.
      console.warn(
        `Warning: EVALGUARD_PROFILE="${fromEnv}" does not match any saved profile ` +
          `(${Object.keys(config.profiles).join(", ")}). Run \`evalguard profile list\`.`,
      );
    }
    return fromEnv;
  }
  return config.currentProfile || DEFAULT_PROFILE;
}

/** Test-only: clear the one-shot unknown-profile warning latch. */
export function resetProfileWarnings(): void {
  warnedUnknownProfileEnv = false;
}

/** Every saved profile name, sorted, with `default` first when present. */
export function listProfileNames(config: ConfigFile = loadConfigFile()): string[] {
  const names = Object.keys(config.profiles).sort((a, b) => a.localeCompare(b));
  return names.sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : 0));
}

/** One profile's settings, or `{}` when it does not exist. */
export function getProfile(name: string, config: ConfigFile = loadConfigFile()): CLIConfig {
  return config.profiles[name] ?? {};
}

/**
 * Read the ACTIVE profile's settings.
 *
 * Signature and return shape are unchanged from the pre-profiles version, which
 * is why all ~50 subcommands became profile-aware without being touched.
 */
export function loadConfig(): CLIConfig {
  const config = loadConfigFile();
  return getProfile(activeProfileName(config), config);
}

/**
 * Create or update ONE profile, leaving every other profile untouched — the
 * whole point of the feature. `switchTo` also makes it current.
 */
export function upsertProfile(
  name: string,
  patch: CLIConfig,
  opts: { switchTo?: boolean; file?: string } = {},
): ConfigFile {
  assertValidProfileName(name);
  const file = opts.file ?? configFilePath();
  const config = loadConfigFile(file);
  const wasEmpty = Object.keys(config.profiles).length === 0;
  const incoming = toProfile(patch);
  const merged: CLIConfig = { ...(config.profiles[name] ?? {}), ...incoming };
  // A patch carrying a NEW plaintext key (what `login --key` does) must retire
  // the previous envelope. Without this the merge keeps both, `resolveApiKey`
  // prefers the envelope, and the user's rotated key is silently ignored while
  // the revoked one keeps being sent.
  if (typeof incoming.apiKey === "string") delete merged.apiKeyEnc;
  else if (isProtectedSecret(incoming.apiKeyEnc)) delete merged.apiKey;
  config.profiles[name] = merged;
  // The FIRST profile on a fresh config becomes current even without an
  // explicit switch — otherwise `evalguard profile create prod --key …` on a
  // new machine leaves a config that resolves nothing, which reads as a bug.
  if (opts.switchTo || wasEmpty) config.currentProfile = name;
  saveConfigFile(config, file);
  return config;
}

/** Switch the current profile. Throws when it does not exist. */
export function setCurrentProfile(name: string, file: string = configFilePath()): ConfigFile {
  assertValidProfileName(name);
  const config = loadConfigFile(file);
  if (!Object.prototype.hasOwnProperty.call(config.profiles, name)) {
    throw new Error(
      `No profile named ${JSON.stringify(name)}. Saved profiles: ` +
        `${listProfileNames(config).join(", ") || "(none)"}. ` +
        `Create it with \`evalguard profile create ${name} --key <key>\`.`,
    );
  }
  config.currentProfile = name;
  saveConfigFile(config, file);
  return config;
}

/**
 * Delete a profile. Deleting the CURRENT one falls back to `default` (created
 * empty if need be) rather than leaving the file pointing at nothing.
 */
export function deleteProfile(name: string, file: string = configFilePath()): ConfigFile {
  const config = loadConfigFile(file);
  if (!Object.prototype.hasOwnProperty.call(config.profiles, name)) {
    throw new Error(
      `No profile named ${JSON.stringify(name)}. Saved profiles: ` +
        `${listProfileNames(config).join(", ") || "(none)"}.`,
    );
  }
  // Take the OS-side copy with it. Keychain / libsecret entries live outside
  // this file, so deleting the profile alone would leave the credential
  // sitting in the user's keyring forever. (DPAPI has nothing to purge — its
  // ciphertext is in the file we are about to rewrite.)
  const doomed = config.profiles[name];
  if (doomed && isProtectedSecret(doomed.apiKeyEnc)) purgeSecret(doomed.apiKeyEnc);

  delete config.profiles[name];
  if (config.currentProfile === name) {
    const remaining = listProfileNames(config);
    config.currentProfile = remaining[0] ?? DEFAULT_PROFILE;
  }
  if (Object.keys(config.profiles).length === 0) {
    config.profiles[DEFAULT_PROFILE] = {};
    config.currentProfile = DEFAULT_PROFILE;
  }
  saveConfigFile(config, file);
  return config;
}

/** Write a patch into the ACTIVE profile — what `evalguard login` does. */
export function saveActiveProfile(patch: CLIConfig, file: string = configFilePath()): ConfigFile {
  const config = loadConfigFile(file);
  return upsertProfile(activeProfileName(config), patch, { file });
}

/**
 * How a profile's API key is stored, without ever decrypting it.
 *
 * `profile list` / `profile current` render from this: unwrapping a secret
 * just to mask it would spawn a subprocess per profile and — on macOS — could
 * pop a Keychain prompt for a command that only wanted to print a table.
 */
export type SecretProtectionState = "none" | "plaintext" | SecretBackendName;

/**
 * The backend a write WOULD use, for messaging only.
 *
 * A malformed `EVALGUARD_SECRET_BACKEND` must hard-fail a WRITE (see
 * `protectSecret`), but it must not break a READ of a key the user already
 * has — that would turn a typo in an env var into "all my credentials are
 * gone".
 */
function preferredBackend(): { name: SecretBackendName; forced: boolean } {
  try {
    return backendPreference();
  } catch {
    // Already reported by warnOnInvalidBackendEnv() on the read path, and
    // hard-thrown on the write path.
    return { name: platformDefaultBackend(), forced: false };
  }
}

/**
 * The sentence that tells a user with a PLAINTEXT key what to do about it.
 *
 * Three genuinely different situations, and saying the wrong one is its own
 * small dishonesty — "re-store it with plaintext — NOT encrypted" is not
 * advice, and "no credential store is available" is simply false when the user
 * asked for plaintext on a machine that has DPAPI.
 */
export function plaintextRemedy(): string {
  const pref = preferredBackend();
  if (pref.forced && pref.name === "plaintext") {
    return (
      `EVALGUARD_SECRET_BACKEND=plaintext is set, so it stays that way. Unset it and re-run ` +
      `\`evalguard login --key <key>\` to protect it with ${describeBackend(platformDefaultBackend())}.`
    );
  }
  if (pref.name === "plaintext") {
    return (
      `No OS credential store is available here (install libsecret / use a machine with a ` +
      `keyring), or set EVALGUARD_API_KEY, which never touches disk.`
    );
  }
  return (
    `Run \`evalguard login --key <key>\` (or any \`evalguard profile\` write) to re-store it ` +
    `with ${describeBackend(pref.name)}.`
  );
}

export function profileSecretProtection(profile: CLIConfig): SecretProtectionState {
  if (isProtectedSecret(profile.apiKeyEnc)) return profile.apiKeyEnc.backend;
  if (typeof profile.apiKey === "string" && profile.apiKey.length > 0) return "plaintext";
  return "none";
}

/** Human-readable form of {@link profileSecretProtection}. Never oversells. */
export function describeProtection(state: SecretProtectionState): string {
  if (state === "none") return "(not set)";
  if (state === "plaintext") return "plaintext — NOT encrypted";
  return describeBackend(state);
}

/**
 * Resolve the EvalGuard API key with the canonical precedence:
 *
 *   env EVALGUARD_API_KEY > <profile>.apiKeyEnc (decrypted) > <profile>.apiKey
 *
 * The env var still wins outright and never touches the credential store, so a
 * CI job pays nothing for this change. `apiKeyEnc` beats a stray plaintext
 * `apiKey` on the same profile: the protected copy is the one a save produced,
 * the plaintext one can only be a leftover.
 *
 * A legacy plaintext key still resolves — stranding a user who upgraded would
 * be a worse outcome than the plaintext they already had — but says once, on
 * stderr, how to upgrade it.
 *
 * Returns `undefined` when nothing is set (caller decides how to fail).
 */
export function resolveApiKey(config: CLIConfig = loadConfig()): string | undefined {
  const fromEnv = process.env.EVALGUARD_API_KEY;
  if (fromEnv) return fromEnv;

  // A typo in the backend selector must be visible even in a read-only session
  // (writes hard-fail on it; a read would otherwise silently use the default).
  warnOnInvalidBackendEnv();

  if (isProtectedSecret(config.apiKeyEnc)) return unprotectSecret(config.apiKeyEnc);

  if (typeof config.apiKey === "string" && config.apiKey.length > 0) {
    warnOnce(
      `⚠ EvalGuard: your API key is stored in PLAINTEXT in ${configFilePath()}. ` +
        `File permissions are not encryption. ${plaintextRemedy()}`,
    );
    return config.apiKey;
  }
  return undefined;
}

/**
 * Normalize a user-supplied API base URL so it always points at the versioned
 * API root. `evalguard login --url https://evalguard.ai` (or with a trailing
 * slash) previously persisted a base WITHOUT the `/api/v1` prefix, so ~15
 * authenticated subcommands resolved to `https://evalguard.ai/<path>` and 404'd
 * (audit: cli-login-base-url-missing-api-v1).
 *
 * Precedence (after stripping trailing slashes):
 *   - already ends in `/api/v1`  → returned unchanged (idempotent);
 *   - ends in `/api`             → the version is appended → `/api/v1`. This is
 *     the documented public base (`https://evalguard.ai/api`); the old check
 *     only looked for `/api/v1`, so it double-appended into `/api/api/v1` and
 *     404'd (audit M2: cli-normalize-base-url-double-api).
 *   - anything else (bare host)  → `/api/v1` is appended.
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  if (/\/api\/v1$/.test(trimmed)) return trimmed;
  if (/\/api$/.test(trimmed)) return `${trimmed}/v1`;
  return `${trimmed}/api/v1`;
}

/**
 * Resolve the EvalGuard API base URL with the canonical precedence:
 *   env EVALGUARD_BASE_URL > ~/.evalguard/config.json#baseUrl > default.
 *
 * The resolved value is normalized so a base URL missing the `/api/v1` prefix
 * (env var or a config written before normalization landed) still works.
 */
export function resolveBaseUrl(config: CLIConfig = loadConfig()): string {
  const raw = process.env.EVALGUARD_BASE_URL ?? config.baseUrl;
  return raw ? normalizeBaseUrl(raw) : DEFAULT_BASE_URL;
}

/**
 * True only when the URL's parsed HOST is a loopback address. Used by
 * `evalguard login` to permit plaintext (non-HTTPS) URLs for local dev while
 * still requiring HTTPS for any real remote host.
 *
 * The previous implementation did `url.includes('localhost')`, which a query
 * string like `http://evil.example/?x=localhost` trivially defeats — causing
 * the stored API key to be sent in cleartext to a non-loopback host
 * (audit: cli-login-https-substring-bypass). We compare the PARSED hostname,
 * not a substring of the raw string.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  // Node's URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]").
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * Per-process cache of the auto-resolved default project id. The CLI is a
 * short-lived process, so a module-level cache means a single `evalguard`
 * invocation that touches several project-scoped endpoints only calls
 * `/project/current` once. `resetResolvedProjectId()` is exported for tests.
 */
let cachedProjectId: string | undefined;

/** Test-only: clear the per-process resolved-project cache. */
export function resetResolvedProjectId(): void {
  cachedProjectId = undefined;
}

/**
 * Resolve the project id to use for a project-scoped operation.
 *
 * Precedence:
 *   1. An explicitly-supplied `explicit` id (e.g. `--project <id>` or a
 *      `projectId` field in a config file) ALWAYS wins and skips the network
 *      call entirely.
 *   2. Otherwise GET `/project/current` (the endpoint added in #622) with the
 *      stored API key and use the returned `projectId`. On a fresh org the
 *      server auto-creates a default project, so this is usually non-empty.
 *
 * The resolved id is cached per process so repeated calls within one CLI
 * invocation don't re-fetch.
 *
 * The endpoint returns RAW JSON `{ projectId, orgId }` (NOT a `{success,data}`
 * envelope). If the call fails or `projectId` is empty we throw a clear error
 * telling the user to pass `--project` explicitly.
 */
export async function resolveProjectId(
  explicit?: string,
  config: CLIConfig = loadConfig(),
): Promise<string> {
  // 1. Explicit id wins and never triggers a fetch.
  //
  // …but an explicitly-supplied EMPTY id is a caller error, not "unspecified".
  // This `if (trimmedExplicit)` was the whole defect: `--project ""` is not
  // nullish, so it sailed past every `??` on the way here, and then fell out of
  // this truthiness test into the auto-resolve branch below. Measured on the
  // built 3.8.0 CLI:
  //
  //     $ evalguard runs --project ""
  //         Eval Runs (7)                                        EXIT 0
  //
  // — seven runs belonging to the org's DEFAULT project, printed under a
  // project id the caller believes they supplied. A CI script whose
  // `$PROJECT_ID` never got exported reports another project's results as its
  // own, and there is nothing on screen to say so.
  //
  // This is the CHOKE POINT: all eight call sites (six in server-read.ts, one
  // in logs.ts, and eval/scan in index.ts, where the id can also arrive from a
  // config file) resolve through here, so closing it here closes all of them
  // rather than leaving a new check to fail open beside a fixed neighbour.
  // The command-level `--project` flags additionally refuse with exit 2 before
  // reaching this point; this throw is the backstop for every other path.
  if (explicit !== undefined && explicit !== null && explicit.trim() === "") {
    throw new Error(
      "--project was given an empty value. An empty project id is a caller error, not " +
        "'unspecified' — refusing to silently fall back to the org's default project " +
        "(that would report another project's results as yours). Pass a real project id, " +
        "or omit the flag entirely to use the default.",
    );
  }
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) return trimmedExplicit;

  // 2. Reuse the per-process cache when present.
  if (cachedProjectId) return cachedProjectId;

  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error(
      "No EvalGuard API key found. Run `evalguard login --key <key>` or set EVALGUARD_API_KEY.",
    );
  }

  const baseUrl = resolveBaseUrl(config);
  let res: Response;
  try {
    res = await boundedFetch(`${baseUrl}/project/current`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
    });
  } catch {
    throw new Error(
      "Could not resolve a default project; pass projectId explicitly (--project <id>).",
    );
  }

  if (!res.ok) {
    throw new Error(
      "Could not resolve a default project; pass projectId explicitly (--project <id>).",
    );
  }

  // `/project/current` returns RAW { projectId, orgId } — not a {success,data} envelope.
  const body = (await decodeJsonBody(res, "config")) as { projectId?: string } | null;
  const projectId = body?.projectId?.trim();
  if (!projectId) {
    throw new Error(
      "Could not resolve a default project; pass projectId explicitly (--project <id>).",
    );
  }

  cachedProjectId = projectId;
  return projectId;
}

/**
 * Mask an API key for display so the full secret is never printed, regardless
 * of length. Long keys keep head+tail context; short keys (<= 12 chars) show
 * only a fixed prefix plus the last 4 so the head/middle is never revealed and
 * the head and tail windows can't overlap into the whole secret
 * (audit: cli-whoami-short-key-leak).
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) {
    // Never reveal the head for short keys; show only the last 4 (or fewer).
    const tail = apiKey.slice(-4);
    return `***${tail}`;
  }
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}
