import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { InMemoryToolStore, type ToolConfig } from "@evalguard/core";
import {
  registerTool,
  parseToolConfigText,
  pushToolConfig,
  pullToolConfig,
  deployTool,
} from "../tool.js";
import { DeployLog, seededEnvironments } from "../../lib/environments.js";

/* A minimal valid tool config (function spec, reusing the prompt ToolFunction). */
const WEATHER_CONFIG: ToolConfig = {
  function: {
    name: "get_weather",
    description: "Look up the current weather for a city.",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const SOURCE_CONFIG: ToolConfig = {
  sourceCode: "def add(a, b):\n    return a + b\n",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-tool-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseToolConfigText", () => {
  it("parses + validates a function config", () => {
    const cfg = parseToolConfigText(JSON.stringify(WEATHER_CONFIG));
    expect(cfg.function?.name).toBe("get_weather");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseToolConfigText("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object", () => {
    expect(() => parseToolConfigText("[]")).toThrow(/must be a JSON object/);
  });

  it("rejects a config with neither function nor sourceCode", () => {
    expect(() => parseToolConfigText("{}")).toThrow(/function.*sourceCode/);
  });
});

describe("push / pull round-trip", () => {
  it("push assigns v1 then v2 for distinct configs; pull re-serializes", async () => {
    const store = new InMemoryToolStore();
    const r1 = await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(WEATHER_CONFIG),
      createdBy: "cli",
    });
    expect(r1.version.version).toBe(1);
    expect(r1.deduped).toBe(false);

    const r2 = await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(SOURCE_CONFIG),
      createdBy: "cli",
    });
    expect(r2.version.version).toBe(2);

    const pulled = await pullToolConfig({ store, name: "weather", version: 1 });
    expect(JSON.parse(pulled)).toEqual(WEATHER_CONFIG);
  });

  it("de-dups an identical config (no new version, same versionId)", async () => {
    const store = new InMemoryToolStore();
    const a = await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(WEATHER_CONFIG),
      createdBy: "cli",
    });
    const b = await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(WEATHER_CONFIG),
      createdBy: "cli",
    });
    expect(b.deduped).toBe(true);
    expect(b.version.version).toBe(a.version.version);
    expect(b.version.versionId).toBe(a.version.versionId);
  });

  it("pull throws for a missing tool", async () => {
    const store = new InMemoryToolStore();
    await expect(pullToolConfig({ store, name: "ghost" })).rejects.toThrow(/not found/);
  });

  it("pull throws for a missing version", async () => {
    const store = new InMemoryToolStore();
    await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(WEATHER_CONFIG),
      createdBy: "cli",
    });
    await expect(pullToolConfig({ store, name: "weather", version: 99 })).rejects.toThrow(
      /version 99 not found/,
    );
  });
});

describe("deployTool", () => {
  async function seedStore(): Promise<InMemoryToolStore> {
    const store = new InMemoryToolStore();
    await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(WEATHER_CONFIG),
      createdBy: "cli",
    });
    await pushToolConfig({
      store,
      name: "weather",
      toolConfigText: JSON.stringify(SOURCE_CONFIG),
      createdBy: "cli",
    });
    return store;
  }

  it("deploys the latest version to a seeded environment", async () => {
    const store = await seedStore();
    const deployLog = new DeployLog(path.join(tmpDir, "deployments.json"));
    const record = await deployTool({
      store,
      environments: seededEnvironments(),
      deployLog,
      name: "weather",
      env: "production",
      deployedBy: "alice",
    });
    expect(record.env).toBe("production");
    expect(record.version).toBe(2);
    expect(record.status).toBe("active");
    expect(record.deployedBy).toBe("alice");
  });

  it("deploys a specific version and records it in the log", async () => {
    const store = await seedStore();
    const logFile = path.join(tmpDir, "deployments.json");
    const deployLog = new DeployLog(logFile);
    await deployTool({
      store,
      environments: seededEnvironments(),
      deployLog,
      name: "weather",
      env: "staging",
      version: 1,
      deployedBy: "cli",
    });
    const entries = await deployLog.entriesFor("tool", "weather");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ env: "staging", version: 1, artifact: "tool" });
  });

  it("links previousDeploymentId when redeploying to the same env", async () => {
    const store = await seedStore();
    const deployLog = new DeployLog(path.join(tmpDir, "deployments.json"));
    await deployTool({
      store,
      environments: seededEnvironments(),
      deployLog,
      name: "weather",
      env: "production",
      version: 1,
      deployedBy: "cli",
    });
    const second = await deployTool({
      store,
      environments: seededEnvironments(),
      deployLog,
      name: "weather",
      env: "production",
      version: 2,
      deployedBy: "cli",
    });
    expect(second.previousDeploymentId).toBeDefined();
    expect(second.version).toBe(2);
  });

  it("rejects a deploy to an unknown environment", async () => {
    const store = await seedStore();
    const deployLog = new DeployLog(path.join(tmpDir, "deployments.json"));
    await expect(
      deployTool({
        store,
        environments: seededEnvironments(),
        deployLog,
        name: "weather",
        env: "mars",
        deployedBy: "cli",
      }),
    ).rejects.toThrow(/Unknown environment/);
  });

  it("throws for an unknown tool", async () => {
    const store = new InMemoryToolStore();
    const deployLog = new DeployLog(path.join(tmpDir, "deployments.json"));
    await expect(
      deployTool({
        store,
        environments: seededEnvironments(),
        deployLog,
        name: "ghost",
        env: "production",
        deployedBy: "cli",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("registerTool", () => {
  it("registers the tool group with push/pull/list/show/deploy subcommands", () => {
    const program = new Command();
    registerTool(program);
    const cmd = program.commands.find((c) => c.name() === "tool");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(["push", "pull", "list", "show", "deploy"]));
  });
});
