/**
 * The CLI's single HTTP boundary: a BOUNDED-TIME request and a FAIL-CLOSED JSON
 * decode.
 *
 * ─── Why this module exists ─────────────────────────────────────────────────
 *
 * AUDIT 2026-08-08. A real-world audit installed `@evalguard/cli` from npm and
 * pointed it at a stub backend. Measured against the built CLI (Node 24), with a
 * stub answering HTTP 200 and a body of `this is not JSON at all {{{`:
 *
 *   $ EVALGUARD_BASE_URL=http://127.0.0.1:8791 evalguard runs --project p1
 *     No eval runs found for this project.
 *   $ echo $?
 *   0
 *
 * Garbage in, "success, nothing found" out. The same command exited 0 for an
 * EMPTY body, a 204, a bare `null`, an HTML error page from a proxy, and a
 * `{success:true,data:null}` envelope. A wrong-SHAPE but valid JSON body exited
 * 1, but only by accident and only after printing `Eval Runs (undefined)`
 * followed by the raw `Error: rows is not iterable`.
 *
 * The single root cause was one idiom, copy-pasted into 35 places across
 * `apps/cli/src`:
 *
 *     const body = await res.json().catch(() => null);
 *     if (!res.ok) { ...throw... }
 *     return unwrap(body);            // ← `null` sails straight through here
 *
 * `.catch(() => null)` converts "I could not understand the server" into "the
 * server said nothing", and every caller downstream reads "nothing" as "no
 * findings / no runs / all clear". That is a fail-OPEN decode, and it is the
 * exact defect class already fixed in the TS SDK (`requireVerdict` in
 * packages/sdk/src/client.ts), in wrapper-core, and in the MCP server
 * (`enforceResponseContract` in packages/mcp-server/response-contract.ts).
 *
 * THE RULE, identical to those siblings: a response the client cannot INTERPRET
 * must be surfaced as a FAILURE. An indeterminate answer is neither "empty" nor
 * "clean" — it is "the call did not happen".
 *
 * Fixing this per-command is how the class recurs, so the decode lives here and
 * `apps/cli/src/__tests__/http-boundary-gate.test.ts` fails the build if any
 * module under `src/` re-introduces a raw `fetch(` or a `.json().catch(` outside
 * this file.
 *
 * ─── Why a timeout lives here too ───────────────────────────────────────────
 *
 * The same audit measured a hung backend taking **362 seconds** to fail. Only 3
 * of ~50 HTTP egress points in this CLI carried an `AbortSignal`. A CLI that
 * hangs for six minutes in CI is indistinguishable from a wedged runner, so the
 * bound belongs at the same boundary as the decode, not sprinkled per command.
 */

// Vendored, byte-checked copy of packages/wrapper-core/src/same-host-redirect.ts
// — this CLI does not depend on @evalguard/wrapper-core. See
// scripts/same-host-redirect-drift-gate.mjs.
import { followSameHostRedirects, isRedirectRefused } from "./same-host-redirect.js";

/** Stable machine code for a response that carries no usable result. */
export const INDETERMINATE_RESPONSE_CODE = "INDETERMINATE_UPSTREAM_RESPONSE" as const;

/**
 * Raised when the server answered 2xx but the body cannot be interpreted. Never
 * caught-and-defaulted inside this module: the whole point is that it escapes to
 * the command, which exits non-zero.
 */
export class IndeterminateResponseError extends Error {
  readonly code = INDETERMINATE_RESPONSE_CODE;
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IndeterminateResponseError";
    this.status = status;
  }
}

/**
 * Default per-request ceiling.
 *
 * 60s is deliberately generous. Every EvalGuard API route this CLI calls is a
 * request/response JSON endpoint — the long-running work (eval runs, scans) is
 * started by one call and observed by a POLL LOOP, so no single request needs
 * minutes. 60s is also 6x the 10s bound that `lib/cloud-client.ts` and
 * `commands/debug.ts` already impose and have shipped with, so it cannot break a
 * call those two already tolerate. What it does buy is turning the measured
 * 362-second hang into a bounded 60-second failure with a clear message.
 *
 * This is a CEILING, not a replacement: a call site that passes its OWN signal
 * keeps it, and the two are composed so the SHORTER deadline wins (see
 * `timedFetch`).
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

/** Operator override, in milliseconds. `0` (or `off`) disables the ceiling. */
export const HTTP_TIMEOUT_ENV = "EVALGUARD_HTTP_TIMEOUT_MS";

/**
 * Resolve the request ceiling from the environment.
 *
 * An unparseable or negative value falls back to the default rather than to
 * "unbounded": a typo in a CI env var must not silently remove the bound.
 */
export function resolveHttpTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[HTTP_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_TIMEOUT_MS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "off" || trimmed === "none" || trimmed === "0") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return n;
}

/**
 * The redirect rule EVERY request this CLI makes must carry.
 *
 * ─── Why (audit 2026-08-10) ────────────────────────────────────────────────
 *
 * WHATWG/undici `fetch` defaults to `redirect: "follow"`, so omitting this is
 * not neutral — it is the vulnerable setting, and it was omitted here. Measured
 * against the BUILT 3.8.0 CLI, with the configured backend answering a 302 whose
 * `Location` pointed at a second local server:
 *
 *   $ EVALGUARD_BASE_URL=http://127.0.0.1:<stub> evalguard moderation image \
 *       --org … --project … --url https://example.invalid/x.png
 *     clean (1.0%)
 *   $ echo $?
 *   0
 *
 * — for all five of 301/302/303/307/308. `clean (1.0%)` is a content-moderation
 * verdict about an image the responder never saw: 301/302/303 downgrade the POST
 * to a bodyless GET (0 bytes on the wire, measured), so the request payload is
 * never transmitted, and the redirect target's `{"flagged":false,"score":0.01}`
 * is rendered as the answer. All four verdict-bearing routes on this transport
 * did the same — `moderation image`, `voice deepfake-score`,
 * `data-boundary evaluate`, `guardrail-shadow evaluate` — 20 of 20 cells.
 *
 * 307 and 308 are worse than a bypass: they PRESERVE the body, so the content
 * being screened is re-POSTed verbatim to a host the RESPONSE chose. Measured,
 * the nonce-stamped payload arrived at the redirect target intact.
 *
 * This is the same defect class as the rest of this module. `decodeJsonBody`
 * refuses a body it cannot INTERPRET; a redirected verdict is perfectly
 * interpretable and simply not about the thing that was sent. Shape checking
 * cannot see it, which is why the refusal has to be at the transport.
 *
 * ─── Follow SAME-HOST only, refuse everything else (revised 2026-08-12) ────
 *
 * SEC-051 first shipped a blanket `redirect: "error"` here, on the reasoning
 * that "every URL this CLI builds is `resolveBaseUrl()` plus a fixed path, so a
 * legitimate 3xx does not exist on this transport". That reasoning was wrong on
 * the facts. `resolveBaseUrl` -> `normalizeBaseUrl` strips trailing slashes but
 * does NOT require https, and production answers this route with redirects:
 *
 *   POST https://evalguard.ai/api/v1/firewall/check/     -> 308 Location: /api/v1/firewall/check
 *   POST http://evalguard.ai/api/v1/firewall/check       -> 301 Location: https://…
 *   POST https://www.evalguard.ai/api/v1/firewall/check  -> 301 Location: https://evalguard.ai/…
 *
 * So `EVALGUARD_BASE_URL=http://evalguard.ai` — accepted by this CLI today —
 * became a hard-failing CLI on a patch upgrade.
 *
 * The rejected alternative in the original note was "follow same-ORIGIN only",
 * on the grounds that it is the comparison Go's stdlib gets wrong (hostname
 * without port). That objection is about the STDLIB'S comparison, not about the
 * rule: `lib/same-host-redirect.ts` implements the hop loop itself and compares
 * `URL.host`, which includes a non-default port. A cross-host hop is still
 * refused, and that is the case that re-transmits a payload to a location the
 * response chose.
 *
 * Enforced by `__tests__/redirect-verdict-gate.test.ts`.
 */

/**
 * `fetch` with a bounded deadline that follows SAME-HOST redirects only.
 *
 * A caller-supplied `signal` is COMPOSED with the ceiling rather than replaced,
 * so `debug.ts`'s explicit 10s still wins over the 60s default and a
 * user-cancellable controller still cancels. Passing `timeoutMs <= 0` disables
 * the ceiling entirely (the operator escape hatch), in which case the caller's
 * own signal, if any, is the only deadline. The deadline spans ALL hops, so a
 * same-host redirect chain cannot be used to extend the budget.
 *
 * `redirect: "manual"` is set inside `followSameHostRedirects`, spread LAST
 * after `init`. Order is the control: spread first it would be a default any
 * caller could override with one option — which is why the injected-fetch test
 * that passes `redirect: "follow"` still cannot re-enable following.
 *
 * The `timeoutMs <= 0` escape hatch used to `return fetchFn(input, init)` from a
 * separate early branch, and that branch is folded into the single call below
 * rather than given its own. An operator disabling a TIMEOUT must not quietly
 * disable the redirect rule with it, and a second exit past the check is exactly
 * how a check ends up fail-open beside a fail-closed neighbour.
 * `__tests__/redirect-verdict-gate.test.ts` asserts the `timeoutMs: 0` path
 * specifically.
 */
export async function timedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? resolveHttpTimeoutMs();

  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = typeof input === "string" || input instanceof URL ? url : "the EvalGuard API";

  // The unbounded branch shares this catch rather than returning early past it:
  // a redirect refusal has to be diagnosed identically whether or not an
  // operator turned the timeout off.
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const callerSignal = init.signal ?? (isRequest ? (input as Request).signal : undefined);
  const signal = timeout ? (callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout) : callerSignal;

  // A `Request` input carries its own method/headers/body, and dropping them
  // would silently turn a POST into a GET — the exact "verdict about text that
  // was never transmitted" defect this module exists to close. Its body is
  // buffered so it is REPLAYABLE across a same-host hop. No command passes a
  // Request today; `boundedFetch` is typed as `typeof fetch`, so one could.
  let effectiveInit: RequestInit = init;
  if (isRequest) {
    const req = input as Request;
    const buffered = req.body === null ? undefined : await req.arrayBuffer();
    effectiveInit = {
      method: req.method,
      headers: req.headers,
      ...(buffered !== undefined ? { body: buffered } : {}),
      ...init,
    };
  }

  try {
    return await followSameHostRedirects(
      url,
      { ...effectiveInit, ...(signal ? { signal } : {}) },
      { fetchImpl: fetchFn, label: target },
    );
  } catch (e) {
    // Node's bare "The operation was aborted due to timeout" names neither the
    // endpoint nor the knob, which is useless in a CI log. Only rewrite when
    // OUR timeout is the one that fired — a caller's own abort keeps its error.
    if (timeout?.aborted && (e as Error)?.name === "TimeoutError") {
      throw new Error(
        `Request to ${target} timed out after ${timeoutMs}ms and was aborted. ` +
          `Set ${HTTP_TIMEOUT_ENV} to raise the limit (or to 'off' to disable it).`,
      );
    }
    // A refusal from the hop loop already carries a full diagnosis (which host
    // it was sent to, which host it was redirected to, and why that is refused),
    // so it is re-thrown as-is rather than flattened into a generic message.
    if (isRedirectRefused(e)) throw e;
    // A caller-injected `fetchImpl` may implement `redirect: "error"` itself, in
    // which case undici reports a bare `TypeError: fetch failed` with the reason
    // buried in `cause`. Unexplained, an operator reads that as a network blip
    // and retries forever.
    if (isUndiciRedirectRefusal(e)) {
      throw new Error(
        `EvalGuard ${target} answered with an HTTP REDIRECT that this CLI refuses to follow. ` +
          `It follows a redirect only while the HOST is unchanged (a trailing-slash 308, an ` +
          `http->https upgrade); a redirect to a DIFFERENT host means the request was diverted ` +
          `— by a captive portal, a misconfigured proxy, or an attacker. Following it would send ` +
          `your content to a host chosen by the response and return that host's answer as an ` +
          `EvalGuard verdict. Check EVALGUARD_BASE_URL.`,
      );
    }
    throw e;
  }
}

/**
 * Is this the rejection an injected `redirect: "error"` transport produces?
 *
 * Matched on the CAUSE chain, not the top-level message: undici reports every
 * transport failure as `TypeError: fetch failed` and puts the reason in `cause`,
 * so a message match would either miss this or catch unrelated network errors.
 * Falls back to a message probe for non-undici `fetch` implementations (a test's
 * injected `fetchImpl`, or a polyfill) so the diagnosis is not silently lost.
 */
function isUndiciRedirectRefusal(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur !== null && cur !== undefined && depth < 5; depth++) {
    const msg = (cur as { message?: unknown })?.message;
    if (typeof msg === "string" && /unexpected redirect|redirect(s)? (are|is) not allowed|redirect mode/i.test(msg)) {
      return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return false;
}

/**
 * `timedFetch` narrowed to `typeof fetch`, so it is a DROP-IN replacement at the
 * ~25 call sites that either call `fetch(url, init)` directly or resolve
 * `const fetchFn = opts.fetchImpl ?? fetch`.
 *
 * That substitutability is the point: it makes "give every egress point a
 * deadline" a mechanical, reviewable change rather than 25 bespoke edits, and it
 * keeps the injectable-fetch test pattern working untouched (a test that passes
 * its own `fetchImpl` still bypasses this entirely).
 */
export const boundedFetch: typeof fetch = (input, init) =>
  timedFetch(input as string | URL | Request, init ?? {});

/**
 * Read a response body as JSON, FAIL CLOSED.
 *
 * Drop-in for the `await res.json().catch(() => null)` idiom this replaces, and
 * deliberately keeps that idiom's ERROR-path behaviour: on a non-2xx the parsed
 * body is returned best-effort (or `null`) so the caller's existing
 * `if (!res.ok) throw new Error(body.error.message ...)` still produces its
 * specific message. That path was already fail-closed — the caller throws.
 *
 * The SUCCESS path is where the bug lived, and every branch below now throws:
 *
 *   204 / empty body      → the server returned no result
 *   invalid JSON          → an HTML proxy error, a truncated body, a text/plain 500
 *   `null`                → JSON's null is not a result
 *   a bare primitive      → `"ok"` / `42` / `true` cannot carry a result payload
 *
 * Objects and arrays pass: `[]` is a legitimate empty list from a list endpoint,
 * and rejecting it would break every `runs`/`scans`/`traces` call on a fresh
 * project. The universal floor here matches
 * `packages/mcp-server/response-contract.ts`'s `enforceResponseContract`.
 *
 * @param endpoint human-readable label (`GET /evals`) used in the message only
 */
export async function decodeJsonBody(res: Response, endpoint: string): Promise<unknown> {
  let text: string | null;
  try {
    text = await res.text();
  } catch (e) {
    // Connection dropped mid-body. On the error path the caller is about to
    // throw anyway; on the success path this is indeterminate.
    if (!res.ok) return null;
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered ${res.status} but the connection dropped before the ` +
        `response body arrived (${(e as Error).message}), so the call could not be evaluated ` +
        `— treated as a failure, never as an empty or clean result.`,
      res.status,
    );
  }

  if (!res.ok) {
    // Best-effort so the caller can quote the server's own message.
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  if (res.status === 204 || text.trim() === "") {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered ${res.status} with an EMPTY body instead of a result ` +
        `payload, so the call could not be evaluated — treated as a failure, never as an ` +
        `empty or clean result.`,
      res.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered ${res.status} with a body that is not valid JSON ` +
        `(${describeBody(text)}), so the call could not be evaluated — treated as a failure, ` +
        `never as an empty or clean result. A proxy or gateway returning an HTML error page ` +
        `with a 200 status is the usual cause.`,
      res.status,
    );
  }

  if (parsed === null || parsed === undefined) {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered ${res.status} with a JSON \`null\` instead of a result ` +
        `payload, so the call could not be evaluated — treated as a failure, never as an ` +
        `empty or clean result.`,
      res.status,
    );
  }

  if (typeof parsed !== "object") {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered ${res.status} with a bare ${typeof parsed} instead of a ` +
        `result object, so the call could not be evaluated — treated as a failure, never as ` +
        `an empty or clean result.`,
      res.status,
    );
  }

  return parsed;
}

/**
 * First ~60 chars of an unparseable body, with newlines collapsed, for the
 * diagnostic above. Truncated deliberately: an error body can echo the caller's
 * own prompt text, and this string lands in CI logs.
 */
function describeBody(text: string): string {
  // Slice BEFORE the regex. Only the first 60 characters are ever shown, and
  // the fault-mode matrix drives a 2 MB body through here — running a global
  // whitespace collapse across two megabytes to then discard all but 60 bytes
  // is pure waste on the exact path that is already the slowest failure. The
  // 2000-character window is far wider than the 60 needed, so a body whose
  // leading run is all whitespace still yields the same string.
  const flat = text.slice(0, 2000).replace(/\s+/g, " ").trim();
  const head = flat.slice(0, 60);
  return flat.length > 60 || text.length > 2000 ? `starts with: ${head}…` : `body: ${head}`;
}

// ─── The `{ success, data }` envelope ───────────────────────────────────────
//
// `decodeJsonBody` above proves the server sent SOMETHING structured. It cannot
// prove the something is this endpoint's answer, and two shapes slipped through
// it in the measured sweep:
//
//   {"success":true,"data":null}         → unwrapped to null → "No eval runs
//                                          found for this project." EXIT 0
//   {"success":false,"error":{…}} + 200  → unwrapped to the envelope itself,
//                                          which then failed messily downstream
//                                          ("Eval Runs (undefined)", "rows is
//                                          not iterable")
//
// This mirrors `unwrapApiEnvelope` in packages/mcp-server/response-contract.ts
// deliberately — that contract is already shipped and reasoned about, and a
// second, subtly-different envelope rule in the CLI is how the two drift.

/**
 * `Object.hasOwn`, captured at module load.
 *
 * `obj[key]` and `key in obj` BOTH walk the prototype chain, so a single
 * prototype-pollution primitive in this process would let an EMPTY 200 body
 * present a complete envelope (`Object.prototype.data = []` ⇒ "the server sent
 * an empty list"). The point of this module is that the SERVER sent the payload;
 * a value the runtime synthesised from Object.prototype is the counter-example.
 * Captured early because the obvious counter-move is to overwrite
 * `Object.prototype.hasOwnProperty`.
 */
const OWN: (obj: object, key: string) => boolean = (() => {
  const hasOwn = (Object as { hasOwn?: (o: object, k: PropertyKey) => boolean }).hasOwn;
  if (typeof hasOwn === "function") return (obj, key) => hasOwn(obj, key);
  const hop = Object.prototype.hasOwnProperty;
  return (obj, key) => hop.call(obj, key);
})();

function readOwn(obj: object, key: string): unknown {
  return OWN(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Unwrap the standard `{ success, data }` envelope every
 * `apps/web/src/app/api/v1/**` route returns, tolerating a raw un-enveloped
 * payload for forward/backward compatibility.
 *
 * A `success: false` envelope arriving with a 2xx is an upstream FAILURE that
 * the transport happened to dress as success; it is raised, never returned.
 * A `success: true` envelope whose `data` is null/absent is indeterminate — the
 * server claimed success and then sent no result.
 */
export function unwrapApiEnvelope(body: unknown, endpoint: string): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  if (!OWN(body, "success")) return body;

  const success = readOwn(body, "success");
  if (success === false) {
    const err = readOwn(body, "error");
    const detail =
      err !== null && typeof err === "object"
        ? String(readOwn(err as object, "message") ?? readOwn(err as object, "code") ?? "unspecified")
        : String(err ?? "unspecified");
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered 2xx carrying an error envelope (success:false, ${detail}). ` +
        `The call FAILED upstream — reported as an error, never as an empty or clean result.`,
      200,
    );
  }

  if (success === true) {
    if (!OWN(body, "data")) {
      throw new IndeterminateResponseError(
        `EvalGuard ${endpoint} answered 2xx with a success envelope carrying no \`data\` field, ` +
          `so the call produced no result — treated as a failure, never as an empty or clean result.`,
        200,
      );
    }
    const data = readOwn(body, "data");
    if (data === null || data === undefined) {
      throw new IndeterminateResponseError(
        `EvalGuard ${endpoint} answered 2xx with \`data: null\`, so the call produced no result ` +
          `— treated as a failure, never as an empty or clean result.`,
        200,
      );
    }
    return data;
  }

  return body;
}

/**
 * Assert the unwrapped payload really is a list before a caller iterates it.
 *
 * Replaces the `unwrap<T[]>(body) ?? []` idiom, whose `?? []` turned "the server
 * sent something that is not a list" into "the list is empty" — and whose
 * absence produced the raw `Error: rows is not iterable` a user actually saw.
 */
export function expectArray(value: unknown, endpoint: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new IndeterminateResponseError(
    `EvalGuard ${endpoint} answered 2xx but its result is ${describeShape(value)} where a list ` +
      `was expected, so the call could not be read — treated as a failure, never as an empty list.`,
    200,
  );
}

/**
 * Read a named field whose value may LEGITIMATELY be null.
 *
 * `evalguard agent-memory governance get` is the motivating case: the route
 * answers `{ policy: <policy> | null }` and a null policy is a REAL state ("no
 * governance policy is configured"). So `null` cannot be refused here the way
 * `expectArrayField` refuses a missing list.
 *
 * What can still be refused is the KEY being absent. The route always sends
 * `policy`; a body without it is not that route's answer. Distinguishing "the
 * server said null" from "the server never mentioned it" is the entire control
 * — `body?.policy ?? null` collapses both into null, which is how a 200 carrying
 * `{"hello":"world"}` rendered as "No governance policy set — memory writes are
 * ungoverned." and exited 0.
 */
export function expectField(value: unknown, field: string, endpoint: string): unknown {
  const obj = expectObject(value, endpoint);
  if (!OWN(obj, field)) {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered 2xx with ${describeShape(value)}, which carries no ` +
        `\`${field}\` field at all — this endpoint always sends one (even when its value is ` +
        `null), so the body is not its answer and the result could not be read. An absent ` +
        `field is NOT the same answer as an explicit null.`,
      200,
    );
  }
  return readOwn(obj, field);
}

/**
 * Read a named LIST field off an unwrapped payload, fail closed.
 *
 * Added 2026-08-08 after the per-command matrix. `decodeJsonBody` +
 * `unwrapApiEnvelope` closed "the body is unreadable", but a second idiom
 * survived at the consumers and reopened the same hole one level in:
 *
 *     const data = unwrap<{ traces?: T[] }>(body);
 *     return data?.traces ?? [];        // ← `{"hello":"world"}` ⇒ "No traces found."
 *
 * `?.` and `??` are individually reasonable and together they convert "this is
 * not the endpoint's answer" into "the answer is empty" — exactly the fail-open
 * this module exists to stop, just spelled with optional chaining instead of a
 * catch. Measured: `evalguard traces` and `evalguard scorers` both exited 0 with
 * their empty state against a 200 carrying `{"hello":"world"}`.
 *
 * An ABSENT field is refused for the same reason a `null` body is: a route that
 * always sends `{ traces }` did not send it, so this is not that route's answer.
 */
export function expectArrayField(
  value: unknown,
  field: string,
  endpoint: string,
): unknown[] {
  const obj = expectObject(value, endpoint);
  if (!OWN(obj, field)) {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered 2xx with ${describeShape(value)}, which carries no ` +
        `\`${field}\` — this endpoint always sends one, so the body is not its answer and its ` +
        `contents could not be read (treated as a failure, never as an empty list).`,
      200,
    );
  }
  const list = readOwn(obj, field);
  if (Array.isArray(list)) return list;
  throw new IndeterminateResponseError(
    `EvalGuard ${endpoint} answered 2xx but its \`${field}\` is ${describeShape(list)} where a ` +
      `list was expected, so the call could not be read — treated as a failure, never as an ` +
      `empty list.`,
    200,
  );
}

/** Assert the unwrapped payload is a keyed object before a caller reads fields off it. */
export function expectObject(value: unknown, endpoint: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new IndeterminateResponseError(
    `EvalGuard ${endpoint} answered 2xx but its result is ${describeShape(value)} where a result ` +
      `object was expected, so the call could not be read — treated as a failure, never as an ` +
      `empty or clean result.`,
    200,
  );
}

/**
 * Read a named NUMBER field off an unwrapped payload, fail closed.
 *
 * ADDED 2026-08-09. This one exists because of a specific printed string:
 *
 *     $ evalguard moderation image --org … --project … --url https://…
 *       clean (NaN%)
 *     $ echo $?
 *     0
 *
 * measured against a backend answering HTTP 200 with
 * `{"success":false,"error":{"message":"vision provider timed out"}}`. The
 * command read `result.score` off a body that had no score, and
 * `(undefined * 100).toFixed(1)` produced the string "NaN" — so an
 * ACKNOWLEDGED upstream failure was rendered as a clean content-moderation
 * verdict. `voice deepfake` printed `likely genuine (NaN% synthetic)` the same
 * way.
 *
 * `NaN` in a security verdict is never a value; it is the trace of a missing
 * one. A score that is absent, null, non-numeric or non-finite is refused here
 * so it can never reach a formatter.
 */
export function expectNumberField(value: unknown, field: string, endpoint: string): number {
  const raw = expectField(value, field, endpoint);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  throw new IndeterminateResponseError(
    `EvalGuard ${endpoint} answered 2xx but its \`${field}\` is ${describeShape(raw)} where a ` +
      `finite number was expected, so the result could not be read — treated as a failure, ` +
      `never formatted into a verdict. (An absent or unreadable score renders as "NaN%", ` +
      `which reads to a human as a real measurement.)`,
    200,
  );
}

/**
 * Read a named BOOLEAN field off an unwrapped payload, fail closed.
 *
 * The companion to `expectNumberField` for the VERDICT itself: `flagged`,
 * `synthetic`, `available`, `allow`. `undefined` is falsy, so a missing verdict
 * field renders as the SAFE-LOOKING branch of every ternary in this CLI —
 * "clean", "likely genuine", "no scorecard available". Absence must not be
 * spendable as a negative.
 */
export function expectBooleanField(value: unknown, field: string, endpoint: string): boolean {
  const raw = expectField(value, field, endpoint);
  if (typeof raw === "boolean") return raw;
  throw new IndeterminateResponseError(
    `EvalGuard ${endpoint} answered 2xx but its \`${field}\` is ${describeShape(raw)} where a ` +
      `boolean verdict was expected, so the result could not be read — treated as a failure. ` +
      `A missing verdict field is falsy, and every renderer in this CLI spells falsy as the ` +
      `reassuring branch.`,
    200,
  );
}

/**
 * THE replacement for `const result = body.data ?? (body as unknown as T)`.
 *
 * ADDED 2026-08-09, after the 47 x 15 matrix found 48 fail-open cells across 9
 * commands that the 2026-08-08 boundary did not reach. `decodeJsonBody` proved
 * the body was structured and `unwrapApiEnvelope` handled `success:false` /
 * `data:null` — but only for the callers that USED them. Thirteen call sites
 * instead wrote:
 *
 *     const result = body.data ?? (body as unknown as T);
 *
 * which is a fail-open in three separate ways at once:
 *
 *   1. it never calls `unwrapApiEnvelope`, so `{"success":false,"error":{…}}`
 *      arriving with a 200 is CAST to the result type and rendered;
 *   2. `?? (body as T)` makes an unrelated 200 (`{"hello":"world"}`) the result;
 *   3. `{"success":true,"data":{}}` is truthy, so an empty object becomes the
 *      result and every field reads `undefined`.
 *
 * A TypeScript cast is not a check — `as unknown as T` asserts the shape to the
 * compiler and verifies nothing at runtime, which is precisely why
 * `tsc --noEmit` was green the whole time `clean (NaN%)` was shipping.
 *
 * So: unwrap the envelope, assert a result OBJECT, and assert the fields the
 * renderer is about to read are actually present. `required` is the command's
 * contract with its route, written down where a reviewer can see it; all
 * missing fields are reported at once so a caller fixes one round-trip, not
 * five.
 */
export function expectResult<T = Record<string, unknown>>(
  body: unknown,
  endpoint: string,
  required: readonly string[] = [],
): T {
  const obj = expectObject(unwrapApiEnvelope(body, endpoint), endpoint);
  const missing = required.filter((f) => !OWN(obj, f));
  if (missing.length > 0) {
    throw new IndeterminateResponseError(
      `EvalGuard ${endpoint} answered 2xx with ${describeShape(obj)}, which is missing ` +
        `${missing.map((m) => `\`${m}\``).join(", ")} — this endpoint always sends ` +
        `${missing.length === 1 ? "that field" : "those fields"}, so the body is not its answer ` +
        `and the result could not be read (treated as a failure, never as an empty or default ` +
        `result).`,
      200,
    );
  }
  return obj as T;
}

/* ─── artifact-body boundary ──────────────────────────────────────────────── */

/**
 * The `--format` values `ai-bom export` accepts. The command parses its
 * argument against this list and `AI_BOM_MARKERS` is keyed by it, so the set
 * the CLI advertises and the set that has a contract are the SAME set — a
 * fourth format cannot be advertised without one.
 */
export const AI_BOM_FORMATS = ["cyclonedx", "spdx", "json"] as const;

/** A format `ai-bom export --format` accepts. */
export type AiBomFormat = (typeof AI_BOM_FORMATS)[number];

/**
 * The ONLY accept-list `ai-bom export` may parse its `--format` against.
 *
 * A second hand-written list (`fmt !== "cyclonedx" && fmt !== "spdx" && …`) is
 * how a format gets advertised that has no contract to validate it against —
 * which lands it in `readArtifactBody`'s `contract === undefined` refusal at
 * best, and, if someone "fixes" that by loosening the boundary, back at the
 * 502-page-written-as-an-SBOM defect at worst.
 */
export function isAiBomFormat(value: string): value is AiBomFormat {
  return (AI_BOM_FORMATS as readonly string[]).includes(value);
}

/**
 * One required field of an AI-BOM document contract.
 *
 * DATA, not a predicate. A contract expressed as a callback can be written as
 * `() => {}` and still typecheck, and the gate could only ever prove it was
 * called; expressed as rules, `__tests__/ai-bom-contract-gate.test.ts` can
 * assert that every contract names a marker and a structural field, and can
 * mutate a real document per rule to prove each one bites.
 */
export type AiBomFieldRule =
  /** A non-empty string whose VALUE must equal `equals` — the standard's marker. */
  | { readonly key: string; readonly kind: "marker"; readonly equals: string }
  /** A non-empty string; value unconstrained. */
  | { readonly key: string; readonly kind: "string" }
  /** An array. Empty is allowed — a project with no inventory is a real answer. */
  | { readonly key: string; readonly kind: "array" }
  /** Present as an OWN key; shape unconstrained. */
  | { readonly key: string; readonly kind: "present" };

/** What a document must satisfy to be accepted as THIS format's AI-BOM. */
export interface AiBomContract {
  /** The `--format` this contract belongs to; must equal its key in `AI_BOM_MARKERS`. */
  readonly format: AiBomFormat;
  /** Human name of the standard, for the refusal message. */
  readonly standard: string;
  /**
   * True when the route delivers this format inside this API's `{success,data}`
   * envelope rather than as a bare document. Only the native `json` format is
   * (route.ts returns `apiSuccess(buildNativeAiBom(input))` for it and a bare
   * `NextResponse` for the other two).
   */
  readonly enveloped: boolean;
  /** Fields the document must carry. At least one is a `marker`. */
  readonly require: readonly AiBomFieldRule[];
}

/**
 * The per-format AI-BOM document CONTRACT — what the route's answer must
 * satisfy before the CLI is willing to write it to disk.
 *
 * ─── Why this is per-format, and not one `bomFormat` value (2026-08-09) ────
 *
 * Until `45f06d350` the route built ONE object for all three formats and
 * varied a single string on it (`route.ts`: `bomFormat: format === "cyclonedx"
 * ? "CycloneDX" : format === "spdx" ? "SPDX-2.3" : "EvalGuard-AIBOM"`), so one
 * rule — `bomFormat` + `specVersion` + `components` — covered all three. That
 * document was conformant to NEITHER standard, and the fix made it three
 * documents (apps/web/src/app/api/v1/ai-sbom/_formats.ts).
 *
 * SPDX 2.3's root is `additionalProperties: false` with
 * `required: ["SPDXID","creationInfo","dataLicense","name","spdxVersion"]`. A
 * CONFORMANT SPDX document therefore CANNOT carry `bomFormat`, `specVersion`
 * or `components` — measured, not argued: putting `bomFormat` back made the
 * schema gate report `property "bomFormat" is not allowed`. The old single
 * rule and SPDX 2.3 are mutually exclusive BY SCHEMA, so the only document
 * that could have satisfied both is an SPDX document that is not SPDX.
 *
 * The answer is neither to loosen the check nor to smuggle CycloneDX keys into
 * an SPDX file — `274d40a40` added this boundary because `ai-bom export` was
 * writing nginx 502 pages to disk as SBOMs, and a validator that waves SPDX
 * through re-opens that hole in a new place. The answer is to teach it the
 * second standard. Each format names the fields that make a document THAT
 * standard's document, including a MARKER whose value is checked, which is
 * what stops a CycloneDX export being filed under `--format spdx`.
 *
 * `cyclonedx` and `json` are unchanged by this rewrite: same three fields,
 * same marker values, same messages. Only `spdx` swaps its rule set.
 */
export const AI_BOM_MARKERS: Record<AiBomFormat, AiBomContract> = {
  /**
   * CycloneDX 1.6 (`bom-1.6.schema.json`): root `required` is
   * `["bomFormat","specVersion"]`, the `bomFormat` enum is `["CycloneDX"]`,
   * and `components` is where the inventory lives.
   */
  cyclonedx: {
    format: "cyclonedx",
    standard: "CycloneDX",
    enveloped: false,
    require: [
      { key: "bomFormat", kind: "marker", equals: "CycloneDX" },
      { key: "specVersion", kind: "string" },
      { key: "components", kind: "present" },
    ],
  },
  /**
   * SPDX 2.3 (`spdx-schema.json`, spdx-spec tag v2.3): `spdxVersion` is the
   * marker — it is the field SPDX itself uses to declare the version, and the
   * only one whose value identifies the standard — `SPDXID` is the document
   * element id (`SPDXRef-DOCUMENT`), and `packages` is where the inventory
   * lives. `packages` must be an ARRAY: the pre-fix document's `components`
   * was an object, which is the shape error that made it non-conformant, so
   * requiring mere presence here would accept the same class of defect.
   */
  spdx: {
    format: "spdx",
    standard: "SPDX 2.3",
    enveloped: false,
    require: [
      { key: "spdxVersion", kind: "marker", equals: "SPDX-2.3" },
      { key: "SPDXID", kind: "string" },
      { key: "packages", kind: "array" },
    ],
  },
  /**
   * The native document — not a standards document and never claimed to be.
   * It is the one format the route delivers inside `{success,data}`.
   */
  json: {
    format: "json",
    standard: "EvalGuard-AIBOM",
    enveloped: true,
    require: [
      { key: "bomFormat", kind: "marker", equals: "EvalGuard-AIBOM" },
      { key: "specVersion", kind: "string" },
      { key: "components", kind: "present" },
    ],
  },
};

/**
 * Human detail for a NON-2xx response, read through the boundary.
 *
 * The three artifact commands each hand-rolled this as `await res.json()` →
 * catch → `await res.text()`, which is why they needed a `res.text()` exemption
 * in the gate for their ERROR path as well as their success path. Reading the
 * body ONCE, here, is what lets that exemption be deleted outright rather than
 * narrowed.
 *
 * Whitespace is collapsed and the excerpt truncated: an error body can be 2 MB
 * of filler or an HTML page, and this string lands in a CI log.
 *
 * Returns "" when there is nothing quotable, so callers can append it directly.
 */
export async function readErrorDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  if (raw.trim() === "") return "";
  try {
    const j = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    if (j !== null && typeof j === "object" && OWN(j, "error")) {
      return ` (${j.error?.code ?? "ERROR"}: ${j.error?.message ?? "unknown"})`;
    }
  } catch {
    // not JSON — fall through to the truncated raw excerpt
  }
  return ` — ${raw.replace(/\s+/g, " ").trim().slice(0, 400)}`;
}

/**
 * What an artifact body is expected to look like.
 *
 * `ai-bom` is one entry because it is one BOUNDARY; which of the three
 * standards the body must satisfy comes from the `contract` the caller passes
 * — see `AI_BOM_MARKERS`.
 */
export type ArtifactFormat = "ai-bom" | "csv" | "ndjson";

/**
 * `readArtifactBody` options.
 *
 * The `ai-bom` arm requires `contract`, so "validate this as an AI-BOM but
 * don't say which standard" does not compile. That is the type half of the
 * new-format gate; `__tests__/ai-bom-contract-gate.test.ts` is the runtime
 * half, and the function still refuses at runtime if a cast smuggles one past.
 */
export type ArtifactReadOptions = {
  /** Route description for the error message, e.g. "GET /ai-sbom?format=spdx". */
  endpoint: string;
  /** Noun for the message, e.g. "AI-BOM" / "cost export". */
  what: string;
  /**
   * Accept a zero-byte body. Only for a route DOCUMENTED to emit one, and only
   * when the caller has independent proof the bytes came from that route (see
   * `cost-export`'s `x-evalguard-export-format` check and `datasets export`'s
   * `X-Case-Count`) — otherwise this re-opens the "✓ Wrote 0 bytes" hole it
   * exists to close.
   */
  allowEmpty?: boolean;
} & (
  // Expressed via `ArtifactFormat` rather than by re-listing the literals, so
  // adding an artifact kind lands in one of these two arms deliberately —
  // "does this one need a document contract?" — instead of the union quietly
  // drifting out of step with the switch below.
  | { format: Extract<ArtifactFormat, "ai-bom">; contract: AiBomContract }
  | { format: Exclude<ArtifactFormat, "ai-bom">; contract?: never }
);

/**
 * Read a response body that is a DOCUMENT, fail closed.
 *
 * ─── Why this is not `decodeJsonBody` ──────────────────────────────────────
 *
 * `decodeJsonBody` is the wrong tool for a body that is a CycloneDX document, a
 * FOCUS billing CSV or a dataset export rather than this API's `{success,data}`
 * envelope. The 2026-08-08 pass recognised that and granted `ai-bom.ts`,
 * `cost-export.ts` and `datasets.ts` a `res.text()` exemption in
 * `__tests__/http-boundary-gate.test.ts`.
 *
 * The reason was right and the consequence was not: exempting them from the
 * ENVELOPE decode exempted them from ALL validation, and what they did with the
 * bytes was `await res.text()` straight into `fs.writeFileSync`. Measured on the
 * built 3.8.0 CLI, 11 of 14 fault modes produced a successful export, exit 0:
 *
 *     $ evalguard ai-bom export <uuid> --out bom.cdx.json
 *       ✓ Wrote 27 bytes …      body was `this is not JSON at all {{{`
 *       ✓ Wrote 0 bytes …       body was empty (and again for a 204)
 *       ✓ Wrote 4 bytes …       body was `null`
 *       ✓ Wrote 157 bytes …     body was an nginx 502 page
 *       ✓ Wrote 2097152 bytes … body was 2 MB of filler
 *
 * — followed by `• Validate: cyclonedx validate --input-file <that file>`. An
 * SBOM is a supply-chain artifact an auditor consumes and a compliance process
 * archives; a 502 page filed as one is the worst available outcome and a 0-byte
 * file reported as a successful export is the second. `cost-export` had the
 * identical shape, and with no `--out` streamed the same bytes to stdout, which
 * the README documents piping into a FinOps ingest.
 *
 * So the artifact path gets its own boundary rather than an exemption. Refusals,
 * in order:
 *   • a 204 or an empty/whitespace-only body — unless `allowEmpty`, which the
 *     caller may only set with independent proof the bytes came from the route;
 *   • a body starting with `<` — an HTML/XML error page;
 *   • this API's error envelope, and its success envelope for every format not
 *     itself delivered enveloped;
 *   • anything that does not satisfy `format`.
 *
 * The caller gets the exact bytes the server sent, unmodified: this validates,
 * it never rewrites, because re-serialising a signed document would break it.
 */
export async function readArtifactBody(
  res: Response,
  opts: ArtifactReadOptions,
): Promise<string> {
  const what = opts.what;
  const contract: AiBomContract | undefined = opts.format === "ai-bom" ? opts.contract : undefined;
  const refuse = (why: string): never => {
    throw new IndeterminateResponseError(
      `EvalGuard ${opts.endpoint} answered ${res.status} but ${why}, so the ${what} was NOT ` +
        `written — an unreadable or non-conforming artifact is an error, never a successful ` +
        `export.`,
      res.status,
    );
  };

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return refuse(`the connection dropped before the body arrived (${(e as Error).message})`);
  }

  if (res.status === 204 || text.trim() === "") {
    if (opts.allowEmpty && res.status !== 204) return text;
    return refuse(`the body is EMPTY (${text.length} bytes)`);
  }

  const head = text.trimStart();
  if (head.startsWith("<")) {
    return refuse(
      `the body is markup, not the ${what} (${describeBody(text)}) — a proxy or gateway ` +
        `returning an HTML error page with a 2xx status is the usual cause`,
    );
  }

  // The API envelope, checked BEFORE the per-format rules so `{"success":false,…}`
  // reports the SERVER'S OWN message rather than a generic "not a valid document".
  //
  // `ai-bom --format json` is the one case where the envelope IS the delivery
  // vehicle: the route returns `apiSuccess(sbom)` for json and a bare document
  // for cyclonedx/spdx. A success envelope is therefore unwrapped-and-checked
  // there and refused everywhere else.
  if (head.startsWith("{")) {
    let asJson: unknown;
    try {
      asJson = JSON.parse(text) as unknown;
    } catch {
      asJson = undefined;
    }
    if (asJson !== null && typeof asJson === "object" && OWN(asJson, "success")) {
      const success = readOwn(asJson, "success");
      if (success === false) {
        const err = readOwn(asJson, "error");
        const detail =
          err !== null && typeof err === "object"
            ? String(readOwn(err as object, "message") ?? readOwn(err as object, "code") ?? "unspecified")
            : String(err ?? "unspecified");
        return refuse(`it carries an ERROR envelope instead of the ${what} (success:false, ${detail})`);
      }
      if (contract === undefined || !contract.enveloped) {
        return refuse(
          `it carries this API's \`{success,data}\` envelope instead of the ${what} itself`,
        );
      }
      const data = OWN(asJson, "data") ? readOwn(asJson, "data") : undefined;
      if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
        return refuse(`its \`data\` is ${describeShape(data)} where the ${what} document was expected`);
      }
      checkAiBom(data as Record<string, unknown>, contract, refuse);
      return text;
    }
  }

  switch (opts.format) {
    case "ai-bom": {
      // Unreachable through `ArtifactReadOptions`, which makes `contract`
      // required on this arm. Kept as a REFUSAL rather than an assertion so a
      // cast that smuggles one past the type system still fails closed — the
      // whole module exists because "could not interpret" must not read as OK.
      if (contract === undefined) {
        return refuse(`no AI-BOM format contract was supplied to validate it against`);
      }
      const doc = parseJsonDoc(text, refuse, "AI-BOM");
      checkAiBom(doc, contract, refuse);
      return text;
    }
    case "csv": {
      if (head.startsWith("{") || head.startsWith("[")) {
        return refuse(`the body is JSON, not the CSV that this ${what} should be`);
      }
      const header = text.split(/\r?\n/).find((l) => l.trim() !== "");
      // A FinOps interchange CSV (FOCUS 1.0) is columnar by definition; a
      // single-token first line is a scalar or an error string, not a header.
      if (!header || !header.includes(",") || header.split(",").length < 2) {
        return refuse(
          `its first line is not a comma-separated header row (${describeBody(header ?? "")}), so ` +
            `the body is not the CSV this ${what} should be`,
        );
      }
      return text;
    }
    case "ndjson": {
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length === 0) return refuse(`it contains no NDJSON records`);
      for (const [i, line] of lines.entries()) {
        let rec: unknown;
        try {
          rec = JSON.parse(line) as unknown;
        } catch {
          return refuse(
            `line ${i + 1} is not valid JSON (${describeBody(line)}) — NDJSON requires one JSON ` +
              `object per line`,
          );
        }
        if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
          return refuse(`line ${i + 1} is ${describeShape(rec)} where an NDJSON record was expected`);
        }
        // `{}` IS an object, so the check above waved it through and this arm
        // was the one artifact format still fail-open after the 2026-08-09
        // pass. Measured on the built 3.8.0 CLI against a 200 carrying `{}`:
        //
        //     $ evalguard cost-export <org> --format openmeter --out cost.ndjson
        //       ✓ Wrote 2 bytes to cost.ndjson                    EXIT 0
        //       OpenMeter CloudEvents NDJSON — POST these to /api/v1/events
        //
        // Two bytes of nothing filed as an org's billing record, with
        // instructions to POST it into a metering system. A record with no
        // fields carries no cost, no event and no dataset case; it is the
        // NDJSON spelling of the empty AI-BOM document `checkAiBom` already
        // refuses, and it is refused here for the same reason.
        if (Object.keys(rec as Record<string, unknown>).length === 0) {
          return refuse(
            `line ${i + 1} carries no fields — an empty record holds no data, so the body is not ` +
              `the ${what} it claims to be`,
          );
        }
      }
      return text;
    }
  }
}

/**
 * Enforce one format's AI-BOM contract against a parsed document.
 *
 * The marker rule is what makes `--format spdx` MEAN something: a document
 * carrying the other standard's marker is refused rather than filed under the
 * wrong standard. The remaining rules are what keep a body that merely happens
 * to contain the marker string from passing.
 *
 * Every fault body in the matrix — invalid JSON, empty, a 204, `null`, `"ok"`,
 * `{}`, `{"hello":"world"}`, an nginx 502 page, 2 MB of filler, and the OTHER
 * two formats' valid documents — fails at least one rule of every contract.
 * `__tests__/ai-bom-contract-gate.test.ts` re-measures that per format per
 * fault, and fails if any contract stops rejecting any of them.
 *
 * Reads go through `readOwn`/`OWN`, never `doc[key]` or `key in doc`: both walk
 * the prototype chain, so a prototype-pollution primitive in-process could
 * otherwise supply `spdxVersion` or `packages` that the SERVER never sent.
 */
function checkAiBom(
  doc: Record<string, unknown>,
  contract: AiBomContract,
  refuse: (why: string) => never,
): void {
  if (Object.keys(doc).length === 0) {
    return refuse(`the document is an EMPTY object, which carries no inventory`);
  }
  for (const rule of contract.require) {
    switch (rule.kind) {
      case "marker": {
        const value = readOwn(doc, rule.key);
        if (typeof value !== "string" || value === "") {
          return refuse(
            `it declares no \`${rule.key}\`, so it is not the ${contract.standard} document ` +
              `\`--format ${contract.format}\` asked for`,
          );
        }
        if (value !== rule.equals) {
          return refuse(
            `its \`${rule.key}\` is "${value}" but "${rule.equals}" was requested — the file would ` +
              `be archived under the wrong standard`,
          );
        }
        break;
      }
      case "string": {
        const value = readOwn(doc, rule.key);
        if (typeof value !== "string" || value === "") {
          return refuse(`it declares no \`${rule.key}\``);
        }
        break;
      }
      case "array": {
        if (!OWN(doc, rule.key)) {
          return refuse(`it carries no \`${rule.key}\` block, so there is no inventory to attest`);
        }
        const value = readOwn(doc, rule.key);
        if (!Array.isArray(value)) {
          return refuse(
            `its \`${rule.key}\` is ${describeShape(value)} where ${contract.standard} requires an ` +
              `array, so the inventory is not the shape the standard defines`,
          );
        }
        break;
      }
      case "present": {
        if (!OWN(doc, rule.key)) {
          return refuse(`it carries no \`${rule.key}\` block, so there is no inventory to attest`);
        }
        break;
      }
    }
  }
}

/** Shared JSON-document parse for `readArtifactBody`; never returns null/array/primitive. */
function parseJsonDoc(
  text: string,
  refuse: (why: string) => never,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refuse(
      `the body is not valid JSON (${describeBody(text)}), so it cannot be a ${label} document`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse(`the body is ${describeShape(parsed)} where a ${label} document was expected`);
  }
  return parsed as Record<string, unknown>;
}

/** Structural summary for diagnostics — key NAMES only, never values. */
export function describeShape(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `an array(${v.length})`;
  const t = typeof v;
  if (t !== "object") return `a ${t}`;
  const keys = Object.keys(v as Record<string, unknown>);
  const shown = keys.slice(0, 12);
  return `an object{${shown.join(",")}${keys.length > shown.length ? ",…" : ""}}`;
}

/**
 * Issue a bounded-time JSON request against the EvalGuard API and decode it
 * fail-closed. The convenience wrapper new code should reach for; the two older
 * shared clients (`lib/cloud-client.ts`, `commands/server-read.ts`) compose
 * `timedFetch` + `decodeJsonBody` directly because they layer their own error
 * envelopes on top.
 */
export async function requestJson(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const label = opts.endpoint ?? `${opts.method ?? "GET"} ${opts.url}`;
  const res = await timedFetch(
    opts.url,
    {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs },
  );
  return decodeJsonBody(res, label);
}
