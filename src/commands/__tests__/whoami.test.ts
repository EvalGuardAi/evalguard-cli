/**
 * Audit M1 (cli-whoami-env-blind-always-exit-0): `evalguard whoami` used to read
 * ONLY ~/.evalguard/config.json (ignoring EVALGUARD_API_KEY/BASE_URL) and exited
 * 0 in BOTH the authed and unauthed branches, so it could not be used as a guard
 * (`evalguard whoami || exit 1`). It now resolves via the shared env-first chain,
 * prints the NORMALIZED base URL, and exits non-zero when no credential resolves.
 *
 * Audit 2026-08-08 (cli-whoami-unverified-checkmark): fixing the exit code was
 * only half of it. The authed branch still printed "✓ Authenticated" for ANY
 * non-empty string in EVALGUARD_API_KEY, against ANY base URL, WITHOUT OPENING A
 * SOCKET — a fabricated key aimed at a dead endpoint passed. So the guard the
 * first fix enabled (`evalguard whoami || exit 1`) proved nothing about the
 * credential; it only proved the variable was set.
 *
 * The old assertion here PINNED that: "Never exits non-zero when a credential
 * resolves" is exactly the fail-open, written as a requirement. It is replaced
 * below by the full three-way matrix over the server's answer, with
 * `validateApiKey` mocked so the branches are asserted rather than the network:
 *
 *   server accepts (valid)      → ✓ Authenticated,          exit 0
 *   server rejects (invalid)    → ✗ rejected + server text,  exit 1
 *   server unreachable          → ? could NOT verify,        exit 1   ← was ✓ exit 0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import { registerWhoami } from "../whoami.js";
import { validateApiKey } from "../../lib/cloud-client.js";

vi.mock("fs");
// Mocked so this stays a unit test: before this mock existed the suite opened a
// real socket to evalguard.ai on every run.
vi.mock("../../lib/cloud-client.js", () => ({ validateApiKey: vi.fn() }));

/** Thrown by the `process.exit` spy so execution really stops, as it would in
 *  the shipped CLI. A spy that merely records and RETURNS lets the code fall
 *  through into branches it could never reach in production — which would let a
 *  regression print "✓ Authenticated" after a rejection and still pass. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe("whoami — env-aware auth + server-VERIFIED checkmark", () => {
  const ORIG_KEY = process.env.EVALGUARD_API_KEY;
  const ORIG_URL = process.env.EVALGUARD_BASE_URL;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.EVALGUARD_API_KEY;
    delete process.env.EVALGUARD_BASE_URL;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIG_KEY === undefined) delete process.env.EVALGUARD_API_KEY;
    else process.env.EVALGUARD_API_KEY = ORIG_KEY;
    if (ORIG_URL === undefined) delete process.env.EVALGUARD_BASE_URL;
    else process.env.EVALGUARD_BASE_URL = ORIG_URL;
  });

  function output(): string {
    return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  /**
   * Runs the command and returns the effective exit code.
   *
   * Reads BOTH mechanisms: an `ExitCalled` from the `process.exit` spy and a
   * `process.exitCode` left behind by a branch that returned normally. The two
   * post-`validateApiKey` branches deliberately use the latter — see the
   * cli-whoami-auth-failure-exits-127 note in whoami.ts — so a harness that only
   * watched `process.exit` would score a correct exit 1 as a 0.
   */
  async function runWhoami(): Promise<number> {
    const program = new Command();
    program.exitOverride();
    registerWhoami(program);
    process.exitCode = 0;
    try {
      await program.parseAsync(["node", "evalguard", "whoami"]);
      const code = Number(process.exitCode ?? 0);
      process.exitCode = 0; // don't leak a failure code into the vitest run
      return code;
    } catch (e) {
      process.exitCode = 0;
      if (e instanceof ExitCalled) return e.code ?? 0;
      throw e;
    }
  }

  it("server ACCEPTS the key → ✓ Authenticated, NORMALIZED base URL, exit 0", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // empty HOME, no config file
    vi.mocked(validateApiKey).mockResolvedValue({ status: "valid" });
    process.env.EVALGUARD_API_KEY = "eg_env_only_key_abcdef1234";
    process.env.EVALGUARD_BASE_URL = "https://evalguard.ai/api"; // ends in /api → normalized

    expect(await runWhoami()).toBe(0);

    expect(output()).toContain("Authenticated");
    // Base URL is the NORMALIZED /api/v1 root (not the raw /api).
    expect(output()).toContain("https://evalguard.ai/api/v1");
    expect(exitSpy).not.toHaveBeenCalled();
    // The key is CHECKED, not assumed — and checked against the resolved base.
    expect(validateApiKey).toHaveBeenCalledWith(
      "eg_env_only_key_abcdef1234",
      "https://evalguard.ai/api/v1",
      expect.any(String),
    );
  });

  it("server REJECTS the key → no checkmark, quotes the server, exit 1", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(validateApiKey).mockResolvedValue({
      status: "invalid",
      message: "API key not found",
    });
    process.env.EVALGUARD_API_KEY = "eg_totally_fabricated_key";

    expect(await runWhoami()).toBe(1);

    expect(output()).toContain("the server rejected this API key");
    expect(output()).toContain("API key not found");
    expect(output()).not.toContain("✓");
    // NOT via process.exit(): validateApiKey has just completed an HTTPS round
    // trip, and process.exit() while undici's keep-alive sockets tear down aborts
    // the process on Windows Node — the measured result was exit 127 plus a libuv
    // assertion dump instead of the 1 this branch intends.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("server UNREACHABLE → '?', never a checkmark, exit 1 (the old fail-open)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(validateApiKey).mockResolvedValue({
      status: "unverified",
      reason: "fetch failed",
    });
    // The measured case: a plausible-looking key aimed at a dead endpoint. This
    // printed "✓ Authenticated" and exited 0.
    process.env.EVALGUARD_API_KEY = "eg_live_looking_key_9f3a";
    process.env.EVALGUARD_BASE_URL = "http://127.0.0.1:9/api/v1";

    expect(await runWhoami()).toBe(1);

    expect(output()).toContain("Could NOT verify this API key");
    expect(output()).toContain("fetch failed");
    expect(output()).not.toContain("✓");
    // Same libuv guard as the rejected-key branch above.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("unauthenticated branch: no env + empty HOME → exits 1 without calling the server", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(await runWhoami()).toBe(1);

    expect(output()).toContain("Not authenticated.");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // No credential means nothing to verify — don't spend a round trip on it.
    expect(validateApiKey).not.toHaveBeenCalled();
  });
});
