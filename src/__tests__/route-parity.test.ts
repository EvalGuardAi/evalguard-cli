/**
 * GATE: every CLI request path resolves to a route handler in `apps/web`.
 *
 * `evalguard logs list` shipped in `6879c5d64` (PR #1012, 2026-07-08) calling
 * `GET /logs`. No `apps/web/src/app/api/v1/logs/` route has ever existed, so
 * every invocation landed on `api/v1/[...catch]/route.ts` — a hard 404 — in a
 * published npm package, for a month. Measured against a served build, the
 * exact request the command sent returned:
 *
 *     GET /api/v1/logs?projectId=…&metadata_search=…&include_raw=true
 *     -> HTTP 404  {"error":"Not found"}
 *
 * The suite covering that command was green throughout, because it drove the
 * command against a stub `fetchImpl` that answers every request. A test that
 * asks "did we send what we meant to send" can never notice that nothing is
 * listening.
 *
 * `packages/sdk/scripts/route-parity.cjs` already closed this for the four
 * SDKs, and did not cover the CLI — which had the same defect from the same
 * commit. This is the CLI half, wired the same way: an analyzer that reads the
 * App Router tree on disk, plus this file so it runs inside the package's
 * existing `vitest run` with no `ci.yml` edit.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const parity = require_("../../scripts/route-parity.cjs") as {
  analyze: () => Analysis;
  verdict: (r: Partial<Analysis>) => { code: number; lines: string[] };
  resolveRoute: (
    routes: Array<{ route: string; segments: string[] }>,
    callPath: string,
  ) => { route: string } | null;
  FOUNDER_GATED: Array<{ method: string; path: string }>;
};

interface Call {
  file: string;
  line: number;
  method: string;
  path: string;
  via: string;
}
interface Route {
  route: string;
  file: string;
  methods: string[];
  segments: string[];
}
interface Analysis {
  routes: Route[];
  calls: Call[];
  orphanCalls: Call[];
  unexcusedOrphans: Call[];
  staleExceptions: Array<{ method: string; path: string }>;
  uncoveredRoutes: Route[];
  methodMismatches: Array<Call & { route: string; routeMethods: string[] }>;
}

const analysis = parity.analyze();

describe("CLI route parity — the analyzer itself", () => {
  // A gate reporting "0 problems" because its extractor silently stopped
  // matching is indistinguishable from a clean tree. Both inputs must be
  // non-empty before any verdict it produces means anything.
  it("scans a non-empty route tree and a non-empty set of CLI call sites", () => {
    expect(analysis.routes.length).toBeGreaterThan(100);
    expect(analysis.calls.length).toBeGreaterThan(50);
  });

  // Positive control, BOTH states, against the REAL tree — not a fixture. The
  // same matcher must ACCEPT the path this command now sends and REJECT the
  // one it used to send. A matcher that only ever says "fine" would satisfy
  // every other assertion here while proving nothing.
  it("accepts a path with a handler and rejects the one that had none", () => {
    expect(parity.resolveRoute(analysis.routes, "/api/v1/monitoring")?.route).toBe(
      "/api/v1/monitoring",
    );
    expect(parity.resolveRoute(analysis.routes, "/api/v1/logs")).toBeNull();
  });

  // The route that IS the 404 must never count as a match, or every orphan in
  // the tree resolves happily to the thing that 404s it.
  it("never resolves anything to the catch-all sink", () => {
    const sink = analysis.routes.find((r) => r.route === "/api/v1/[...catch]");
    expect(sink, "the catch-all must be excluded from the match table").toBeUndefined();
    expect(parity.resolveRoute(analysis.routes, "/api/v1/no-such-route-at-all")).toBeNull();
  });

  // REGRESSION PIN. The first cut of the analyzer used a hand-rolled lexer. It
  // desynchronised on the regex literal `/filename="([^"]+)"/` at
  // apps/cli/src/commands/ai-bom.ts:109 — it read the `"` inside the regex as
  // the start of a string — and silently missed EVERY call site after it in
  // that file, including a real `POST /ai-sbom/generate`. It reported a clean
  // tree while blind to a third of it.
  it("keeps reading a file after a regex literal containing a quote", () => {
    const aiBom = analysis.calls.filter(
      (c) => c.file === "apps/cli/src/commands/ai-bom.ts",
    );
    expect(aiBom.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /api/v1/ai-sbom",
      "POST /api/v1/ai-sbom/generate",
    ]);
  });

  // The CLI reaches routes the SDK analyzer's `/api/v1`-only table cannot see,
  // and two call sites rewrite the base URL before appending a path. Reading
  // either wrong invents an orphan that does not exist.
  it("resolves the call sites that live outside /api/v1", () => {
    const paths = analysis.calls.map((c) => c.path);
    expect(paths).toContain("/api/health");
    expect(paths.some((p) => p.startsWith("/api/grpc/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/api/v1/api/"))).toBe(false);
  });

  // Methods are read from the transport helper when it hard-codes its verb.
  // Without that, moderation/voice read as GET against POST-only routes — five
  // fabricated mismatches an author would have had to explain away.
  it("reads a verb hard-coded inside a transport helper", () => {
    const moderation = analysis.calls.filter((c) => c.path.startsWith("/api/v1/moderation/"));
    expect(moderation.length).toBeGreaterThan(0);
    for (const c of moderation) expect(c.method).toBe("POST");
  });
});

describe("CLI route parity — the gate's own verdict", () => {
  // A gate that has only ever been observed saying "OK" has not been shown to
  // be capable of saying anything else. Drive every exit code.
  it("exits non-zero on a zero-item scan", () => {
    expect(parity.verdict({ routes: [], calls: [] }).code).toBe(2);
    expect(parity.verdict({ routes: analysis.routes, calls: [] }).code).toBe(2);
    expect(parity.verdict({ routes: [], calls: analysis.calls }).code).toBe(2);
  });

  it("exits non-zero on an orphan call site", () => {
    const v = parity.verdict({
      routes: analysis.routes,
      calls: analysis.calls,
      unexcusedOrphans: [
        {
          file: "apps/cli/src/commands/logs.ts",
          line: 1,
          method: "GET",
          path: "/api/v1/logs",
          via: "helper:apiRequest",
        },
      ],
      staleExceptions: [],
    });
    expect(v.code).toBe(1);
    expect(v.lines.join("\n")).toContain("/api/v1/logs");
  });

  it("exits non-zero on a verb the matched route does not export", () => {
    const v = parity.verdict({
      routes: analysis.routes,
      calls: analysis.calls,
      unexcusedOrphans: [],
      staleExceptions: [],
      methodMismatches: [
        {
          file: "apps/cli/src/commands/logs.ts",
          line: 1,
          method: "DELETE",
          path: "/api/v1/monitoring",
          via: "helper:apiRequest",
          route: "/api/v1/monitoring",
          routeMethods: ["GET", "POST"],
        },
      ],
    });
    expect(v.code).toBe(1);
    expect(v.lines.join("\n")).toContain("GET,POST");
  });

  it("exits non-zero on an excuse that outlived its problem", () => {
    const v = parity.verdict({
      routes: analysis.routes,
      calls: analysis.calls,
      unexcusedOrphans: [],
      staleExceptions: [{ method: "GET", path: "/api/v1/gone" }],
    });
    expect(v.code).toBe(1);
  });

  it("exits zero only when a real, non-empty scan is clean", () => {
    expect(
      parity.verdict({
        routes: analysis.routes,
        calls: analysis.calls,
        unexcusedOrphans: [],
        staleExceptions: [],
      }).code,
    ).toBe(0);
  });
});

describe("CLI route parity — the tree", () => {
  it("has no CLI call site targeting a path with no route handler", () => {
    const detail = analysis.unexcusedOrphans
      .map((o) => `  ${o.method} ${o.path}  (${o.file}:${o.line})`)
      .join("\n");
    expect(
      analysis.unexcusedOrphans.length,
      `These CLI commands 404 in production — the path reaches api/v1/[...catch]:\n${detail}\n\n` +
        "Repoint the call to the real route, or add it to FOUNDER_GATED in " +
        "apps/cli/scripts/route-parity.cjs with the evidence and the decision being awaited.",
    ).toBe(0);
  });

  // An excuse list that outlives the problem it excused is how a gate rots
  // into a rubber stamp. If a listed call site is no longer orphaned, it goes.
  it("has no stale FOUNDER_GATED entry", () => {
    const detail = analysis.staleExceptions.map((e) => `  ${e.method} ${e.path}`).join("\n");
    expect(
      analysis.staleExceptions.length,
      `These FOUNDER_GATED entries no longer describe an orphan — delete them:\n${detail}`,
    ).toBe(0);
  });

  it("has no CLI call site using a verb the matched route does not export", () => {
    const detail = analysis.methodMismatches
      .map((m) => `  ${m.method} ${m.path} — route exports [${m.routeMethods.join(",")}]`)
      .join("\n");
    expect(analysis.methodMismatches.length, `Verb/route mismatches:\n${detail}`).toBe(0);
  });

  // Pins the repoint itself. `logs list` reads production_logs through
  // `GET /monitoring`; if someone restores `/logs`, or "simplifies" it to the
  // similarly-named `/audit-logs` (a different table answering a different
  // question), this says so.
  it("routes `logs list` at the production-log read API", () => {
    const logsCalls = analysis.calls.filter(
      (c) => c.file === "apps/cli/src/commands/logs.ts",
    );
    expect(logsCalls.map((c) => c.path)).toEqual(["/api/v1/monitoring"]);
  });

  // The reverse population. Routes with no CLI caller are not a defect — most
  // of the API is UI-, SDK- or cron-only — but the number is a real signal and
  // a silent zero would mean the coverage side of the sweep stopped working.
  it("computes the reverse population (routes the CLI cannot reach)", () => {
    expect(analysis.uncoveredRoutes.length).toBeGreaterThan(0);
    expect(analysis.uncoveredRoutes.length).toBeLessThan(analysis.routes.length);
    const uncovered = new Set(analysis.uncoveredRoutes.map((r) => r.route));
    for (const reached of [
      "/api/v1/monitoring",
      "/api/v1/evals",
      "/api/v1/traces",
      "/api/v1/scorers",
      "/api/health",
    ]) {
      expect(uncovered.has(reached), `${reached} is reached by the CLI but reported uncovered`).toBe(
        false,
      );
    }
  });
});
