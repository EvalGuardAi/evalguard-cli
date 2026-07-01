import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerEvalLocal } from "../commands/eval-local";

// sdk-cli-devplatform-9 — `eval:local --concurrency <n>` wired to the runner.

function evalLocalCommand(): Command {
  const program = new Command();
  registerEvalLocal(program);
  return program.commands.find((c) => c.name() === "eval:local")!;
}

describe("eval:local --concurrency flag", () => {
  it("registers a --concurrency <n> option", () => {
    const cmd = evalLocalCommand();
    const opt = cmd.options.find((o) => o.flags.includes("--concurrency"));
    expect(opt).toBeDefined();
    expect(opt!.flags).toContain("--concurrency <n>");
  });

  it("clamps the parsed value to a minimum of 1 (rejects 0 / negatives / garbage)", () => {
    const cmd = evalLocalCommand();
    const opt = cmd.options.find((o) => o.flags.includes("--concurrency"))!;
    const coerce = (opt as unknown as { parseArg: (v: string) => number }).parseArg;
    expect(coerce("4")).toBe(4);
    expect(coerce("1")).toBe(1);
    expect(coerce("0")).toBe(1);
    expect(coerce("-5")).toBe(1);
    expect(coerce("abc")).toBe(1);
  });
});
