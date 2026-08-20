import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerEnv, parseEnvironmentTag } from "../env.js";
import {
  loadEnvironments,
  saveEnvironments,
  addEnvironment,
  removeEnvironment,
  buildEnvironmentRegistry,
  seededEnvironments,
} from "../../lib/environments.js";

let tmpDir: string;
let envFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-env-"));
  envFile = path.join(tmpDir, "environments.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseEnvironmentTag", () => {
  it("defaults to 'other'", () => {
    expect(parseEnvironmentTag(undefined)).toBe("other");
  });
  it("accepts the known tags", () => {
    expect(parseEnvironmentTag("default")).toBe("default");
    expect(parseEnvironmentTag("other")).toBe("other");
  });
  it("rejects an unknown tag", () => {
    expect(() => parseEnvironmentTag("prod")).toThrow(/--tag must be one of/);
  });
});

describe("loadEnvironments", () => {
  it("returns seeded staging + production when the file is absent", async () => {
    const list = await loadEnvironments(envFile);
    expect(list.map((e) => e.name)).toEqual(["production", "staging"]);
    expect(list.find((e) => e.name === "production")?.tag).toBe("default");
  });

  it("round-trips saved environments", async () => {
    const seeded = seededEnvironments();
    await saveEnvironments(seeded, envFile);
    const loaded = await loadEnvironments(envFile);
    expect(loaded.map((e) => e.name)).toEqual(seeded.map((e) => e.name));
  });
});

describe("addEnvironment", () => {
  it("appends a new named environment", () => {
    const list = addEnvironment(seededEnvironments(), "eu-prod", "other");
    expect(list.map((e) => e.name)).toContain("eu-prod");
  });

  it("rejects a duplicate name via the core registry", () => {
    expect(() => addEnvironment(seededEnvironments(), "staging")).toThrow(/already exists/);
  });

  it("rejects a second 'default' environment via the core registry", () => {
    // production is already the seeded default.
    expect(() => addEnvironment(seededEnvironments(), "dr", "default")).toThrow(/default/);
  });
});

describe("removeEnvironment", () => {
  it("removes an existing environment", () => {
    const { list, removed } = removeEnvironment(seededEnvironments(), "staging");
    expect(removed).toBe(true);
    expect(list.map((e) => e.name)).not.toContain("staging");
  });

  it("reports not-removed for an unknown environment", () => {
    const { removed } = removeEnvironment(seededEnvironments(), "ghost");
    expect(removed).toBe(false);
  });
});

describe("buildEnvironmentRegistry", () => {
  it("produces a registry that rejects unknown deploy targets", () => {
    const reg = buildEnvironmentRegistry(seededEnvironments());
    expect(reg.hasEnvironment("production")).toBe(true);
    expect(() => reg.requireEnvironment("ghost")).toThrow(/Unknown environment/);
  });
});

describe("registerEnv", () => {
  it("registers the env group with list/create/remove subcommands", () => {
    const program = new Command();
    registerEnv(program);
    const cmd = program.commands.find((c) => c.name() === "env");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(["list", "create", "remove"]));
  });

  it("create then list persists a new environment end-to-end", async () => {
    const program = new Command();
    program.exitOverride();
    registerEnv(program);
    await program.parseAsync(
      ["node", "eg", "env", "create", "eu-prod", "--tag", "other", "--file", envFile],
    );
    const list = await loadEnvironments(envFile);
    expect(list.map((e) => e.name)).toContain("eu-prod");
  });
});
