import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  isLoopbackUrl,
  maskApiKey,
  normalizeBaseUrl,
  resolveApiKey,
  resolveBaseUrl,
  DEFAULT_BASE_URL,
} from "../config.js";

vi.mock("fs");

describe("isLoopbackUrl — login HTTPS host check (cli-login-https-substring-bypass)", () => {
  it("accepts real loopback hosts", () => {
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8080/api/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080")).toBe(true);
  });

  it("rejects a remote host that merely embeds 'localhost' in the path or query (the bypass)", () => {
    // These are the substring-bypass shapes the old `url.includes('localhost')`
    // check accepted, leaking the API key in cleartext to a remote host.
    expect(isLoopbackUrl("http://evil.example.com/?redirect=localhost")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com/")).toBe(false);
    expect(isLoopbackUrl("http://attacker.test/127.0.0.1")).toBe(false);
    expect(isLoopbackUrl("http://user@localhost.attacker.com/")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("maskApiKey (cli-whoami-short-key-leak)", () => {
  it("masks long keys with head + tail context", () => {
    expect(maskApiKey("eg_live_abcdef1234567890")).toBe("eg_live...7890");
  });

  it("never reveals the head/whole secret for short keys (<= 12 chars)", () => {
    const short = "secret123"; // 9 chars
    const masked = maskApiKey(short);
    // The old head(0,7)+tail(-4) overlapped and printed the entire short key.
    expect(masked).toBe("***t123");
    expect(masked).not.toContain("secret");
    expect(masked.startsWith("secret")).toBe(false);
  });

  it("does not expose the head even at the boundary length (12)", () => {
    const key = "abcdefghijkl"; // exactly 12
    const masked = maskApiKey(key);
    expect(masked).toBe("***ijkl");
    expect(masked).not.toContain("abcdef");
  });
});

describe("normalizeBaseUrl (cli-login-base-url-missing-api-v1)", () => {
  it("appends /api/v1 when the URL omits the versioned API prefix", () => {
    expect(normalizeBaseUrl("https://evalguard.ai")).toBe("https://evalguard.ai/api/v1");
  });

  it("strips a trailing slash before appending /api/v1", () => {
    expect(normalizeBaseUrl("https://evalguard.ai/")).toBe("https://evalguard.ai/api/v1");
    expect(normalizeBaseUrl("https://evalguard.ai///")).toBe("https://evalguard.ai/api/v1");
  });

  it("leaves a URL that already ends in /api/v1 untouched (and trims its trailing slash)", () => {
    expect(normalizeBaseUrl("https://evalguard.ai/api/v1")).toBe("https://evalguard.ai/api/v1");
    expect(normalizeBaseUrl("https://evalguard.ai/api/v1/")).toBe("https://evalguard.ai/api/v1");
  });

  it("works for custom hosts (self-hosted / local dev)", () => {
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
  });
});

describe("resolveApiKey / resolveBaseUrl precedence (cli-auth-env-only-ignores-login-config)", () => {
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

  it("falls back to ~/.evalguard/config.json when no env var is set", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "eg_from_login_flow", baseUrl: "https://custom.evalguard.test/api/v1" }) as never,
    );
    // No env var — must read the file written by `evalguard login`.
    expect(resolveApiKey()).toBe("eg_from_login_flow");
    expect(resolveBaseUrl()).toBe("https://custom.evalguard.test/api/v1");
  });

  it("env var takes precedence over the config file", () => {
    process.env.EVALGUARD_API_KEY = "eg_from_env";
    process.env.EVALGUARD_BASE_URL = "https://env.evalguard.test/api/v1";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "eg_from_file", baseUrl: "https://file.test/api/v1" }) as never,
    );
    expect(resolveApiKey()).toBe("eg_from_env");
    expect(resolveBaseUrl()).toBe("https://env.evalguard.test/api/v1");
  });

  it("returns undefined key + default base URL when neither env nor file is present", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveApiKey()).toBeUndefined();
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it("normalizes a config baseUrl that is missing the /api/v1 prefix", () => {
    // A config written by `evalguard login --url https://evalguard.ai` (before
    // login-time normalization) must still resolve to the versioned API root.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "eg_k", baseUrl: "https://evalguard.ai" }) as never,
    );
    expect(resolveBaseUrl()).toBe("https://evalguard.ai/api/v1");
  });

  it("normalizes an EVALGUARD_BASE_URL env var missing the /api/v1 prefix", () => {
    process.env.EVALGUARD_BASE_URL = "https://self-hosted.example.com/";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveBaseUrl()).toBe("https://self-hosted.example.com/api/v1");
  });
});
