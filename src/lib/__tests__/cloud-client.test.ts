import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { getCloudClient, extractServerError, validateApiKey } from "../cloud-client.js";
import { DEFAULT_BASE_URL } from "../config.js";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";

vi.mock("fs");

/**
 * Audit H1 (cli-eval-scan-getclient-config-only): `evalguard eval`/`scan` built
 * their client by reading key/baseURL ONLY from ~/.evalguard/config.json, so the
 * documented `EVALGUARD_API_KEY`/`EVALGUARD_BASE_URL` env-var CI auth silently
 * failed for those two commands (and a stale config file caused split-brain
 * auth). `getCloudClient` now resolves through the SAME env-first chain as every
 * other authenticated command.
 */
describe("getCloudClient — env-first auth (cli-eval-scan-getclient-config-only)", () => {
  const ORIG_KEY = process.env.EVALGUARD_API_KEY;
  const ORIG_URL = process.env.EVALGUARD_BASE_URL;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.EVALGUARD_API_KEY;
    delete process.env.EVALGUARD_BASE_URL;
  });

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.EVALGUARD_API_KEY;
    else process.env.EVALGUARD_API_KEY = ORIG_KEY;
    if (ORIG_URL === undefined) delete process.env.EVALGUARD_BASE_URL;
    else process.env.EVALGUARD_BASE_URL = ORIG_URL;
  });

  it("authenticates from EVALGUARD_API_KEY alone with an empty HOME (no config file)", () => {
    // Empty HOME: no ~/.evalguard/config.json.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env.EVALGUARD_API_KEY = "eg_env_only_key";

    const result = getCloudClient("3.3.4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.apiKey).toBe("eg_env_only_key");
      expect(result.client.baseUrl).toBe(DEFAULT_BASE_URL);
    }
  });

  it("honors EVALGUARD_BASE_URL (env) and normalizes a base that ends in /api", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env.EVALGUARD_API_KEY = "eg_env_only_key";
    process.env.EVALGUARD_BASE_URL = "https://evalguard.ai/api";

    const result = getCloudClient("3.3.4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // M2: /api → /api/v1 (not /api/api/v1).
      expect(result.client.baseUrl).toBe("https://evalguard.ai/api/v1");
    }
  });

  it("env var overrides a stale config-file key (no split-brain)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "eg_stale_file_key", projectId: "proj-file" }) as never,
    );
    process.env.EVALGUARD_API_KEY = "eg_env_wins";

    const result = getCloudClient("3.3.4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.apiKey).toBe("eg_env_wins");
      // projectId still comes from the login config file.
      expect(result.client.projectId).toBe("proj-file");
    }
  });

  it("falls back to the login config file when no env var is set", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "eg_from_login", baseUrl: "https://self.host/api/v1" }) as never,
    );

    const result = getCloudClient("3.3.4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.apiKey).toBe("eg_from_login");
      expect(result.client.baseUrl).toBe("https://self.host/api/v1");
    }
  });

  it("returns { ok: false } when no key resolves (env or file)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = getCloudClient("3.3.4");
    expect(result.ok).toBe(false);
  });
});

describe("extractServerError (moved with getClient — envelope tolerance)", () => {
  it("reads the standard { error: { message } } envelope", () => {
    expect(extractServerError({ error: { message: "boom" } }, "fallback")).toBe("boom");
  });

  it("folds fieldErrors into a single message", () => {
    expect(extractServerError({ fieldErrors: { name: ["Required"] } }, "fallback")).toBe(
      "name: Required",
    );
  });

  it("uses the fallback when nothing usable is present", () => {
    expect(extractServerError({}, "the fallback")).toBe("the fallback");
  });
});

/**
 * `evalguard login` now server-side validates the key BEFORE persisting it (a
 * bad key used to be accepted and only fail on the first real command). It
 * fails OPEN — a 5xx / network error / timeout yields `unverified` so
 * offline / air-gapped users aren't blocked.
 */
describe("validateApiKey — login-time server-side key check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 CARRYING the endpoint's answer ⇒ valid", async () => {
    // Was `mockResolvedValue({ ok: true, status: 200 })` — a 200 with NO BODY
    // AT ALL, asserted to be a valid key. That assertion was the fail-open
    // written as a requirement: `validateApiKey` only looked at the status, so
    // anything answering 200 (a captive portal, a proxy, a stub) validated a
    // fabricated key, and `evalguard whoami` printed "✓ Authenticated
    // (verified against the server)" and exited 0. Measured 2026-08-08 across
    // all nine malformed-body cases in the per-command matrix.
    //
    // `GET /scorers` is `apiSuccess({ scorers, total })`, so a real answer
    // carries a `scorers` list.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, data: { scorers: [{ id: "exact-match" }], total: 1 } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_good_key", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "valid" });

    // Hit the authed /scorers endpoint with the bearer token + version header.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/scorers`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer eg_good_key");
    expect((init.headers as Record<string, string>)["x-evalguard-client-version"]).toBe("3.3.4");
  });

  // The nine bodies the matrix drove `whoami` through. Every one of them used
  // to return `{ status: "valid" }`.
  it.each([
    ["invalid JSON", new Response("this is not JSON at all {{{", { status: 200 })],
    ["an empty body", new Response("", { status: 200 })],
    ["a 204", new Response(null, { status: 204 })],
    ["JSON null", new Response("null", { status: 200 })],
    ["a bare string", new Response('"ok"', { status: 200 })],
    ["an HTML proxy page", new Response("<html>502 Proxy Error</html>", { status: 200 })],
    ["an unrelated object", jsonResponse({ hello: "world" })],
    ["a success envelope with data:null", jsonResponse({ success: true, data: null })],
    ["a success:false envelope at 200", jsonResponse({ success: false, error: { message: "boom" } })],
    ["a 200 whose `scorers` is not a list", jsonResponse({ success: true, data: { scorers: 7 } })],
  ])("2xx carrying %s ⇒ UNVERIFIED, never valid", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await validateApiKey("eg_fabricated", DEFAULT_BASE_URL, "3.3.4");

    expect(result.status).toBe("unverified");
    // …and specifically NOT an accusation against the key: it is the RESPONSE
    // that could not be trusted, and telling people to rotate a good key to fix
    // a broken proxy is its own failure.
    expect(result.status).not.toBe("invalid");
  });

  it("401 ⇒ invalid, message pulled from the server body", async () => {
    // Real Response: `validateApiKey` reads the rejection body through the
    // shared fail-closed decode (lib/http.ts), which uses `res.text()`.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "That API key was revoked." } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_bad_key", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "invalid", message: "That API key was revoked." });
  });

  it("403 ⇒ invalid, falling back to a default message when body is unhelpful", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_forbidden", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "invalid", message: "Invalid API key" });
  });

  it("500 ⇒ unverified (fail-open), reason names the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_key", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "unverified", reason: "server returned 500" });
  });

  it("network error ⇒ unverified with the error message", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_key", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "unverified", reason: "socket hang up" });
  });

  it("request timeout ⇒ unverified with the timeout message", async () => {
    const timeoutErr = Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    });
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateApiKey("eg_key", DEFAULT_BASE_URL, "3.3.4");
    expect(result).toEqual({ status: "unverified", reason: "The operation timed out" });
  });
});
