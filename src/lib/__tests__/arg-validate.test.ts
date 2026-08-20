import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EXIT_INVALID_ARGUMENT,
  assertChronological,
  parseCountFlag,
  parseCurrencyFlag,
  parseHttpUrlFlag,
  parseIsoDateFlag,
  parseNonNegativeIntFlag,
  parseUnitIntervalFlag,
  parseUuidArg,
  requireNonEmptyFlag,
} from "../arg-validate.js";

/**
 * Unit floor for the argument boundary.
 *
 * The command-level RED/GREEN proof lives in
 * `commands/__tests__/argument-validation.test.ts` — this file pins the
 * validators themselves, and in particular pins the thing that makes a
 * validator worth having: EVERY "rejects X" case is paired with a "still
 * accepts the valid form of X" case.
 *
 * A validator that rejects everything passes every rejection test ever
 * written and breaks every working CI job. The positive controls are not
 * padding; they are the half of the contract that is easy to lose.
 */

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

const REFUSED = `EXIT:${EXIT_INVALID_ARGUMENT}`;

describe("the exit-code convention", () => {
  it("refuses with 2, not 1 — a usage error is not a failed run", () => {
    expect(EXIT_INVALID_ARGUMENT).toBe(2);
    // Same code and same message shape as the one pre-existing correct
    // instance, `scorecard --fail-below` (lib/gate-threshold.ts).
    expect(() => requireNonEmptyFlag("", "--project", "consequence")).toThrow(REFUSED);
  });

  it("names the CONSEQUENCE, not just the flag", () => {
    expect(() => requireNonEmptyFlag("", "--project", "would have used the DEFAULT project")).toThrow();
    const printed = errSpy.mock.calls.flat().join(" ");
    expect(printed).toContain("--project");
    expect(printed).toContain("would have used the DEFAULT project");
  });
});

describe("requireNonEmptyFlag", () => {
  it.each(["", "   ", "\t"])("refuses %j — an empty flag value is a caller error", (bad) => {
    expect(() => requireNonEmptyFlag(bad, "--project", "c")).toThrow(REFUSED);
  });

  it("POSITIVE CONTROL: a real value passes through, trimmed", () => {
    expect(requireNonEmptyFlag("abc", "--project", "c")).toBe("abc");
    expect(requireNonEmptyFlag("  abc  ", "--project", "c")).toBe("abc");
  });

  it("POSITIVE CONTROL: an ABSENT flag is not an empty flag", () => {
    // The distinction the whole fix rests on: `--project ""` is an error,
    // omitting `--project` is the documented default-project path.
    expect(requireNonEmptyFlag(undefined, "--project", "c")).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parseCountFlag", () => {
  it.each(["abc", "2.7", "-5", "0", "", "  ", "1e3x", "NaN", "Infinity"])(
    "refuses %j",
    (bad) => {
      expect(() => parseCountFlag(bad, "--limit", { max: 200, consequence: "c" })).toThrow(REFUSED);
    },
  );

  it("refuses a value above the route's own ceiling, and says the ceiling", () => {
    expect(() => parseCountFlag("99999999999", "--limit", { max: 200, consequence: "c" })).toThrow(REFUSED);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("200");
  });

  it("POSITIVE CONTROL: 1, a mid value, and exactly the ceiling all pass", () => {
    expect(parseCountFlag("1", "--limit", { max: 200, consequence: "c" })).toBe(1);
    expect(parseCountFlag("25", "--limit", { max: 200, consequence: "c" })).toBe(25);
    expect(parseCountFlag("200", "--limit", { max: 200, consequence: "c" })).toBe(200);
    // The Commander DEFAULTS every call site declares must survive their own
    // validator — otherwise the fix breaks the no-flags path for all five
    // list commands.
    expect(parseCountFlag("50", "--limit", { max: 200, consequence: "c" })).toBe(50);
    expect(parseCountFlag("100", "--limit", { max: 10_000, consequence: "c" })).toBe(100);
    expect(parseCountFlag("20", "--limit", { max: 200, consequence: "c" })).toBe(20);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: absent stays absent", () => {
    expect(parseCountFlag(undefined, "--limit", { max: 200, consequence: "c" })).toBeUndefined();
  });
});

describe("parseNonNegativeIntFlag (--sample: 0 is meaningful)", () => {
  it.each(["-1", "1.5", "abc", ""])("refuses %j", (bad) => {
    expect(() => parseNonNegativeIntFlag(bad, "--sample", "c")).toThrow(REFUSED);
  });

  it("POSITIVE CONTROL: 0 and a positive integer both pass", () => {
    expect(parseNonNegativeIntFlag("0", "--sample", "c")).toBe(0);
    expect(parseNonNegativeIntFlag("5", "--sample", "c")).toBe(5);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parseUnitIntervalFlag (--threshold)", () => {
  it.each(["abc", "", "  ", "NaN", "Infinity", "0.7x"])("refuses %j", (bad) => {
    expect(() => parseUnitIntervalFlag(bad, "--threshold", "c")).toThrow(REFUSED);
  });

  it.each(["5", "-0.1", "1.0001", "100"])("refuses %j — outside 0..1 the gate can never fire", (bad) => {
    expect(() => parseUnitIntervalFlag(bad, "--threshold", "c")).toThrow(REFUSED);
  });

  it("pins the original defect directly: parseFloat ACCEPTED all of these", () => {
    // What Commander used to do with the flag, stated so the regression is
    // legible without archaeology.
    expect(Number.isNaN(parseFloat("abc"))).toBe(true); // → JSON null → flag dropped
    expect(parseFloat("0.7x")).toBe(0.7); // → silent truncation
    expect(parseFloat("5")).toBe(5); // → un-fireable gate
  });

  it("POSITIVE CONTROL: the documented range, including both endpoints", () => {
    expect(parseUnitIntervalFlag("0", "--threshold", "c")).toBe(0);
    expect(parseUnitIntervalFlag("0.7", "--threshold", "c")).toBe(0.7);
    expect(parseUnitIntervalFlag("1", "--threshold", "c")).toBe(1);
    expect(parseUnitIntervalFlag(" 0.5 ", "--threshold", "c")).toBe(0.5);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parseIsoDateFlag / assertChronological", () => {
  it.each(["not-a-date", "", "  ", "2026-13-45"])("refuses %j", (bad) => {
    expect(() => parseIsoDateFlag(bad, "--start", "c")).toThrow(REFUSED);
  });

  it("POSITIVE CONTROL: a plain date and a full instant both parse", () => {
    expect(parseIsoDateFlag("2026-05-01", "--start", "c")?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(parseIsoDateFlag("2026-05-01T12:30:00Z", "--start", "c")?.toISOString()).toBe(
      "2026-05-01T12:30:00.000Z",
    );
    expect(parseIsoDateFlag(undefined, "--start", "c")).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses an INVERTED range", () => {
    expect(() =>
      assertChronological(new Date("2026-08-09"), new Date("2026-08-01"), "--start", "--end", "c"),
    ).toThrow(REFUSED);
  });

  it("POSITIVE CONTROL: forward ranges, equal bounds, and half-open ranges all pass", () => {
    assertChronological(new Date("2026-08-01"), new Date("2026-08-09"), "--start", "--end", "c");
    // A single-instant window is a legitimate query, not an inversion.
    assertChronological(new Date("2026-08-01"), new Date("2026-08-01"), "--start", "--end", "c");
    assertChronological(undefined, new Date("2026-08-01"), "--start", "--end", "c");
    assertChronological(new Date("2026-08-01"), undefined, "--start", "--end", "c");
    assertChronological(undefined, undefined, "--start", "--end", "c");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parseCurrencyFlag", () => {
  it.each(["NOTACURRENCY", "US", "USDD", "12", "$", "US1"])("refuses %j on SHAPE", (bad) => {
    expect(() => parseCurrencyFlag(bad, "--currency", "c")).toThrow(REFUSED);
  });

  it("the shape rule is the SERVER's rule, copied", () => {
    // apps/web/.../cost/export/route.ts#sanitizeCurrency:
    //   const c = raw.trim().toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : undefined;
    // Anything that fails it is silently replaced with USD, which is why the
    // shape — and only the shape — is a hard refusal here.
    const serverRule = (raw: string) => /^[A-Z]{3}$/.test(raw.trim().toUpperCase());
    for (const bad of ["NOTACURRENCY", "US", "USDD"]) expect(serverRule(bad)).toBe(false);
    for (const good of ["usd", " EUR ", "AED"]) expect(serverRule(good)).toBe(true);
  });

  it("POSITIVE CONTROL: real codes pass, normalized to upper case", () => {
    expect(parseCurrencyFlag("usd", "--currency", "c")).toBe("USD");
    expect(parseCurrencyFlag(" eur ", "--currency", "c")).toBe("EUR");
    expect(parseCurrencyFlag("AED", "--currency", "c")).toBe("AED");
    expect(parseCurrencyFlag(undefined, "--currency", "c")).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("WARNS (never refuses) on a well-formed code this runtime does not know", () => {
    // Deliberately NOT a refusal: ICU's enumeration is missing live ISO-4217
    // codes, so refusing on it would break correct invocations. Verified on
    // Node 24: `VED` (Venezuelan bolívar digital) and `XAU` (gold) are both
    // absent from Intl.supportedValuesOf("currency").
    expect(parseCurrencyFlag("XQZ", "--currency", "c")).toBe("XQZ");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("parseUuidArg", () => {
  it.each(["not-a-uuid", "", "../../scorers", "12345", "00000000-0000-4000-8000-00000000000"])(
    "refuses %j",
    (bad) => {
      expect(() => parseUuidArg(bad, "eval run id", "c")).toThrow(REFUSED);
    },
  );

  it("POSITIVE CONTROL: v4 and non-v4 UUIDs both pass — the loose shape is deliberate", () => {
    // Refusing a legitimately-stored non-v4 id would be the over-strict
    // failure this module exists to avoid, so the regex matches the one
    // `traces get` / `webhooks test` have always used.
    expect(parseUuidArg("00000000-0000-4000-8000-0000000000a2", "id", "c")).toBe(
      "00000000-0000-4000-8000-0000000000a2",
    );
    expect(parseUuidArg("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "id", "c")).toBe(
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    );
    expect(parseUuidArg("  00000000-0000-4000-8000-0000000000A2  ", "id", "c")).toBe(
      "00000000-0000-4000-8000-0000000000A2",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("parseHttpUrlFlag", () => {
  it.each(["not a url", "", "example.com/a.png", "file:///etc/passwd", "gopher://x/1"])(
    "refuses %j",
    (bad) => {
      expect(() => parseHttpUrlFlag(bad, "--url", "c")).toThrow(REFUSED);
    },
  );

  it("POSITIVE CONTROL: http and https URLs pass unchanged", () => {
    expect(parseHttpUrlFlag("https://e.test/a.png", "--url", "c")).toBe("https://e.test/a.png");
    expect(parseHttpUrlFlag("http://e.test/a.png?x=1#f", "--url", "c")).toBe("http://e.test/a.png?x=1#f");
    expect(parseHttpUrlFlag(undefined, "--url", "c")).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
