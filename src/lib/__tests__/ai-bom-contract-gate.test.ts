/**
 * GATE — the AI-BOM document contract, per format.
 *
 * ─── Why this file exists ──────────────────────────────────────────────────
 *
 * `274d40a40` put a boundary in front of `ai-bom export` because the command
 * was writing nginx 502 pages, 0-byte bodies and 2 MB of filler to disk as
 * SBOMs, exit 0, followed by "• Validate: cyclonedx validate …". That boundary
 * knew exactly ONE document contract — `bomFormat` + `specVersion` +
 * `components` — because the route emitted one document and relabelled it.
 *
 * `45f06d350` made the route emit three real documents. SPDX 2.3's root is
 * `additionalProperties: false`, so a CONFORMANT SPDX document cannot carry any
 * of those three keys, and `--format spdx` broke end to end: the server's own
 * correct output was refused with "it declares no `bomFormat`".
 *
 * There were two ways to unbreak it. Loosen the check — which hands the 502
 * page back its exit 0. Or teach it the second standard. This gate exists to
 * keep the second answer from decaying into the first, and it fails on the two
 * ways that decay happens:
 *
 *   1. A FORMAT IS ADDED WITHOUT A CONTRACT. `Record<AiBomFormat, AiBomContract>`
 *      makes that a compile error, and `isAiBomFormat` keeps the command's
 *      accept-list from being a second, divergent hand-written list — but a cast
 *      defeats both, so the set identities are also asserted here at runtime,
 *      along with the requirement that a contract actually constrain something.
 *
 *   2. A CONTRACT STOPS REJECTING THE FAULT SET. Every format is driven against
 *      every fault, INCLUDING the other formats' perfectly valid documents,
 *      which is the failure mode a format-aware validator newly makes possible.
 *      Each fault row also asserts a POSITIVE CONTROL — the same format's valid
 *      document, accepted through the same call — so a row can never pass
 *      because the check refuses everything.
 *
 *   3. EVERY INDIVIDUAL RULE BITES. A contract that lists four rules and
 *      enforces one still passes a fault set of obvious garbage. So each rule
 *      is mutated out of a valid document, one at a time, and the result must
 *      be refused.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_BOM_FORMATS,
  AI_BOM_MARKERS,
  type AiBomContract,
  type AiBomFieldRule,
  type AiBomFormat,
  isAiBomFormat,
  readArtifactBody,
} from "../http.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── the documents ───────────────────────────────────────────────────────── */

/**
 * A valid document per format, with the fields
 * `apps/web/src/app/api/v1/ai-sbom/_formats.ts` actually emits.
 *
 * Deliberately fuller than the contract requires: a fixture trimmed to exactly
 * the required keys cannot show that the contract accepts a REAL export, only
 * that it accepts its own rule list.
 */
const VALID: Record<AiBomFormat, Record<string, unknown>> = {
  // buildCycloneDx16 — CycloneDX 1.6 ML-BOM
  cyclonedx: {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:3f2c1a9e-7b41-4d2e-9a6f-0c8d5e1b2a34",
    version: 1,
    metadata: { timestamp: "2026-08-09T12:00:00.000Z", component: { "bom-ref": "evalguard:root" } },
    components: [{ "bom-ref": "evalguard:model:0", type: "machine-learning-model", name: "llama" }],
    dependencies: [{ ref: "evalguard:root", dependsOn: ["evalguard:model:0"] }],
  },
  // buildSpdx23 — SPDX 2.3
  spdx: {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "evalguard-ai-bom-3f2c1a9e",
    documentNamespace: "https://evalguard.ai/spdx/ai-bom/3f2c1a9e/1111",
    creationInfo: { created: "2026-08-09T12:00:00Z", creators: ["Organization: EvalGuard"] },
    packages: [{ SPDXID: "SPDXRef-Package-Project", name: "project-3f2c1a9e", filesAnalyzed: false }],
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relatedSpdxElement: "SPDXRef-Package-Project", relationshipType: "DESCRIBES" },
    ],
  },
  // buildNativeAiBom — the native document, delivered inside {success,data}
  json: {
    bomFormat: "EvalGuard-AIBOM",
    specVersion: "1.0.0",
    version: 1,
    metadata: { timestamp: "2026-08-09T12:00:00.000Z" },
    components: { models: [], dependencies: [] },
    vulnerabilities: [],
    supplyChainRisk: { overallScore: 1, factors: [] },
  },
};

/** Wire format: `json` arrives enveloped, the other two bare — as the route sends them. */
function onTheWire(format: AiBomFormat): string {
  const doc = VALID[format];
  return AI_BOM_MARKERS[format].enveloped
    ? JSON.stringify({ success: true, data: doc })
    : JSON.stringify(doc, null, 2);
}

/** Drive the REAL boundary for `format` over a body. Resolves = ACCEPTED. */
function read(format: AiBomFormat, body: string, status = 200): Promise<string> {
  return readArtifactBody(new Response(status === 204 ? null : body, { status }), {
    endpoint: `GET /ai-sbom?format=${format}`,
    format: "ai-bom",
    contract: AI_BOM_MARKERS[format],
    what: "AI-BOM",
  });
}

async function accepted(format: AiBomFormat, body: string, status = 200): Promise<boolean> {
  try {
    await read(format, body, status);
    return true;
  } catch {
    return false;
  }
}

/* ── 1. every advertised format has a real contract ──────────────────────── */

/**
 * The contract every format MUST carry, restated HERE from the standards
 * instead of read back out of the implementation.
 *
 * This table is the reason the gate has teeth. The per-rule mutation tests
 * further down are GENERATED from `AI_BOM_MARKERS`, so loosening a rule also
 * deletes the test that would have caught the loosening — measured: changing
 * SPDX's `packages` from `array` to `present` took the suite from 66 tests to
 * 65 and still reported "passed". A gate whose coverage is derived from the
 * thing it guards can be switched off by editing the thing it guards.
 *
 * So the expectation is written down independently, from the specs:
 *
 *   CycloneDX 1.6  root required ["bomFormat","specVersion"], bomFormat enum
 *                  ["CycloneDX"], inventory in `components`.
 *   SPDX 2.3       root required ["SPDXID","creationInfo","dataLicense","name",
 *                  "spdxVersion"], root additionalProperties:false, inventory
 *                  in `packages`, which the schema types as an ARRAY.
 *   EvalGuard      the native document; not a standard, so its own marker.
 *
 * Changing a contract means changing this table too, in a diff a reviewer can
 * see and check against the spec.
 */
const EXPECTED: Record<AiBomFormat, { enveloped: boolean; require: AiBomFieldRule[] }> = {
  cyclonedx: {
    enveloped: false,
    require: [
      { key: "bomFormat", kind: "marker", equals: "CycloneDX" },
      { key: "specVersion", kind: "string" },
      { key: "components", kind: "present" },
    ],
  },
  spdx: {
    enveloped: false,
    require: [
      { key: "spdxVersion", kind: "marker", equals: "SPDX-2.3" },
      { key: "SPDXID", kind: "string" },
      { key: "packages", kind: "array" },
    ],
  },
  json: {
    enveloped: true,
    require: [
      { key: "bomFormat", kind: "marker", equals: "EvalGuard-AIBOM" },
      { key: "specVersion", kind: "string" },
      { key: "components", kind: "present" },
    ],
  },
};

describe("every format the CLI advertises has a contract", () => {
  it("each contract is EXACTLY the one its standard requires — no rule may be weakened or dropped", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...AI_BOM_FORMATS].sort());
    for (const format of AI_BOM_FORMATS) {
      expect(AI_BOM_MARKERS[format].require, `${format} rule set drifted from the standard`).toEqual(
        EXPECTED[format].require,
      );
      expect(AI_BOM_MARKERS[format].enveloped).toBe(EXPECTED[format].enveloped);
    }
  });

  it("AI_BOM_FORMATS and the contract table are the SAME set, self-consistently keyed", () => {
    expect([...AI_BOM_FORMATS].sort()).toEqual(Object.keys(AI_BOM_MARKERS).sort());
    for (const [key, contract] of Object.entries(AI_BOM_MARKERS)) {
      expect(contract.format).toBe(key);
    }
    // A fixture exists for each — otherwise the fault matrix below silently
    // skips the new format instead of covering it.
    expect([...AI_BOM_FORMATS].sort()).toEqual(Object.keys(VALID).sort());
  });

  it("isAiBomFormat is the accept-list, and `ai-bom export` uses IT rather than its own", () => {
    for (const f of AI_BOM_FORMATS) expect(isAiBomFormat(f)).toBe(true);
    // Negatives that can never become real formats — a plausible future name
    // here (e.g. "spdx3") would make this row fail on the day it is legitimately
    // added, which trains people to edit the gate instead of reading it.
    for (const nope of ["", " ", "CycloneDX", "cyclonedx ", "__proto__", "toString", "constructor"]) {
      expect(isAiBomFormat(nope)).toBe(false);
    }
    const src = fs.readFileSync(path.join(HERE, "..", "..", "commands", "ai-bom.ts"), "utf-8");
    expect(src).toContain("isAiBomFormat(fmt)");
  });

  it("no contract is a token contract — each names a checked marker AND a structural field", () => {
    for (const format of AI_BOM_FORMATS) {
      const c: AiBomContract = AI_BOM_MARKERS[format];
      const markers = c.require.filter((r) => r.kind === "marker");
      const structural = c.require.filter((r) => r.kind === "array" || r.kind === "present");
      // Exactly one marker: two would make the refusal message ambiguous about
      // which standard the document claimed to be.
      expect(markers, `${format} must pin exactly one marker VALUE`).toHaveLength(1);
      expect(markers[0]!.kind === "marker" && markers[0].equals).toBeTruthy();
      expect(structural.length, `${format} must require an inventory field`).toBeGreaterThanOrEqual(1);
      expect(c.require.length, `${format} must constrain more than its marker`).toBeGreaterThanOrEqual(2);
      expect(new Set(c.require.map((r) => r.key)).size).toBe(c.require.length);
    }
  });

  it("marker VALUES are distinct, so no document can satisfy two formats at once", () => {
    const markers = AI_BOM_FORMATS.map((f) => {
      const m = AI_BOM_MARKERS[f].require.find((r) => r.kind === "marker");
      return m && m.kind === "marker" ? `${m.key}=${m.equals}` : "";
    });
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("exactly one format is delivered inside the {success,data} envelope", () => {
    expect(AI_BOM_FORMATS.filter((f) => AI_BOM_MARKERS[f].enveloped)).toEqual(["json"]);
  });
});

/* ── 2. every contract still rejects the fault set ───────────────────────── */

/**
 * The bodies that motivated the boundary, plus the ones a per-format validator
 * newly has to get right. `null` body = "skip this cell for this format".
 */
const FAULTS: { name: string; status?: number; body: (asked: AiBomFormat) => string | null }[] = [
  { name: "invalid JSON", body: () => "this is not JSON at all {{{" },
  { name: "an empty body", body: () => "" },
  { name: "a 204", status: 204, body: () => "" },
  { name: "an empty object", body: () => "{}" },
  { name: "an nginx 502 page", body: () => "<html><head><title>502 Bad Gateway</title></head></html>" },
  { name: "a JSON null", body: () => "null" },
  { name: "a bare string", body: () => '"ok"' },
  { name: "an unrelated object", body: () => '{"hello":"world"}' },
  { name: "2 MB of filler", body: () => "x".repeat(2 * 1024 * 1024) },
  { name: "a 200 error envelope", body: () => '{"success":false,"error":{"message":"boom"}}' },
  { name: "a JSON array", body: () => "[]" },
  // The envelope is the delivery vehicle for exactly one format; for the other
  // two it means an API response leaked in where a document belongs.
  {
    name: "a success envelope",
    body: (asked) => (AI_BOM_MARKERS[asked].enveloped ? null : '{"success":true,"data":{}}'),
  },
  // ...and for the enveloped one, an envelope whose `data` is not a document.
  {
    name: "an envelope with null data",
    body: (asked) => (AI_BOM_MARKERS[asked].enveloped ? '{"success":true,"data":null}' : null),
  },
  // FORMAT SUBSTITUTION — each of the other formats' VALID documents. This is
  // the fault a single-contract validator could not even express.
  ...AI_BOM_FORMATS.map((other) => ({
    name: `a valid ${other} document`,
    body: (asked: AiBomFormat) => (asked === other ? null : onTheWire(other)),
  })),
];

describe("every contract rejects the fault set (each row carries a positive control)", () => {
  for (const format of AI_BOM_FORMATS) {
    it(`${format}: accepts the route's real document (the control for every row below)`, async () => {
      await expect(read(format, onTheWire(format))).resolves.toBe(onTheWire(format));
    });

    for (const fault of FAULTS) {
      const body = fault.body(format);
      if (body === null) continue;
      it(`${format}: refuses ${fault.name}`, async () => {
        // POSITIVE CONTROL FIRST: if this format's valid document is not being
        // accepted right now, the refusal below proves nothing about the fault.
        await expect(
          read(format, onTheWire(format)),
          `control dead: ${format} rejects its own valid document, so its refusals mean nothing`,
        ).resolves.toBeTypeOf("string");
        await expect(read(format, body, fault.status ?? 200)).rejects.toThrow(/was NOT written/);
      });
    }
  }

  it("covers every format equally, over a non-zero number of cells", () => {
    // Guards the "0 cells over zero rows" failure: a matrix that skipped every
    // cell would otherwise report a clean sweep. Stated structurally rather
    // than as a magic total, so adding a format grows it instead of breaking
    // it — but a fault that silently stops applying to ONE format still fails,
    // because every format must contribute the same count.
    const perFormat = AI_BOM_FORMATS.map((f) => FAULTS.filter((x) => x.body(f) !== null).length);
    // Each format skips exactly two cells: the envelope-shape fault meant for
    // the other delivery style, and the substitution that is its own document.
    expect(perFormat).toEqual(AI_BOM_FORMATS.map(() => FAULTS.length - 2));
    expect(new Set(perFormat).size).toBe(1);
    expect(perFormat.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

/* ── 3. every individual rule bites ──────────────────────────────────────── */

describe("every rule of every contract is load-bearing", () => {
  for (const format of AI_BOM_FORMATS) {
    const contract = AI_BOM_MARKERS[format];
    for (const rule of contract.require) {
      it(`${format}: refuses a document missing \`${rule.key}\``, async () => {
        const doc = { ...VALID[format] };
        delete doc[rule.key];
        const wire = contract.enveloped ? JSON.stringify({ success: true, data: doc }) : JSON.stringify(doc);
        expect(await accepted(format, onTheWire(format))).toBe(true); // control
        await expect(read(format, wire)).rejects.toThrow(/was NOT written/);
      });

      if (rule.kind === "marker") {
        it(`${format}: refuses a document whose \`${rule.key}\` is another standard's`, async () => {
          const doc = { ...VALID[format], [rule.key]: "SomeOtherStandard-9.9" };
          const wire = contract.enveloped ? JSON.stringify({ success: true, data: doc }) : JSON.stringify(doc);
          expect(await accepted(format, onTheWire(format))).toBe(true); // control
          await expect(read(format, wire)).rejects.toThrow(/archived under the wrong standard/);
        });
      }

      if (rule.kind === "array") {
        it(`${format}: refuses \`${rule.key}\` as an OBJECT — the pre-fix shape defect`, async () => {
          const doc = { ...VALID[format], [rule.key]: { models: [], dependencies: [] } };
          const wire = contract.enveloped ? JSON.stringify({ success: true, data: doc }) : JSON.stringify(doc);
          expect(await accepted(format, onTheWire(format))).toBe(true); // control
          await expect(read(format, wire)).rejects.toThrow(/requires an array/);
        });
      }
    }
  }
});

/* ── 4. the validation command we PRINT can actually fail ────────────────── */

describe("the `Next steps` command we hand the customer is not a no-op in CI", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "..", "commands", "ai-bom.ts"), "utf-8");

  it("the printed `cyclonedx validate` carries --fail-on-errors", () => {
    // Measured on cyclonedx-cli 0.33.1, on a BOM with `components` as an object
    // and an extra root key:
    //   cyclonedx validate --input-file bad.cdx.json           → "BOM is not valid." exit 0
    //   cyclonedx validate --input-file bad.cdx.json --fail-on-errors → same output, exit 1
    // Without the flag the CI step a customer builds from our own output prints
    // the failure and then goes green — the exact fail-open shape this module
    // exists to prevent, relocated into their pipeline.
    // Only STRING LITERALS — the file also quotes the old command in prose
    // (both in its header and in the comment explaining this flag), and a
    // looser match reads those and passes while the printed line is wrong.
    const printed = [...src.matchAll(/"(cyclonedx validate[^"]*)"/g)].map((m) => m[1]!);
    expect(printed, "no printed `cyclonedx validate` command found to check").not.toHaveLength(0);
    for (const cmd of printed) expect(cmd, `printed command cannot fail a CI step: ${cmd}`).toContain("--fail-on-errors");
  });

  it("does not print a validator invocation that exits 0 on a bad document", () => {
    // `pyspdxtools --infile <f>` validates by default and exits 1 on failure
    // (measured: 0 on the route's real SPDX 2.3 export, 1 + "The document is
    // invalid" on a broken one), so it needs no flag — but `--novalidation`
    // would turn it into the same no-op, so it must never appear.
    expect(src).not.toContain("--novalidation");
  });
});

/* ── 5. the boundary itself stays fail-closed ────────────────────────────── */

describe("the boundary fails closed on its own edges", () => {
  it("refuses an ai-bom read with NO contract, even when a cast smuggles one past the types", async () => {
    const opts = {
      endpoint: "GET /ai-sbom?format=spdx",
      format: "ai-bom",
      what: "AI-BOM",
    } as unknown as Parameters<typeof readArtifactBody>[1];
    await expect(readArtifactBody(new Response(onTheWire("spdx")), opts)).rejects.toThrow(
      /no AI-BOM format contract was supplied/,
    );
    // control: the identical body WITH the contract is accepted.
    await expect(read("spdx", onTheWire("spdx"))).resolves.toBeTypeOf("string");
  });

  it("reads only OWN properties, so Object.prototype cannot supply a missing field", async () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    // The exact fields the SPDX contract requires, planted on the prototype.
    proto.spdxVersion = "SPDX-2.3";
    proto.SPDXID = "SPDXRef-DOCUMENT";
    proto.packages = [];
    try {
      // `{"name":"x"}` owns nothing the contract asks for; every field it needs
      // is reachable ONLY through the prototype chain.
      await expect(read("spdx", '{"name":"x"}')).rejects.toThrow(/was NOT written/);
      // control, in the polluted state: a real document is still accepted.
      await expect(read("spdx", onTheWire("spdx"))).resolves.toBeTypeOf("string");
    } finally {
      delete proto.spdxVersion;
      delete proto.SPDXID;
      delete proto.packages;
    }
    expect(({} as Record<string, unknown>).spdxVersion).toBeUndefined();
  });
});
