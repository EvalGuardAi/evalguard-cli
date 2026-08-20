/**
 * AUDIT 2026-08-09 (cli-debug-auth-failure-exits-0) — `evalguard debug` is the
 * documented connectivity/auth preflight, and it could not fail.
 *
 * Measured on the built CLI (dist/index.js, Node 24) against a stub answering
 * 401 to everything, BEFORE the fix:
 *
 *     $ EVALGUARD_BASE_URL=http://127.0.0.1:45999/api/v1 \
 *       EVALGUARD_API_KEY=eg_bogus_rejected_key evalguard debug
 *       API Connectivity
 *       ✗ http://127.0.0.1:45999/api/health — HTTP 401 (36ms)
 *     exit=0
 *
 * The whole file carried NO `process.exit` and NO `process.exitCode` site, so a
 * REJECTED CREDENTIAL — printed in red, as a ✗ — was reported to the shell as a
 * healthy environment. A CI job using `evalguard debug` as its auth gate passed
 * with a dead key.
 *
 * The contract asserted here: every red ✗ is a hard failure and exits 1; yellow
 * `!` advisories (no key configured, no config file) stay exit 0 so `debug`
 * remains usable as a PRE-login diagnostic on a fresh checkout.
 *
 * This talks to a real loopback HTTP server rather than mocking `boundedFetch`:
 * the defect lives in how the RESPONSE STATUS is turned into an exit code, and a
 * fetch mock is exactly the seam that would let a regression in that mapping pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { createServer, type Server } from "node:http";
// Point the config file at a path that cannot exist BEFORE debug.ts is imported —
// it resolves `configFilePath()` into a module-level constant at import time.
// Without this the suite would read whichever ~/.evalguard/config.json happens to
// be on the machine, so a developer's corrupt or populated config could flip the
// exit code and make these assertions machine-dependent. Built from raw strings:
// a `vi.hoisted` body runs before the ESM imports, so it cannot use one.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TEMP || "/tmp";
  process.env.EVALGUARD_CONFIG_FILE =
    `${tmp}/evalguard-debug-exit-code-test-nonexistent/config.json`;
});

import { registerDebug } from "../debug.js";

let server: Server;
let port: number;
let status = 401;
/** Raw body override, for the "200 that is not a health report" cases. */
let body: string | null = null;
let logSpy: ReturnType<typeof vi.spyOn>;

const ORIG_KEY = process.env.EVALGUARD_API_KEY;
const ORIG_URL = process.env.EVALGUARD_BASE_URL;

beforeEach(async () => {
  status = 401;
  body = null;
  server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    // The health route always answers { status: "ok" | "degraded" | "error", … }
    // (apps/web/src/app/api/health/route.ts:274). This stub used to answer
    // `{ok:true}`, which that route never sends — so the "probe succeeds"
    // control below was asserting against a body no real server produces, and
    // could not have caught the status-only check fixed on 2026-08-09.
    res.end(body ?? JSON.stringify({ status: status < 400 ? "ok" : "error" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.EVALGUARD_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
  process.env.EVALGUARD_API_KEY = "eg_bogus_rejected_key_for_test";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
  if (ORIG_KEY === undefined) delete process.env.EVALGUARD_API_KEY;
  else process.env.EVALGUARD_API_KEY = ORIG_KEY;
  if (ORIG_URL === undefined) delete process.env.EVALGUARD_BASE_URL;
  else process.env.EVALGUARD_BASE_URL = ORIG_URL;
  process.exitCode = 0;
});

function output(): string {
  return (logSpy.mock.calls as unknown[][]).map((c) => c.join(" ")).join("\n");
}

/** Runs `debug` and returns the exit code it leaves behind. */
async function runDebug(): Promise<number> {
  const program = new Command();
  program.exitOverride();
  registerDebug(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "evalguard", "debug"]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0; // don't leak a failure code into the vitest run
  return code;
}

describe("evalguard debug — an authentication failure must not exit 0", () => {
  it("CONTROL: the API connectivity probe actually runs and reports the 401", async () => {
    // Passes BOTH before and after the fix. Its job is to prove this test is
    // looking at a real probe against a real server — without it, the exit-code
    // assertion below could go green against a `debug` that never made the call
    // (e.g. because the env vars stopped being honoured), which is the failure
    // mode that would make the whole file vacuous.
    await runDebug();
    expect(output()).toContain("API Connectivity");
    expect(output()).toContain(`http://127.0.0.1:${port}/api/health`);
    expect(output()).toContain("HTTP 401");
  });

  it("exits 1 when the server REJECTS the API key (the defect: this was 0)", async () => {
    expect(await runDebug()).toBe(1);
  });

  it("names the rejected credential so the operator knows to re-login", async () => {
    await runDebug();
    expect(output()).toContain("REJECTED this API key");
  });

  it("exits 1 when the API is unreachable (connection refused)", async () => {
    // Close the stub first so the port is dead — the `catch` arm of the probe.
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer(() => {}); // placeholder so afterEach's close() is safe
    expect(await runDebug()).toBe(1);
    expect(output()).toContain("Connection failed");
  });

  // ── CONTROLS: the gate must not fire on healthy or merely-advisory states ──
  it("exits 0 when the health probe succeeds", async () => {
    status = 200;
    expect(await runDebug()).toBe(0);
    expect(output()).toContain(`http://127.0.0.1:${port}/api/health`);
  });

  // ── AUDIT 2026-08-09 (cli-debug-status-only-health-check) ────────────────
  // `if (res.ok)` made this a STATUS-CODE check, not a health check: measured on
  // the built CLI, `debug` printed `✓ …/api/health` for 11 of 14 fault bodies
  // served with HTTP 200, including an nginx 502 page. These drive the real
  // probe against a real socket, because the defect lives in how the RESPONSE
  // BODY is turned into a verdict and a fetch mock is exactly the seam that
  // would let a regression in that mapping pass.
  it.each([
    ["an nginx 502 page served as 200", "<html><head><title>502 Bad Gateway</title></head></html>"],
    ["invalid JSON", "this is not JSON at all {{{"],
    ["an empty body", ""],
    ["a JSON null", "null"],
    ["a bare string", '"ok"'],
    ["an unrelated object", '{"hello":"world"}'],
    ["a 200 carrying an error envelope", '{"success":false,"error":{"message":"boom"}}'],
  ])("exits 1 when a 200 carries %s, not a health report", async (_what, raw) => {
    status = 200;
    body = raw;
    expect(await runDebug()).toBe(1);
    expect(output()).toContain("not this endpoint's health report");
  });

  it("reports a DEGRADED backend as an advisory, not a pass and not a failure", async () => {
    // `degraded` is a real distinct state and is exactly what someone runs
    // `debug` to discover; flattening it into ✓ or ✗ loses the finding.
    status = 200;
    body = JSON.stringify({ status: "degraded", checks: { db: { status: "degraded" } } });
    expect(await runDebug()).toBe(0);
    expect(output()).toContain("degraded");
  });

  it("exits 1 when the backend reports status: error with a 200", async () => {
    status = 200;
    body = JSON.stringify({ status: "error" });
    expect(await runDebug()).toBe(1);
  });

  it("exits 0 with NO api key configured — an advisory, not a failure", async () => {
    // `debug` has to stay usable before `evalguard login` has ever been run.
    delete process.env.EVALGUARD_API_KEY;
    expect(await runDebug()).toBe(0);
    expect(output()).toContain("Skipped — no API key configured");
  });
});
