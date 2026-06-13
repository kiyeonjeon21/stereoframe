import { describe, expect, test } from "bun:test";
import { shotState, type ShotSpec } from "../src/shots";

const cutShot: ShotSpec = { start: 4, duration: 6, transition: "cut", transitionDuration: 0 };
const fadeShot: ShotSpec = {
  start: 4,
  duration: 6,
  transition: "crossfade",
  transitionDuration: 0.8,
};

describe("shotState", () => {
  test("invisible before start and at/after end", () => {
    expect(shotState(3.99, cutShot).visible).toBe(false);
    expect(shotState(10, cutShot).visible).toBe(false);
    expect(shotState(4, cutShot).visible).toBe(true);
    expect(shotState(9.99, cutShot).visible).toBe(true);
  });

  test("local time clamps to the shot window", () => {
    expect(shotState(0, cutShot).localT).toBe(0);
    expect(shotState(7, cutShot).localT).toBeCloseTo(3);
    expect(shotState(99, cutShot).localT).toBeCloseTo(6);
  });

  test("cut is always full opacity", () => {
    expect(shotState(4, cutShot).opacity).toBe(1);
    expect(shotState(4.01, cutShot).opacity).toBe(1);
  });

  test("crossfade ramps opacity over transition-duration", () => {
    expect(shotState(4, fadeShot).opacity).toBeCloseTo(0);
    expect(shotState(4.4, fadeShot).opacity).toBeCloseTo(0.5);
    expect(shotState(4.8, fadeShot).opacity).toBeCloseTo(1);
    expect(shotState(8, fadeShot).opacity).toBe(1);
  });

  test("single default shot behaves like the pre-multishot runtime", () => {
    const whole: ShotSpec = { start: 0, duration: 8, transition: "cut", transitionDuration: 0 };
    expect(shotState(0, whole)).toEqual({ visible: true, localT: 0, opacity: 1 });
    expect(shotState(5.5, whole).localT).toBeCloseTo(5.5);
  });

  test("idempotent: same t → same state", () => {
    expect(shotState(4.37, fadeShot)).toEqual(shotState(4.37, fadeShot));
  });
});
