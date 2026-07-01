import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProjectId, resetResolvedProjectId } from "../config.js";

// Mock the HTTP layer (global fetch) — never hit the network.
function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

describe("resolveProjectId — CLI project auto-resolution (/project/current)", () => {
  const ORIG_KEY = process.env.EVALGUARD_API_KEY;
  const ORIG_URL = process.env.EVALGUARD_BASE_URL;

  beforeEach(() => {
    resetResolvedProjectId();
    // Stub credentials via env so we don't touch ~/.evalguard/config.json.
    process.env.EVALGUARD_API_KEY = "eg_test_key";
    process.env.EVALGUARD_BASE_URL = "https://api.test/api/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetResolvedProjectId();
    if (ORIG_KEY === undefined) delete process.env.EVALGUARD_API_KEY;
    else process.env.EVALGUARD_API_KEY = ORIG_KEY;
    if (ORIG_URL === undefined) delete process.env.EVALGUARD_BASE_URL;
    else process.env.EVALGUARD_BASE_URL = ORIG_URL;
  });

  it("fetches /project/current and uses the returned projectId when none is supplied", async () => {
    mockFetchOnce({ projectId: "proj-abc", orgId: "org-1" });

    const id = await resolveProjectId();

    expect(id).toBe("proj-abc");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/project/current");
    // Same base-URL/path construction + bearer auth the other /api/v1 calls use.
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer eg_test_key",
    });
  });

  it("an explicit projectId wins and skips the /project/current fetch", async () => {
    mockFetchOnce({ projectId: "proj-from-server" });

    const id = await resolveProjectId("proj-explicit");

    expect(id).toBe("proj-explicit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches the resolved id across two calls (only one fetch)", async () => {
    mockFetchOnce({ projectId: "proj-cached" });

    const first = await resolveProjectId();
    const second = await resolveProjectId();

    expect(first).toBe("proj-cached");
    expect(second).toBe("proj-cached");
    // Cached per process → the second call must NOT re-fetch.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when /project/current returns an empty projectId", async () => {
    mockFetchOnce({ projectId: "", orgId: "org-1" });

    await expect(resolveProjectId()).rejects.toThrow(
      /pass projectId explicitly/i,
    );
  });

  it("throws a clear error when /project/current fails (non-OK)", async () => {
    mockFetchOnce({ message: "boom" }, false, 500);

    await expect(resolveProjectId()).rejects.toThrow(
      /pass projectId explicitly/i,
    );
  });
});
