import { describe, expect, test } from "bun:test";
import { EASE_NAMES, getEase, isValidEase } from "../src/ease";

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

  describe("easing-as-data (function forms)", () => {
    test("cubic-bezier(0,0,1,1) ≈ linear across samples", () => {
      const fn = getEase("cubic-bezier(0,0,1,1)");
      for (const p of [0, 0.13, 0.5, 0.87, 1]) expect(fn(p)).toBeCloseTo(p, 4);
    });

    test("cubic-bezier endpoints exact + matches a hand-evaluated point", () => {
      // ease="cubic-bezier(0.25,0.1,0.25,1)" (CSS "ease"): at the t where Bx(t)=0.5,
      // By(t) must match the parametric. Verify endpoints + monotonic + a known shape.
      const fn = getEase("cubic-bezier(0.42,0,0.58,1)"); // ease-in-out
      expect(fn(0)).toBe(0);
      expect(fn(1)).toBe(1);
      expect(fn(0.5)).toBeCloseTo(0.5, 5); // symmetric curve → 0.5 at midpoint
      expect(fn(0.25)).toBeLessThan(0.25); // slow start
      expect(fn(0.75)).toBeGreaterThan(0.75); // fast then settle
    });

    test("spring: e(0)=0, e(1)=1 EXACTLY (endpoint locked), overshoots mid-curve", () => {
      const fn = getEase("spring");
      expect(fn(0)).toBe(0);
      expect(fn(1)).toBe(1); // exact — windowed tween settles precisely on `to`
      const samples = [0.3, 0.4, 0.5, 0.6, 0.7].map(fn);
      expect(Math.max(...samples)).toBeGreaterThan(1); // damped overshoot
    });

    test("spring(stiffness,damping) parses + endpoint exact; deterministic", () => {
      const fn = getEase("spring(6, 0.3)");
      expect(fn(1)).toBe(1);
      expect(fn(0.42)).toBe(fn(0.42));
    });

    test("malformed function eases fall back to default", () => {
      expect(getEase("cubic-bezier(1,2)", "linear")(0.3)).toBeCloseTo(0.3); // bad arity
      expect(getEase("cubic-bezier(a,b,c,d)", "linear")(0.3)).toBeCloseTo(0.3); // non-numeric
    });

    test("isValidEase: names + well-formed forms pass; junk fails", () => {
      expect(isValidEase("power2.inOut")).toBe(true);
      expect(isValidEase("cubic-bezier(.17,.67,.83,.67)")).toBe(true);
      expect(isValidEase("spring")).toBe(true);
      expect(isValidEase("spring(4,0.5)")).toBe(true);
      expect(isValidEase("cubic-bezier(1,2)")).toBe(false); // arity
      expect(isValidEase("wobble")).toBe(false);
    });
  });
});
