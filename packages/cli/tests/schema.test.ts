import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ELEMENT_NAMES,
  VERB_NAMES,
  VERB_PARAMS,
  GEOMETRY_KINDS,
  MATERIAL_KINDS,
  STAGE_PRESETS,
} from "stereoframe-runtime/vocab";
import { PRESETS } from "../src/stage";

const sceneSrc = readFileSync(new URL("../../runtime/src/scene.ts", import.meta.url), "utf8");
const cliSrc = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

describe("schema vocab consistency", () => {
  test("VERB_PARAMS has an entry for every verb (and no extras)", () => {
    expect(Object.keys(VERB_PARAMS).sort()).toEqual([...VERB_NAMES].sort());
  });

  test("stage PRESETS is the centralized STAGE_PRESETS", () => {
    expect(PRESETS).toEqual(STAGE_PRESETS);
  });

  test("elements + geometry lists are non-empty and well-formed", () => {
    expect(ELEMENT_NAMES).toContain("sf-scene");
    for (const g of GEOMETRY_KINDS) expect(g.args.length).toBeGreaterThan(0);
  });
});

// Drift guards: fail loudly if someone adds a geometry/material/preset in the
// builders without updating vocab.ts (the schema's source of truth).
describe("schema ↔ source drift guards", () => {
  test("every GEOMETRY_KINDS name is handled in scene.ts buildGeometry", () => {
    for (const { name } of GEOMETRY_KINDS) {
      if (name === "box") continue; // box is the default fallback (no explicit case)
      expect(sceneSrc).toContain(`case "${name}":`);
    }
  });

  test("every MATERIAL_KINDS name is handled in scene.ts buildMeshMaterial", () => {
    // buildMeshMaterial dispatches with `kind === "name"` (not a switch).
    for (const name of MATERIAL_KINDS) {
      if (name === "standard") continue; // default fallback
      expect(sceneSrc).toContain(`"${name}"`);
    }
  });

  test("every COMMANDS entry appears in the HELP usage block", () => {
    const names = [...cliSrc.matchAll(/name: "([a-z-]+)", summary:/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(cliSrc).toContain(`stereoframe ${n}`);
  });

  test("gen schema advertises implemented generation flags", () => {
    for (const flag of [
      "input",
      "key",
      "polycount",
      "image-provider",
      "image-model",
      "image-key",
      "image-quality",
      "image-format",
      "image-compression",
      "image-background",
      "image-moderation",
      "size",
      "quality-report",
      "stage-dir",
      "duration",
      "bg",
      "title",
      "draft",
    ]) {
      expect(cliSrc).toContain(`"${flag}"`);
    }
  });
});
