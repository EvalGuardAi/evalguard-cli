/**
 * The ONE way to build a fake HTTP response in this package's tests.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Eleven test files independently grew the same double:
 *
 *     { ok: true, status: 200, json: async () => body } as Response
 *
 * That cast asserts a shape the object does not have. `Response` is ~15 members;
 * the double implemented one. It worked only because the code under test also
 * happened to call just `.json()`.
 *
 * When the CLI's HTTP decode moved to the shared fail-closed boundary
 * (`src/lib/http.ts`, audit 2026-08-08), the boundary began reading `res.text()`
 * — it MUST, because `.json()` alone cannot distinguish
 *
 *     an EMPTY body   from   `null`   from   a truncated/HTML non-JSON body,
 *
 * and collapsing those three into "nothing" is the exact fail-open being fixed:
 * `evalguard runs` printed "No eval runs found for this project." and exited 0
 * against a backend answering `200` + `this is not JSON at all {{{`.
 *
 * Every one of those eleven doubles then threw `res.text is not a function` —
 * 44 tests. The tempting fix was to teach the boundary to fall back to
 * `.json()`. That would be backwards: it adds a SECOND decode path to a security
 * boundary, dead in production (undici's `Response` always has `.text()`), kept
 * fail-closed forever by hand, and it would preserve the real defect — that the
 * doubles do not behave like what the shipped CLI actually receives.
 *
 * So the doubles were made real instead. These are genuine `Response` objects,
 * which means a test asserting "the command handles this body" now asserts it
 * about the same bytes-to-JSON path production uses.
 *
 * Kept in one module so the next test does not re-derive a half-`Response`.
 * Lives under `__tests__/` so it is never bundled into `dist/`, and vitest's
 * default include (`*.test.ts`) does not collect it as a suite.
 */

/** Serialise `body` as a real JSON `Response`. `status` drives `res.ok`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A `fetch` double that always answers with `jsonResponse(body, status)`.
 *
 * Typed as `typeof fetch` so it drops into the `fetchImpl` seam the CLI's API
 * helpers expose, without a cast at the call site.
 */
export function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => jsonResponse(body, status)) as unknown as typeof fetch;
}
