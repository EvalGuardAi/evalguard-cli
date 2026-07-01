/**
 * Shared CLI configuration helpers.
 *
 * The `evalguard login` command persists `{ apiKey, baseUrl, projectId }` to
 * `~/.evalguard/config.json` (mode 0o600). Subcommands MUST resolve the API key
 * and base URL through a single precedence chain so the documented login flow
 * actually works everywhere:
 *
 *   apiKey  : process.env.EVALGUARD_API_KEY  ?? config.apiKey
 *   baseUrl : process.env.EVALGUARD_BASE_URL ?? config.baseUrl ?? default
 *
 * Before this module existed, keys/siem/models/budget/decision-bom read the key
 * ONLY from the env var and ignored the file, so users who followed the
 * `evalguard login` instructions got "EVALGUARD_API_KEY is not set" on a large
 * fraction of authenticated subcommands (audit: cli-auth-env-only-ignores-login-config).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Default hosted API base URL (includes the /api/v1 prefix). */
export const DEFAULT_BASE_URL = "https://evalguard.ai/api/v1";

export interface CLIConfig {
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
  openaiApiKey?: string;
}

/** Absolute path to the persisted CLI config file. */
export function configFilePath(): string {
  return path.join(os.homedir(), ".evalguard", "config.json");
}

/**
 * Read `~/.evalguard/config.json`. Returns `{}` on any error (missing file,
 * malformed JSON, permission) — config is advisory, never fatal to load.
 */
export function loadConfig(): CLIConfig {
  try {
    const file = configFilePath();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as CLIConfig;
    }
  } catch {
    // Ignore — fall back to env-only / defaults.
  }
  return {};
}

/**
 * Resolve the EvalGuard API key with the canonical precedence:
 *   env EVALGUARD_API_KEY > ~/.evalguard/config.json#apiKey.
 * Returns `undefined` when neither is set (caller decides how to fail).
 */
export function resolveApiKey(config: CLIConfig = loadConfig()): string | undefined {
  return process.env.EVALGUARD_API_KEY ?? config.apiKey;
}

/**
 * Normalize a user-supplied API base URL so it always points at the versioned
 * API root. `evalguard login --url https://evalguard.ai` (or with a trailing
 * slash) previously persisted a base WITHOUT the `/api/v1` prefix, so ~15
 * authenticated subcommands resolved to `https://evalguard.ai/<path>` and 404'd
 * (audit: cli-login-base-url-missing-api-v1). We strip the trailing slash and
 * append `/api/v1` unless the URL already ends in that segment.
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
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
    res = await fetch(`${baseUrl}/project/current`, {
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
  const body = (await res.json().catch(() => null)) as { projectId?: string } | null;
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
