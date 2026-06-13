import { describe, expect, test } from "bun:test";
import type { Object3D } from "three";
import { resolvePartIndex } from "../src/animate";

const parts = (...names: string[]) => names.map((name) => ({ name })) as unknown as Object3D[];

describe("resolvePartIndex", () => {
  const ps = parts("ToyCar", "Fabric", "Glass");

  test("numeric index passes through, clamped", () => {
    expect(resolvePartIndex(ps, "1")).toBe(1);
    expect(resolvePartIndex(ps, "9")).toBe(2);
    expect(resolvePartIndex(ps, "-3")).toBe(0);
  });

  test("exact name match (case-insensitive)", () => {
    expect(resolvePartIndex(ps, "Glass")).toBe(2);
    expect(resolvePartIndex(ps, "fabric")).toBe(1);
  });

  test("substring match when no exact hit", () => {
    expect(resolvePartIndex(ps, "Toy")).toBe(0);
    expect(resolvePartIndex(ps, "glas")).toBe(2);
  });

  test("unmatched name falls back to the given index", () => {
    expect(resolvePartIndex(ps, "Wheel", 1)).toBe(1);
    expect(resolvePartIndex(ps, "Wheel")).toBe(0);
  });

  test("null spec uses fallback", () => {
    expect(resolvePartIndex(ps, null, 2)).toBe(2);
  });
});
