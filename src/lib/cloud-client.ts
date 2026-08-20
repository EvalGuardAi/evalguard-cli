/**
 * Authenticated cloud client used by `evalguard eval` and `evalguard scan`.
 *
 * These two commands used to build their client by reading the API key + base
 * URL ONLY from `~/.evalguard/config.json` (via a private `getClient()` inside
 * `index.ts`), while EVERY other authenticated command resolves them through the
 * shared `resolveApiKey()` / `resolveBaseUrl()` precedence chain
 * (env `EVALGUARD_API_KEY` / `EVALGUARD_BASE_URL` > login config > default). That
 * split-brain broke the documented env-var CI auth for eval/scan and let a stale
 * config file silently override the env var (audit H1:
 * cli-eval-scan-getclient-config-only). This module is the single, testable seam
 * that resolves auth the SAME way as the rest of the CLI.
 */
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl, loadConfig } from "./config.js";
import { decodeJsonBody, describeShape, expectArrayField, timedFetch, unwrapApiEnvelope } from "./http.js";

/**
 * Pull a human-readable message out of an API error body, regardless of which
 * envelope shape the server used. The standard EvalGuard error envelope is
 * `{ success: false, error: { message, code } }`; validation failures fold the
 * Zod field errors into `error.message` ("field: msg; field: msg"). We also
 * tolerate a flat `{ message }`, a bare `{ error: "string" }`, and a top-level
 * `fieldErrors`/`errors` map so users see the real reason instead of the
 * useless "Unknown error" (audit: cli-error-masking-unknown-error).
 */
export function extractServerError(data: unknown, fallback: string): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === "string" && err.trim()) return err;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
    // Field-level validation errors (e.g. `{ fieldErrors: { name: ["Required"] } }`).
    const fieldErrors = (obj.fieldErrors ?? obj.errors) as
      | Record<string, unknown>
      | undefined;
    if (fieldErrors && typeof fieldErrors === "object") {
      const parts = Object.entries(fieldErrors)
        .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : String(msgs)}`)
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    }
  }
  return fallback || "Unknown error";
}

/**
 * Server-side check that an API key is actually accepted by the backend, used by
 * `evalguard login` so a bad key is REJECTED at login time instead of being
 * silently stored and only failing on the first real command. Hits a lightweight
 * AUTHED endpoint (`GET ${baseUrl}/scorers` — `baseUrl` is already the
 * normalized `/api/v1` root): 200 CARRYING THAT ENDPOINT'S ANSWER with a valid
 * key, 401/403 with a bad one.
 *
 * Three outcomes, and only the first is a pass:
 *
 *   valid       2xx whose body really is `{ scorers, … }`
 *   invalid     401/403 — the server actively rejected the key
 *   unverified  everything else: 5xx, network error, timeout, AND a 2xx whose
 *               body is not this endpoint's answer (see the block below)
 *
 * `unverified` is deliberately soft for `evalguard login` — offline / air-gapped
 * / transient-outage users are not blocked from saving a key that will be
 * re-checked on first use. It is NOT soft for `evalguard whoami`, which exits
 * non-zero on it, because that command is used as a CI credential guard.
 */
export async function validateApiKey(
  apiKey: string,
  baseUrl: string,
  clientVersion: string,
): Promise<
  | { status: "valid" }
  | { status: "invalid"; message: string }
  | { status: "unverified"; reason: string }
> {
  let res: Response;
  try {
    res = await timedFetch(`${baseUrl}/scorers`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-evalguard-client-version": clientVersion,
        "Content-Type": "application/json",
      },
      // Composed with the global ceiling by `timedFetch`; the shorter one wins,
      // so this stays a 10s check.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { status: "unverified", reason: (e as Error).message };
  }

  if (res.ok) {
    // A 2xx STATUS IS NOT A VERIFIED KEY.
    //
    // This used to be a bare `if (res.ok) return { status: "valid" }` — the
    // body was never read. Measured 2026-08-08 against a stub answering 200 to
    // everything, `evalguard whoami` printed
    //
    //     ✓ Authenticated (verified against the server)      EXIT 0
    //
    // for a fabricated key, for EVERY malformed body in the matrix: invalid
    // JSON, an empty body, a 204, `null`, a bare string, an HTML proxy page,
    // `{"hello":"world"}`, `{success:true,data:null}` and a `success:false`
    // envelope. Anything in the path that answers 200 — a captive portal, a
    // corporate proxy, a misrouted ingress, a stub — "authenticated" you. That
    // is the same fail-open the checkmark was just fixed for, one layer down.
    //
    // `GET /scorers` is `apiSuccess({ scorers, total })`, so a real answer has
    // a `scorers` list. Anything else is reported as UNVERIFIED rather than
    // INVALID: the key may well be fine and it is the RESPONSE that is not
    // trustworthy, and calling a good key "invalid" would send people rotating
    // credentials to fix a broken proxy. Both outcomes exit non-zero, so the
    // CI guard is fail-closed either way.
    try {
      const body = await decodeJsonBody(res, "GET /scorers (key check)");
      expectArrayField(unwrapApiEnvelope(body, "GET /scorers (key check)"), "scorers", "GET /scorers (key check)");
      return { status: "valid" };
    } catch (e) {
      return {
        status: "unverified",
        reason:
          `the server answered ${res.status} but the body is not this endpoint's answer, so the ` +
          `key could not be checked — ${(e as Error).message}`,
      };
    }
  }

  if (res.status === 401 || res.status === 403) {
    const data = await decodeJsonBody(res, "GET /scorers (key check)");
    return { status: "invalid", message: extractServerError(data, "Invalid API key") };
  }

  return { status: "unverified", reason: `server returned ${res.status}` };
}

/** Parse `N.N.N` (ignoring -prerelease/+build) → [major, minor, patch]. */
function parseCliSemver(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpCliSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export interface CloudClient {
  apiKey: string;
  baseUrl: string;
  projectId?: string;
  request(urlPath: string, method: string, body?: unknown): Promise<unknown>;
  /**
   * Consult the org's enterprise-managed client version-pinning policy and
   * REFUSE (throw {@link ClientVersionPolicyError}) when this CLI version is
   * outside the approved range.
   *
   * ─── WIRE-OR-DELETE, 2026-08-10: WIRED ──────────────────────────────────
   *
   * This method existed and was called by NOTHING — enterprise client-version
   * pinning was dead code on the CLI side, so an org that set a pin in
   * `gateway_managed_policy` got no CLI enforcement at all. It is now called
   * from the two live `getCloudClient` sites (`eval` and `scan` in index.ts).
   * Deleting it was the alternative and was rejected: the server route
   * (`GET /api/v1/client/policy`) is shipped, tested and reachable, the admin
   * write path exists, and the header the CLI already sends
   * (`x-evalguard-client-version`) is meaningless without a client that acts
   * on the answer.
   *
   * ─── FAIL-OPEN vs FAIL-CLOSED: fail-OPEN on transport, CLOSED on verdict ──
   *
   *   reachable + policy says NO      → refuse (throw). The only closed case.
   *   reachable + unpinned            → allow.
   *   unreachable / 5xx / timeout /
   *     older server / unreadable body → ALLOW, with a stderr warning.
   *
   * Fail-closed on transport was considered and is the wrong trade here, for
   * three reasons that are all about damage, not principle:
   *
   *   1. It converts a blip in ONE read-only endpoint into a total outage of
   *      every customer's CI. That is a self-inflicted incident strictly worse
   *      than a slightly-stale client running for an hour.
   *   2. This is not the enforcement boundary and cannot be. Any user can pin
   *      an old `@evalguard/cli`, or skip the CLI and curl the API. The server
   *      sees `x-evalguard-client-version` on EVERY request and is where a pin
   *      is actually enforceable; the client check is a courteous early stop
   *      with a good error message, not a control.
   *   3. The SERVER already chose fail-open for exactly this, in the same
   *      words ("a transient policy-read failure must never lock a paying
   *      customer's whole SDK/CLI fleet out of the API"). A client that failed
   *      closed against a server that fails open would produce the worst
   *      outcome: unreachable policy ⇒ CLI blocked, API allowed.
   *
   * The failure that is NOT tolerated is a SILENT one: every fail-open branch
   * says so on stderr, so "the pin isn't working" is visible rather than
   * inferred. That is the difference between this and the code it replaces,
   * which swallowed every error — including a 200 whose body it could not
   * parse — with a bare `catch { return; }`.
   */
  assertVersionAllowed(): Promise<void>;
}

/**
 * Thrown when the org's policy actively excludes this CLI version.
 *
 * A distinct type so the caller can render it as a REFUSAL ("your org does not
 * allow this version") rather than as an API error, and so it can never be
 * confused with the fail-open paths, which do not throw at all.
 *
 * `assertVersionAllowed` deliberately does NOT call `process.exit` any more.
 * Both call sites hold a live `ora` spinner and have just made an HTTP request,
 * which is precisely the state in which `process.exit()` trips the libuv
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` abort documented all
 * over this package (exit 0xC0000409 / 127 on Windows) — i.e. wiring the old
 * implementation as written would have turned a policy refusal into a crash.
 */
export class ClientVersionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientVersionPolicyError";
  }
}

/** Emitted once per process so a fail-open is visible but not spammy. */
let warnedPolicyUnreadable = false;

/** Test-only: clear the one-shot policy warning latch. */
export function resetClientPolicyWarning(): void {
  warnedPolicyUnreadable = false;
}

function warnPolicyUnreadable(reason: string): void {
  if (warnedPolicyUnreadable) return;
  warnedPolicyUnreadable = true;
  // stderr, never stdout: `eval --json` output must stay machine-readable.
  console.warn(
    chalk.yellow("Warning: could not read this organization's client-version policy") +
      chalk.dim(` (${reason}). Continuing — the server enforces the pin on every request.`),
  );
}

/**
 * Build the authenticated cloud client, resolving the API key + base URL through
 * the shared env-first precedence chain. Returns `{ ok: false }` when no API key
 * resolves so the caller can print a message and exit cleanly (keeps
 * `process.exit` out of this testable factory).
 *
 * @param clientVersion the CLI package version, sent as the
 *   `x-evalguard-client-version` header so an org that pins an allowed client
 *   range (enterprise governance policy) can enforce it server-side.
 */
export function getCloudClient(
  clientVersion: string,
): { ok: true; client: CloudClient } | { ok: false } {
  const config = loadConfig();
  const apiKey = resolveApiKey(config);
  if (!apiKey) return { ok: false };
  const baseUrl = resolveBaseUrl(config);

  const client: CloudClient = {
    apiKey,
    baseUrl,
    projectId: config.projectId,
    async request(urlPath: string, method: string, body?: unknown) {
      const res = await timedFetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-evalguard-client-version": clientVersion,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // FAIL CLOSED on a 2xx this client cannot interpret. The previous
      // `.catch(() => ({ message: res.statusText }))` handed `eval`/`scan` a
      // fabricated `{ message: "OK" }` object for an unparseable 200, which then
      // flowed on as if it were a real run record — see lib/http.ts.
      const data = await decodeJsonBody(res, `${method} ${urlPath}`);
      if (!res.ok) {
        throw new Error(`API error ${res.status}: ${extractServerError(data, res.statusText)}`);
      }
      return data;
    },
    async assertVersionAllowed() {
      let policy: {
        requiredMinimumVersion?: string | null;
        requiredMaximumVersion?: string | null;
        versionCheck?: { allowed?: unknown; reason?: unknown };
      };
      try {
        const raw = await this.request(
          `/client/policy?version=${encodeURIComponent(clientVersion)}`,
          "GET",
        );
        // `raw.data ?? raw` was the exact pattern lib/http.ts exists to replace:
        // it hands a `{success:false,error:…}` envelope straight through as if
        // it were a policy, and `{}` reads as "unpinned". Unwrap properly, and
        // treat anything unreadable as UNKNOWN (fail-open + warn), never as
        // "unpinned" — those are different facts and only one is a permission.
        const data = unwrapApiEnvelope(raw, "GET /client/policy");
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          warnPolicyUnreadable(`the endpoint answered 2xx with ${describeShape(data)}`);
          return;
        }
        policy = data as typeof policy;
      } catch (e) {
        // Unreachable, 4xx/5xx, timeout, older server with no such route, or a
        // body the shared boundary refused. All ALLOW — and all say so.
        warnPolicyUnreadable((e as Error).message);
        return;
      }

      // Prefer the SERVER's own verdict when it sent one. The route evaluates
      // `?version=` with `checkClientVersion()` and returns
      // `versionCheck: { allowed, status, reason }`; using it means the CLI and
      // the server can never disagree about what a pin means, and the operator
      // gets the server's wording. The local semver comparison below remains
      // only as the fallback for a server too old to send `versionCheck`.
      const check = policy.versionCheck;
      if (check && typeof check.allowed === "boolean") {
        if (check.allowed) return;
        throw new ClientVersionPolicyError(
          typeof check.reason === "string" && check.reason.trim()
            ? check.reason
            : `EvalGuard CLI ${clientVersion} is not an allowed client version for this organization.`,
        );
      }

      const min = policy.requiredMinimumVersion ?? null;
      const max = policy.requiredMaximumVersion ?? null;
      if (!min && !max) return; // genuinely unpinned

      const ver = parseCliSemver(clientVersion);
      const minT = parseCliSemver(min);
      const maxT = parseCliSemver(max);
      // A pin we cannot PARSE is not a pin we may ignore silently. The old code
      // fell through these `ver && minT &&` guards without a word, so a policy
      // of "1.2" (not three components) disabled enforcement invisibly.
      if (!ver || (min && !minT) || (max && !maxT)) {
        warnPolicyUnreadable(
          `the policy is not comparable (client "${clientVersion}", min "${min ?? "-"}", max "${max ?? "-"}")`,
        );
        return;
      }
      if (minT && cmpCliSemver(ver, minT) < 0) {
        throw new ClientVersionPolicyError(
          `EvalGuard CLI ${clientVersion} is below the minimum version (${min}) required by this organization. Upgrade with \`npm i -g @evalguard/cli\`.`,
        );
      }
      if (maxT && cmpCliSemver(ver, maxT) > 0) {
        throw new ClientVersionPolicyError(
          `EvalGuard CLI ${clientVersion} is above the maximum version (${max}) allowed by this organization. Install a supported release.`,
        );
      }
    },
  };

  return { ok: true, client };
}
