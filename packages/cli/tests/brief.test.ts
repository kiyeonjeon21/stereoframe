import { describe, expect, test } from "bun:test";
import { buildMessages, extractJson, manifestFacts, repairMessage } from "../src/brief";
import type { ModelManifest } from "../src/inspect";

const manifest = (p: Partial<ModelManifest> = {}): ModelManifest => ({
  model: "/x/supercar.glb",
  generatedBy: "test",
  partCount: 1,
  meshParts: 1,
  isSingleMesh: true,
  hasRig: false,
  recommendedFit: 2.6,
  dominant: { character: "metal", metalness: 0.9 },
  bounds: { center: [0, 0, 0], size: [1.9, 0.45, 0.9], min: [0, 0, 0], max: [0, 0, 0] },
  parts: [],
  ...p,
});

describe("extractJson", () => {
  test("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  test("parses a ```json fenced object with prose around it", () => {
    const r = "Here is your plan:\n```json\n{\"shots\":[]}\n```\nEnjoy!";
    expect(extractJson(r)).toEqual({ shots: [] });
  });
  test("parses an object embedded in loose prose", () => {
    expect(extractJson('blah {"x": [1,2]} trailing')).toEqual({ x: [1, 2] });
  });
  test("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("manifestFacts", () => {
  test("flags a flat slab and a metal dominant material", () => {
    const f = manifestFacts(manifest({ bounds: { center: [0, 0, 0], size: [1.9, 0.16, 0.98], min: [0, 0, 0], max: [0, 0, 0] } }));
    expect(f).toMatch(/thin\/flat/);
    expect(f).toMatch(/metal/);
    expect(f).toMatch(/SINGLE-MESH/);
  });
  test("does NOT flag a naturally low/wide object (a car) as flat", () => {
    // default fixture is a car: 1.9 x 0.45 x 0.9 → ratio 0.24, above the 0.12 threshold
    expect(manifestFacts(manifest())).not.toMatch(/thin\/flat/);
  });

  test("lists part names for a multi-part model", () => {
    const f = manifestFacts(
      manifest({
        isSingleMesh: false,
        parts: [
          { index: 0, name: "Body", kind: "mesh", skinned: false, triangles: 100, character: "metal", color: null, spatial: ["core"], sizeRank: 0, bounds: null, material: null },
          { index: 1, name: "Glass", kind: "mesh", skinned: false, triangles: 50, character: "glass", color: null, spatial: ["top"], sizeRank: 1, bounds: null, material: null },
        ],
      }),
    );
    expect(f).toMatch(/Body, Glass/);
    expect(f).not.toMatch(/SINGLE-MESH/);
  });
});

describe("buildMessages", () => {
  const msgs = buildMessages("a dark neon supercar reveal, 24s, hero on APEX", manifest());
  test("has a system message embedding the schema doc + output rules", () => {
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toMatch(/STORYBOARD PLAN/);
    expect(msgs[0]!.content).toMatch(/atmosphere/);
    expect(msgs[0]!.content).toMatch(/Return ONLY one JSON object/);
  });
  test("user message carries the brief + the model facts", () => {
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toMatch(/neon supercar reveal/);
    expect(msgs[1]!.content).toMatch(/MODEL FACTS/);
  });
  test("portrait dims inject a vertical framing rule", () => {
    const v = buildMessages("x", manifest(), { width: 1080, height: 1920 });
    expect(v[0]!.content).toMatch(/PORTRAIT/);
    expect(v[0]!.content).toMatch(/1080x1920/);
    // landscape default does not
    expect(buildMessages("x", manifest())[0]!.content).not.toMatch(/PORTRAIT/);
  });
});

describe("repairMessage", () => {
  test("lists the validation errors and asks for a full corrected plan", () => {
    const m = repairMessage(['shot 2 "x": duration must be > 0', "shot 3: orbit camera needs radius, from, to"]);
    expect(m).toMatch(/duration must be > 0/);
    expect(m).toMatch(/orbit camera needs radius/);
    expect(m).toMatch(/JSON only/);
  });

  test("can include creative warnings for the repair pass", () => {
    const m = repairMessage([], ["low_motion_energy: add a camera move"]);
    expect(m).toMatch(/Creative warnings/);
    expect(m).toMatch(/low_motion_energy/);
    expect(m).toMatch(/addresses the creative warnings/);
  });
});
