import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { InMemoryPromptStore, serializePromptFile, type PromptFile } from "@evalguard/core";
import {
  registerPrompt,
  deriveContentFromTemplate,
  buildVersionFromPromptFile,
  buildConfigFromFlags,
  nextVersionNumber,
  pushPromptFile,
  pullPromptFile,
  deployPrompt,
} from "../prompt.js";
import { DeployLog, seededEnvironments } from "../../lib/environments.js";

/* A minimal valid .prompt file with a chat template. */
const CHAT_PROMPT_FILE: PromptFile = {
  config: {
    model: "gpt-4o",
    provider: "openai",
    endpoint: "chat",
    temperature: 0.7,
    maxTokens: -1,
  },
  template: [
    { role: "system", content: "You are a helpful coding assistant for {{language}}." },
    { role: "user", content: "{{question}}" },
  ],
  templateLanguage: "default",
};

describe("deriveContentFromTemplate", () => {
  it("returns empty string for no template", () => {
    expect(deriveContentFromTemplate(undefined)).toBe("");
  });

  it("returns a completion string verbatim", () => {
    expect(deriveContentFromTemplate("Summarize: {{text}}")).toBe("Summarize: {{text}}");
  });

  it("flattens a chat template into readable role blocks", () => {
    const content = deriveContentFromTemplate([
      { role: "system", content: "sys" },
      { role: "user", content: "hi", name: "bob" },
    ]);
    expect(content).toBe("system: sys\n\nuser(bob): hi");
  });
});

describe("buildVersionFromPromptFile", () => {
  it("builds a typed version and derives content", () => {
    const v = buildVersionFromPromptFile(CHAT_PROMPT_FILE, "coder", 3, "alice");
    expect(v.name).toBe("coder");
    expect(v.version).toBe(3);
    expect(v.createdBy).toBe("alice");
    expect(v.status).toBe("draft");
    expect(v.config?.model).toBe("gpt-4o");
    expect(v.template).toEqual(CHAT_PROMPT_FILE.template);
    expect(v.templateLanguage).toBe("default");
    expect(v.content).toContain("You are a helpful coding assistant");
    expect(v.metadata.model).toBe("gpt-4o");
  });

  it("throws on a structurally invalid config", () => {
    expect(() =>
      buildVersionFromPromptFile(
        { config: { model: "gpt-4o", topP: 5 } },
        "bad",
        1,
        "cli",
      ),
    ).toThrow(/Invalid prompt config.*topP/);
  });
});

describe("buildConfigFromFlags", () => {
  it("requires a model", () => {
    expect(() => buildConfigFromFlags({})).toThrow(/--model is required/);
  });

  it("parses numeric flags and validates them", () => {
    const config = buildConfigFromFlags({
      model: "gpt-4o",
      provider: "openai",
      temperature: "0.5",
      maxTokens: "1000",
      topP: "0.9",
      seed: "42",
    });
    expect(config).toMatchObject({
      model: "gpt-4o",
      provider: "openai",
      temperature: 0.5,
      maxTokens: 1000,
      topP: 0.9,
      seed: 42,
    });
  });

  it("rejects a non-numeric numeric flag", () => {
    expect(() => buildConfigFromFlags({ model: "x", temperature: "hot" })).toThrow(
      /--temperature must be a number/,
    );
  });

  it("accepts the reasoning-effort enum", () => {
    expect(buildConfigFromFlags({ model: "o1", reasoningEffort: "high" }).reasoningEffort).toBe(
      "high",
    );
  });

  it("accepts an integer reasoning-effort budget", () => {
    expect(buildConfigFromFlags({ model: "claude", reasoningEffort: "2048" }).reasoningEffort).toBe(
      2048,
    );
  });

  it("rejects an unparseable reasoning-effort value", () => {
    expect(() => buildConfigFromFlags({ model: "x", reasoningEffort: "ultra" })).toThrow(
      /--reasoning-effort must be one of/,
    );
  });

  it("collapses a single --stop to a string, multiple to an array", () => {
    expect(buildConfigFromFlags({ model: "x", stop: ["END"] }).stop).toBe("END");
    expect(buildConfigFromFlags({ model: "x", stop: ["A", "B"] }).stop).toEqual(["A", "B"]);
  });

  it("surfaces an out-of-range validation error", () => {
    expect(() => buildConfigFromFlags({ model: "x", presencePenalty: "9" })).toThrow(
      /presencePenalty/,
    );
  });
});

describe("push / pull round-trip", () => {
  it("push assigns v1 then v2, and pull re-serializes the latest losslessly", async () => {
    const store = new InMemoryPromptStore();
    const text = serializePromptFile(CHAT_PROMPT_FILE);

    const v1 = await pushPromptFile({ store, name: "coder", promptFileText: text, createdBy: "cli" });
    expect(v1.version).toBe(1);

    const v2 = await pushPromptFile({ store, name: "coder", promptFileText: text, createdBy: "cli" });
    expect(v2.version).toBe(2);

    const pulled = await pullPromptFile({ store, name: "coder" });
    // Round-trips back to the same canonical .prompt text.
    expect(pulled).toBe(text);
  });

  it("pull can target a specific version", async () => {
    const store = new InMemoryPromptStore();
    const completion: PromptFile = { config: { model: "gpt-4o" }, template: "v1 template" };
    const chat = CHAT_PROMPT_FILE;
    await pushPromptFile({ store, name: "p", promptFileText: serializePromptFile(completion), createdBy: "cli" });
    await pushPromptFile({ store, name: "p", promptFileText: serializePromptFile(chat), createdBy: "cli" });

    const pulledV1 = await pullPromptFile({ store, name: "p", version: 1 });
    expect(pulledV1).toBe(serializePromptFile(completion));
  });

  it("pull throws for a missing prompt", async () => {
    const store = new InMemoryPromptStore();
    await expect(pullPromptFile({ store, name: "ghost" })).rejects.toThrow(/not found/);
  });

  it("pull throws for a missing version", async () => {
    const store = new InMemoryPromptStore();
    await pushPromptFile({
      store,
      name: "p",
      promptFileText: serializePromptFile(CHAT_PROMPT_FILE),
      createdBy: "cli",
    });
    await expect(pullPromptFile({ store, name: "p", version: 99 })).rejects.toThrow(/version 99 not found/);
  });

  it("pull refuses a legacy content-only version (no typed config)", async () => {
    const store = new InMemoryPromptStore();
    await store.save("legacy", {
      name: "legacy",
      version: 1,
      content: "opaque prompt string",
      metadata: {},
      status: "draft",
      createdAt: new Date(),
      createdBy: "cli",
    });
    await expect(pullPromptFile({ store, name: "legacy" })).rejects.toThrow(/without a typed `config`/);
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1 for an unknown prompt", async () => {
    const store = new InMemoryPromptStore();
    expect(await nextVersionNumber(store, "new")).toBe(1);
  });
});

describe("deployPrompt", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-prompt-deploy-"));
    logFile = path.join(tmpDir, "deployments.json");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedStore(): Promise<InMemoryPromptStore> {
    const store = new InMemoryPromptStore();
    await pushPromptFile({
      store,
      name: "coder",
      promptFileText: serializePromptFile(CHAT_PROMPT_FILE),
      createdBy: "cli",
    });
    return store;
  }

  it("deploys the latest version to a seeded environment", async () => {
    const store = await seedStore();
    const deployLog = new DeployLog(logFile);
    const record = await deployPrompt({
      store,
      environments: seededEnvironments(),
      deployLog,
      name: "coder",
      env: "production",
      deployedBy: "alice",
    });
    expect(record.env).toBe("production");
    expect(record.version).toBe(1);
    expect(record.status).toBe("active");
    expect(record.deployedBy).toBe("alice");

    const entries = await deployLog.entriesFor("prompt", "coder");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ artifact: "prompt", env: "production", version: 1 });
  });

  it("rejects a deploy to an unknown environment", async () => {
    const store = await seedStore();
    await expect(
      deployPrompt({
        store,
        environments: seededEnvironments(),
        deployLog: new DeployLog(logFile),
        name: "coder",
        env: "mars",
        deployedBy: "cli",
      }),
    ).rejects.toThrow(/Unknown environment/);
  });

  it("throws for a missing prompt", async () => {
    const store = new InMemoryPromptStore();
    await expect(
      deployPrompt({
        store,
        environments: seededEnvironments(),
        deployLog: new DeployLog(logFile),
        name: "ghost",
        env: "production",
        deployedBy: "cli",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("registerPrompt", () => {
  it("registers the prompt group with push/pull/create/show/list/deploy subcommands", () => {
    const program = new Command();
    registerPrompt(program);
    const cmd = program.commands.find((c) => c.name() === "prompt");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(
      expect.arrayContaining(["push", "pull", "create", "show", "list", "deploy"]),
    );
  });
});
