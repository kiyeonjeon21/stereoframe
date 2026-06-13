import { describe, expect, test } from "bun:test";
import { EASE_NAMES, getEase } from "../src/ease";

describe("ease", () => {
  test("every named ease maps 0→0 and 1→1", () => {
    for (const name of EASE_NAMES) {
      const fn = getEase(name);
      expect(fn(0)).toBeCloseTo(0, 5);
      expect(fn(1)).toBeCloseTo(1, 5);
    }
  });

  test("linear is identity", () => {
    const fn = getEase("linear");
    expect(fn(0.25)).toBeCloseTo(0.25);
    expect(fn(0.5)).toBeCloseTo(0.5);
  });

  test("power2.out matches cubic-out formula", () => {
    const fn = getEase("power2.out");
    expect(fn(0.5)).toBeCloseTo(1 - Math.pow(0.5, 3));
  });

  test("back.out overshoots above 1 mid-curve", () => {
    const fn = getEase("back.out");
    const samples = [0.6, 0.7, 0.8].map(fn);
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  test("unknown name falls back to default", () => {
    const fn = getEase("not-a-real-ease", "linear");
    expect(fn(0.3)).toBeCloseTo(0.3);
  });

  test("deterministic: same input → same output", () => {
    const fn = getEase("elastic.out");
    expect(fn(0.37)).toBe(fn(0.37));
  });
});
