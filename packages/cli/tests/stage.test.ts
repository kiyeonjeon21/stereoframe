import { describe, expect, test } from "bun:test";
import { buildAutoCallouts, explodeTiming } from "../src/stage";
import type { ModelManifest, PartManifest } from "../src/inspect";

function part(p: Partial<PartManifest>): PartManifest {
  return {
    index: 0,
    name: "Part",
    kind: "mesh",
    skinned: false,
    triangles: 100,
    character: "matte",
    color: null,
    spatial: ["core"],
    sizeRank: 0,
    bounds: { center: [0, 0, 0], size: [1, 1, 1], min: [0, 0, 0], max: [1, 1, 1] },
    material: null,
    ...p,
  };
}

function manifest(parts: PartManifest[]): ModelManifest {
  return {
    model: "m.glb",
    generatedBy: "test",
    partCount: parts.length,
    meshParts: parts.filter((p) => p.kind === "mesh").length,
    isSingleMesh: parts.filter((p) => p.kind === "mesh").length <= 1,
    hasRig: false,
    recommendedFit: 2.6,
    bounds: { center: [0, 0, 0], size: [2, 2, 2], min: [-1, -1, -1], max: [1, 1, 1] },
    parts,
  };
}

describe("buildAutoCallouts", () => {
  test("single-mesh model yields no callouts", () => {
    expect(buildAutoCallouts(manifest([part({ name: "Body" })]), 8)).toEqual([]);
  });

  test("picks the most-detailed mesh parts, by name, up to max", () => {
    const m = manifest([
      part({ index: 0, name: "Body", triangles: 5000 }),
      part({ index: 1, name: "Trim", triangles: 200 }),
      part({ index: 2, name: "Glass", triangles: 3000, character: "glass" }),
      part({ index: 3, name: "Screw", triangles: 50 }),
    ]);
    const out = buildAutoCallouts(m, 8);
    expect(out.length).toBe(3);
    expect(out.map((c) => c.part)).toEqual(["Body", "Glass", "Trim"]);
    expect(out[1]!.text).toBe("Optical glass"); // glass → material caption
    expect(out[2]!.text).toBe("Composite"); // matte → material caption
  });

  test("empty (mesh-less) parts are ignored", () => {
    const m = manifest([
      part({ index: 0, name: "Body", triangles: 5000 }),
      part({ index: 1, name: "Camera", kind: "empty", triangles: 0, bounds: null }),
      part({ index: 2, name: "Glass", triangles: 1000 }),
    ]);
    const out = buildAutoCallouts(m, 8);
    expect(out.map((c) => c.part)).toEqual(["Body", "Glass"]);
  });

  test("spatial tags drive the anchor side; leads fan upward", () => {
    const m = manifest([
      part({ index: 0, name: "Left", triangles: 3000, spatial: ["left"] }),
      part({ index: 1, name: "Right", triangles: 2000, spatial: ["right"] }),
    ]);
    const out = buildAutoCallouts(m, 8);
    expect(out[0]!.anchor).toBe("left");
    expect(out[1]!.anchor).toBe("right");
    expect(out[1]!.leadY).toBeLessThan(out[0]!.leadY); // fanned higher
  });

  test("callouts stagger within the clip", () => {
    const m = manifest([
      part({ index: 0, name: "A", triangles: 3000 }),
      part({ index: 1, name: "B", triangles: 2000 }),
    ]);
    const out = buildAutoCallouts(m, 8);
    expect(out[0]!.start).toBeLessThan(out[1]!.start);
    expect(out[1]!.start + out[1]!.duration).toBeLessThan(8);
  });

  test("leadFan=0 keeps every label at the same lead (teardown)", () => {
    const m = manifest([
      part({ index: 0, name: "A", triangles: 3000 }),
      part({ index: 1, name: "B", triangles: 2000 }),
      part({ index: 2, name: "C", triangles: 1000 }),
    ]);
    const out = buildAutoCallouts(m, 8, { max: 5, leadFan: 0 });
    expect(out.map((c) => c.leadY)).toEqual([-82, -82, -82]);
  });

  test("generic part names are replaced with synthesised labels", () => {
    const m = manifest([
      part({ index: 0, name: "Mesh 0", triangles: 3000, character: "glass", spatial: ["top"] }),
      part({ index: 1, name: "Node001", triangles: 2000, character: "matte", spatial: ["base", "left"] }),
      part({ index: 2, name: "5", triangles: 1000, character: "matte", spatial: ["core"], sizeRank: 0 }),
    ]);
    const out = buildAutoCallouts(m, 8, { max: 5 });
    // Glass + top → "Glass / TOP"; never the raw "Mesh 0".
    expect(out[0]!.value).toBe("Glass");
    expect(out.every((c) => !/^(mesh|node)\s*\d/i.test(c.value))).toBe(true);
    // Generic-named parts are targeted by index, not the junk name.
    expect(out[0]!.part).toBe("0");
    // Placeless matte falls back to a body/part label.
    expect(out.find((c) => c.part === "2")!.value).toBe("Main body");
  });

  test("real part names are kept as the callout label and target", () => {
    const m = manifest([
      part({ index: 0, name: "Windshield", triangles: 3000, character: "glass" }),
      part({ index: 1, name: "Chassis", triangles: 2000, character: "metal" }),
    ]);
    const out = buildAutoCallouts(m, 8);
    expect(out[0]!.value).toBe("Windshield");
    expect(out[0]!.part).toBe("Windshield");
    expect(out[0]!.text).toBe("Optical glass");
  });

  test("startAt delays the first callout (teardown waits for the explode)", () => {
    const m = manifest([
      part({ index: 0, name: "A", triangles: 3000 }),
      part({ index: 1, name: "B", triangles: 2000 }),
    ]);
    const out = buildAutoCallouts(m, 10, { startAt: 4 });
    expect(out[0]!.start).toBe(4);
  });
});

describe("explodeTiming", () => {
  test("starts at 0.5 and finishes within the clip", () => {
    const t = explodeTiming(8);
    expect(t.start).toBe(0.5);
    expect(t.end).toBe(t.start + t.dur);
    expect(t.end).toBeLessThan(8);
  });

  test("has a floor so short clips still separate", () => {
    expect(explodeTiming(2).dur).toBeGreaterThanOrEqual(1.6);
  });
});
