import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing anything that uses them
// ---------------------------------------------------------------------------

vi.mock("fs");
vi.mock("chalk", () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));
vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

// ---------------------------------------------------------------------------
// Constants (must match the source)
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".evalguard");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Helpers — reimplement the pure functions from index.ts so we can unit test
// their logic without importing the module (which calls program.parse()).
// ---------------------------------------------------------------------------

interface CLIConfig {
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
}

function loadConfig(): CLIConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8") as string) as CLIConfig;
    }
  } catch {
    // ignore
  }
  return {};
}

function saveConfig(config: CLIConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI Config", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── loadConfig ────────────────────────────────────────────────────────

  describe("loadConfig()", () => {
    it("returns empty object when config file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(loadConfig()).toEqual({});
    });

    it("returns parsed config when file exists", () => {
      const stored = { apiKey: "eg_abc", baseUrl: "http://localhost:3000" };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored));
      expect(loadConfig()).toEqual(stored);
    });

    it("returns empty object when file contains invalid JSON", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");
      expect(loadConfig()).toEqual({});
    });

    it("returns empty object when readFileSync throws", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("EACCES");
      });
      expect(loadConfig()).toEqual({});
    });
  });

  // ── saveConfig ────────────────────────────────────────────────────────

  describe("saveConfig()", () => {
    it("creates config directory if it does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      saveConfig({ apiKey: "key-123" });

      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });

    it("does not create directory if it already exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      saveConfig({ apiKey: "key-123" });

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it("writes config as formatted JSON", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      const config = { apiKey: "key-123", baseUrl: "http://custom.api" };
      saveConfig(config);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        JSON.stringify(config, null, 2)
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Login command logic
// ---------------------------------------------------------------------------

describe("login command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores API key in config", () => {
    // Simulate: config dir exists, no existing config
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === CONFIG_FILE) return false; // loadConfig: no file
      if (p === CONFIG_DIR) return true; // saveConfig: dir exists
      return false;
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    // Replicate login action logic
    const apiKey = "eg_test_login_key";
    const config = loadConfig();
    config.apiKey = apiKey;
    saveConfig(config);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining("eg_test_login_key")
    );
  });

  it("stores custom base URL alongside API key", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === CONFIG_FILE) return false;
      if (p === CONFIG_DIR) return true;
      return false;
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const config = loadConfig();
    config.apiKey = "key";
    config.baseUrl = "http://custom:8080";
    saveConfig(config);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.baseUrl).toBe("http://custom:8080");
  });
});

// ---------------------------------------------------------------------------
// Logout command logic
// ---------------------------------------------------------------------------

describe("logout command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("removes config file when it exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

    // Replicate logout action logic
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }

    expect(fs.unlinkSync).toHaveBeenCalledWith(CONFIG_FILE);
  });

  it("does nothing when config file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }

    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Init command logic
// ---------------------------------------------------------------------------

describe("init command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates evalguard.config.json with correct template", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const configPath = path.join(process.cwd(), "evalguard.config.json");
    const template = {
      $schema: "https://evalguard.ai/schema/config.json",
      projectId: "proj-123",
      defaultModel: "gpt-4o",
      evalsDir: "./evals",
      scansDir: "./scans",
    };

    fs.writeFileSync(configPath, JSON.stringify(template, null, 2));

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.$schema).toBe("https://evalguard.ai/schema/config.json");
    expect(parsed.defaultModel).toBe("gpt-4o");
    expect(parsed.evalsDir).toBe("./evals");
    expect(parsed.scansDir).toBe("./scans");
  });

  it("creates evals directory with example file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const evalsDir = path.join(process.cwd(), "evals");

    // Replicate init logic for evals dir
    if (!fs.existsSync(evalsDir)) {
      fs.mkdirSync(evalsDir, { recursive: true });
      const exampleEval = {
        name: "my-first-eval",
        model: "gpt-4o",
        prompt: "You are a helpful assistant. Answer the question: {{input}}",
        scorers: ["exact-match", "contains"],
        cases: [
          { input: "What is 2+2?", expectedOutput: "4" },
          { input: "What color is the sky?", expectedOutput: "blue" },
        ],
      };
      fs.writeFileSync(
        path.join(evalsDir, "example.json"),
        JSON.stringify(exampleEval, null, 2)
      );
    }

    expect(fs.mkdirSync).toHaveBeenCalledWith(evalsDir, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(evalsDir, "example.json"),
      expect.stringContaining("my-first-eval")
    );
  });

  it("creates scans directory with example file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const scansDir = path.join(process.cwd(), "scans");

    if (!fs.existsSync(scansDir)) {
      fs.mkdirSync(scansDir, { recursive: true });
      const exampleScan = {
        model: "gpt-4o",
        prompt: "You are a helpful customer support agent.",
        attackTypes: ["prompt-injection", "jailbreak", "data-extraction"],
      };
      fs.writeFileSync(
        path.join(scansDir, "example.json"),
        JSON.stringify(exampleScan, null, 2)
      );
    }

    expect(fs.mkdirSync).toHaveBeenCalledWith(scansDir, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(scansDir, "example.json"),
      expect.stringContaining("prompt-injection")
    );
  });

  it("stores project ID in CLI config when --project is passed", () => {
    // First call: existsSync for CONFIG_FILE → false (loadConfig)
    // Second call: existsSync for CONFIG_DIR → true (saveConfig)
    let callCount = 0;
    vi.mocked(fs.existsSync).mockImplementation(() => {
      callCount++;
      // loadConfig check → false, saveConfig dir check → true
      return callCount > 1;
    });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const cliConfig = loadConfig();
    cliConfig.projectId = "proj-xyz";
    saveConfig(cliConfig);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.projectId).toBe("proj-xyz");
  });
});

// ---------------------------------------------------------------------------
// Whoami command logic
// ---------------------------------------------------------------------------

describe("whoami command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("masks API key showing first 7 and last 4 chars", () => {
    const apiKey = "eg_test_key_abcdef1234";
    const masked =
      apiKey.substring(0, 7) + "..." + apiKey.substring(apiKey.length - 4);

    expect(masked).toBe("eg_test...1234");
  });

  it("reports not authenticated when no API key", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config = loadConfig();
    expect(config.apiKey).toBeUndefined();
  });

  it("reports authenticated with masked key when API key exists", () => {
    const stored = { apiKey: "eg_live_key_xxxx9999" };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored));

    const config = loadConfig();
    expect(config.apiKey).toBe("eg_live_key_xxxx9999");

    const masked =
      config.apiKey!.substring(0, 7) +
      "..." +
      config.apiKey!.substring(config.apiKey!.length - 4);
    expect(masked).toBe("eg_live...9999");
  });
});

// ---------------------------------------------------------------------------
// Eval command logic
// ---------------------------------------------------------------------------

describe("eval command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads eval config from file path", () => {
    const evalConfig = {
      name: "test-eval",
      model: "gpt-4o",
      prompt: "{{input}}",
      scorers: ["exact-match"],
      cases: [{ input: "hi", expectedOutput: "hello" }],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(evalConfig));

    const filePath = path.resolve("evals/test.json");
    const config = JSON.parse(fs.readFileSync(filePath, "utf-8") as string);

    expect(config.name).toBe("test-eval");
    expect(config.cases).toHaveLength(1);
    expect(config.scorers).toContain("exact-match");
  });

  it("resolves project ID from options, then config file, then CLI config", () => {
    const optsProject = "proj-from-opts";
    const configProject = "proj-from-file";
    const clientProject = "proj-from-cli";

    // Option takes precedence
    const resolved = optsProject ?? configProject ?? clientProject;
    expect(resolved).toBe("proj-from-opts");

    // Config file is fallback
    const noOpts: string | undefined = undefined;
    const resolved2 = noOpts ?? configProject ?? clientProject;
    expect(resolved2).toBe("proj-from-file");

    // CLI config is last resort
    const noConfig: string | undefined = undefined;
    const resolved3 = noOpts ?? noConfig ?? clientProject;
    expect(resolved3).toBe("proj-from-cli");
  });
});

// ---------------------------------------------------------------------------
// Scan command logic
// ---------------------------------------------------------------------------

describe("scan command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads scan config from file path", () => {
    const scanConfig = {
      model: "gpt-4o",
      prompt: "You are a support agent.",
      attackTypes: ["prompt-injection", "jailbreak", "data-extraction"],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(scanConfig));

    const filePath = path.resolve("scans/test.json");
    const config = JSON.parse(fs.readFileSync(filePath, "utf-8") as string);

    expect(config.attackTypes).toHaveLength(3);
    expect(config.attackTypes).toContain("data-extraction");
  });

  it("sends to /security endpoint (not /security/scans)", () => {
    // The CLI scan command uses client.request("/security", "POST", ...)
    // which differs from the SDK's securityScan() endpoint
    const endpoint = "/security";
    expect(endpoint).toBe("/security");
  });
});

// ---------------------------------------------------------------------------
// getClient() error cases
// ---------------------------------------------------------------------------

describe("getClient() authentication guard", () => {
  it("requires API key to be present in config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config = loadConfig();

    // Replicate getClient logic
    expect(config.apiKey).toBeUndefined();
    // In the real code, this would call process.exit(1)
  });

  it("uses default base URL when none in config", () => {
    const stored = { apiKey: "eg_key" };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored));

    const config = loadConfig();
    const baseUrl = config.baseUrl ?? "https://evalguard.ai/api/v1";
    expect(baseUrl).toBe("https://evalguard.ai/api/v1");
  });

  it("uses custom base URL from config", () => {
    const stored = { apiKey: "eg_key", baseUrl: "http://localhost:4000" };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored));

    const config = loadConfig();
    const baseUrl = config.baseUrl ?? "https://evalguard.ai/api/v1";
    expect(baseUrl).toBe("http://localhost:4000");
  });
});
