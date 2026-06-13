import { describe, expect, test } from "bun:test";
import { forwardDelta } from "../src/seek";

describe("forwardDelta (forward-only stepping)", () => {
  test("first seek (lastT < 0) yields dt 0 — nothing to step from", () => {
    expect(forwardDelta(-1, 0)).toBe(0);
    expect(forwardDelta(-1, 2.5)).toBe(0);
  });

  test("monotonic forward seeks yield the positive time delta", () => {
    expect(forwardDelta(1.0, 1.0 + 1 / 30)).toBeCloseTo(1 / 30, 6);
    expect(forwardDelta(2.0, 2.5)).toBeCloseTo(0.5, 6);
  });

  test("a backward seek yields dt <= 0 so writers can skip advancing", () => {
    expect(forwardDelta(2.5, 0)).toBeLessThanOrEqual(0);
    expect(forwardDelta(2.5, 2.5)).toBe(0);
  });
});
