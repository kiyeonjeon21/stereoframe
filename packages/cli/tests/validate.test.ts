import { describe, expect, test } from "bun:test";
import { screenMotionSummary, staticFramingFinding, type ScreenMotionSample } from "../src/validate";

const sample = (t: number, cx: number, cy: number, area: number): ScreenMotionSample => ({
  t,
  shot: { start: 0, duration: 3 },
  bounds: {
    minX: cx - 0.2,
    maxX: cx + 0.2,
    minY: cy - 0.2,
    maxY: cy + 0.2,
    cx,
    cy,
    area,
  },
});

describe("screen motion diagnostics", () => {
  test("summarizes center and size movement", () => {
    const s = screenMotionSummary([sample(0, 0, 0, 0.1), sample(1, 0.1, 0, 0.2)])!;
    expect(s.centerShift).toBeCloseTo(0.1);
    expect(s.areaLogChange).toBeGreaterThan(0.6);
  });

  test("warns when framing is effectively static over a long shot", () => {
    const finding = staticFramingFinding(0, [
      sample(0.05, 0, 0, 0.12),
      sample(1.5, 0.01, 0.005, 0.123),
      sample(2.95, 0.015, 0.005, 0.121),
    ]);
    expect(finding?.rule).toBe("static_framing");
  });

  test("does not warn when the subject moves substantially on screen", () => {
    const finding = staticFramingFinding(0, [
      sample(0.05, -0.18, 0, 0.12),
      sample(1.5, 0, 0, 0.14),
      sample(2.95, 0.22, 0.04, 0.16),
    ]);
    expect(finding).toBeNull();
  });
});
