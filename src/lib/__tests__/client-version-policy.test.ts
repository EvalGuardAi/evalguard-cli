import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ClientVersionPolicyError,
  getCloudClient,
  resetClientPolicyWarning,
} from "../cloud-client.js";

/**
 * ENTERPRISE CLIENT-VERSION PINNING — `assertVersionAllowed`, wire-or-delete.
 *
 * DECIDED: WIRED. Before this change the method existed on `CloudClient` and
 * was called by NOTHING, so an org that pinned an allowed CLI range got zero
 * client-side enforcement — dead code wearing the name of a control. It is now
 * called from the two live `getCloudClient` sites (`eval`, `scan`).
 *
 * The tests below pin BOTH halves of the fail-open/fail-closed decision,
 * because a control that only ever allows and a control that locks a fleet out
 * are both catastrophic and only one of them is loud:
 *
 *   fail-CLOSED  the policy is reachable and says this version is not allowed
 *   fail-OPEN    anything else — unreachable, 5xx, timeout, old server, a body
 *                the boundary refuses, an unparseable pin — ALWAYS with a
 *                stderr warning, so "the pin isn't working" is visible.
 *
 * See the method's doc comment for why fail-open on transport is the right
 * trade (it matches the SERVER's own stated choice for the same endpoint, and
 * the client is not the enforcement boundary — the version header is).
 */

const VERSION = "3.8.0";
let tmpDir: string;
let warnings: string[];

function policyResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client() {
  const result = getCloudClient(VERSION);
  if (!result.ok) throw new Error("test setup: no API key resolved");
  return result.client;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-policy-"));
  warnings = [];
  resetClientPolicyWarning();
  process.env.EVALGUARD_CONFIG_FILE = path.join(tmpDir, "config.json");
  process.env.EVALGUARD_API_KEY = "eg_test_key";
  process.env.EVALGUARD_BASE_URL = "https://stub.test/api/v1";
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.EVALGUARD_CONFIG_FILE;
  delete process.env.EVALGUARD_API_KEY;
  delete process.env.EVALGUARD_BASE_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fail-CLOSED: the policy is readable and says no", () => {
  it("refuses with the SERVER's own reason when it sent a versionCheck", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        policyResponse({
          requiredMinimumVersion: "4.0.0",
          requiredMaximumVersion: null,
          versionCheck: {
            allowed: false,
            status: "below_minimum",
            reason: "EvalGuard client 3.8.0 is below the minimum version (4.0.0) required by this organization. Upgrade to continue.",
          },
        }),
      ),
    );
    await expect(client().assertVersionAllowed()).rejects.toBeInstanceOf(ClientVersionPolicyError);
    await expect(client().assertVersionAllowed()).rejects.toThrow(/below the minimum version \(4\.0\.0\)/);
  });

  it("refuses via the LOCAL comparison when the server is too old to send versionCheck", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse({ requiredMinimumVersion: "4.0.0", requiredMaximumVersion: null })),
    );
    await expect(client().assertVersionAllowed()).rejects.toThrow(/below the minimum version/);
  });

  it("refuses an ABOVE-maximum version too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse({ requiredMinimumVersion: null, requiredMaximumVersion: "3.0.0" })),
    );
    await expect(client().assertVersionAllowed()).rejects.toThrow(/above the maximum version/);
  });

  it("THROWS rather than process.exit — the call sites hold a live spinner", async () => {
    // The shipped implementation called process.exit(1) from inside an async
    // fetch continuation. Wiring THAT as written would have turned a policy
    // refusal into the libuv UV_HANDLE_CLOSING abort (exit 127 on Windows)
    // that this package has fixed a dozen times. A refusal must read as a
    // refusal.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must NOT be called from assertVersionAllowed");
    }) as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse({ requiredMinimumVersion: "9.9.9", requiredMaximumVersion: null })),
    );
    await expect(client().assertVersionAllowed()).rejects.toBeInstanceOf(ClientVersionPolicyError);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("fail-OPEN: everything that is not a verdict, and never silently", () => {
  it("POSITIVE CONTROL: an UNPINNED org is allowed, with no warning at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse({ requiredMinimumVersion: null, requiredMaximumVersion: null })),
    );
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("POSITIVE CONTROL: a version INSIDE the pinned range is allowed silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        policyResponse({
          requiredMinimumVersion: "3.0.0",
          requiredMaximumVersion: "4.0.0",
          versionCheck: { allowed: true, status: "ok" },
        }),
      ),
    );
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("allows on a NETWORK error — a policy blip must not brick a CI fleet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND stub.test"); }));
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/could not read this organization's client-version policy/);
    expect(warnings.join(" ")).toMatch(/ENOTFOUND/);
  });

  it("allows on a 5xx, and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream boom", { status: 502 })));
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/could not read/);
  });

  it("allows on a 404 — an older server has no such route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })));
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/could not read/);
  });

  it("does NOT read a `success:false` envelope as 'unpinned'", async () => {
    // The shipped code did `raw.data ?? raw`, so an error envelope became a
    // policy object with no bounds — i.e. an explicit server failure was spent
    // as a permission, silently. Unreadable and unpinned are different facts.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: { code: "DB_ERROR", message: "nope" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/could not read/);
  });

  it("warns rather than silently skipping when the PIN itself is not comparable", async () => {
    // `if (ver && minT && …)` fell straight through for a two-component pin,
    // disabling enforcement with no signal whatsoever.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => policyResponse({ requiredMinimumVersion: "1.2", requiredMaximumVersion: null })),
    );
    await expect(client().assertVersionAllowed()).resolves.toBeUndefined();
    expect(warnings.join(" ")).toMatch(/not comparable/);
  });

  it("warns only ONCE per process", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const c = client();
    await c.assertVersionAllowed();
    await c.assertVersionAllowed();
    expect(warnings).toHaveLength(1);
  });
});

describe("the request itself", () => {
  it("asks the version-aware endpoint and sends the client-version header", async () => {
    const spy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      policyResponse({ requiredMinimumVersion: null, requiredMaximumVersion: null }),
    );
    vi.stubGlobal("fetch", spy);
    await client().assertVersionAllowed();
    const [input, init] = spy.mock.calls[0];
    expect(String(input)).toContain("/client/policy?version=3.8.0");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-evalguard-client-version"]).toBe(VERSION);
  });
});

describe("WIRING — the control is actually called", () => {
  it("`eval` and `scan` both consult the policy after building the client", () => {
    // A behavioural test would have to import index.ts, which calls
    // program.parseAsync() at module scope. This asserts the edge instead: every
    // getCloudClient() site is followed by an assertVersionAllowed() call. The
    // whole finding was that the method existed and nothing called it, so the
    // regression to guard against is a call site quietly disappearing.
    const src = fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf-8");
    const clientSites = src.match(/getCloudClient\(/g) ?? [];
    // `client.` prefix required: the bare name also appears in prose comments,
    // and a test that counts a comment is exactly the kind of green-for-the-
    // wrong-reason check this whole change is about.
    const assertSites = src.match(/client\.assertVersionAllowed\(\)/g) ?? [];
    expect(clientSites.length).toBe(2); // eval + scan
    expect(assertSites.length).toBe(clientSites.length);
    // and each one is handled, not left to become an unhandled rejection
    expect(src.match(/await client\.assertVersionAllowed\(\);/g)?.length).toBe(2);
    expect((src.match(/catch \(policyErr\)/g) ?? []).length).toBe(2);
  });
});
