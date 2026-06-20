import { describe, expect, test } from "bun:test";
import { compile } from "../../src/ir/compile";
import type { Driver, SceneIR, Segment, TimelineIR } from "../../src/ir/types";

const orbitDriver: Driver = { kind: "orbit", target: "camera", around: "product", radius: 4, fromDeg: 0, toDeg: 35, height: 0 };
const moveDriver: Driver = { kind: "move", target: "a", to: [1, 0, 0] };

function scene(timeline: TimelineIR, extra: Partial<SceneIR> = {}): SceneIR {
  return { nodes: [], behaviors: [], timeline, ...extra };
}
function starts(segs: Segment[] | undefined): number[] {
  return (segs ?? []).map((s) => s.start);
}

describe("compile — per-channel segments + duration inference", () => {
  test("seq sums durations; segments land on the right channel key", () => {
    const c = compile(
      scene({
        kind: "seq",
        children: [
          { kind: "clip", driver: moveDriver, duration: 2 },
          { kind: "wait", duration: 1 },
          { kind: "clip", driver: moveDriver, duration: 3 },
        ],
      }),
    );
    expect(c.duration).toBe(6);
    expect(starts(c.segments.get("a.position"))).toEqual([0, 3]); // wait pushes the 2nd clip
  });

  test("par: each driver keyed by its own target.channel; max span wins", () => {
    const c = compile(
      scene({
        kind: "par",
        children: [
          { kind: "clip", driver: moveDriver, duration: 8 },
          { kind: "clip", driver: orbitDriver, duration: 3 },
        ],
      }),
    );
    expect(c.duration).toBe(8);
    expect(starts(c.segments.get("a.position"))).toEqual([0]);
    expect(starts(c.segments.get("camera.position"))).toEqual([0]);
  });

  test("stagger offsets each child by interval (same channel → sorted)", () => {
    const c = compile(
      scene({
        kind: "stagger",
        interval: 0.5,
        children: [
          { kind: "clip", driver: moveDriver, duration: 1 },
          { kind: "clip", driver: moveDriver, duration: 1 },
          { kind: "clip", driver: moveDriver, duration: 1 },
        ],
      }),
    );
    expect(starts(c.segments.get("a.position"))).toEqual([0, 0.5, 1]);
    expect(c.duration).toBe(2);
  });

  test("zoom keys the fov channel; explicit scene.duration extends the total", () => {
    const c = compile(
      scene({ kind: "clip", driver: { kind: "zoom", target: "camera", from: 30, to: 60 }, duration: 2 }, { duration: 10 }),
    );
    expect(starts(c.segments.get("camera.fov"))).toEqual([0]);
    expect(c.duration).toBe(10);
  });
});

describe("compile — beat (rigid span)", () => {
  test("scale stretches interior durations; beatTimes/labelTimes recorded", () => {
    const c = compile(
      scene({
        kind: "beat",
        name: "intro",
        scale: 2,
        children: [
          { kind: "clip", driver: moveDriver, duration: 1, label: "a" },
          { kind: "clip", driver: moveDriver, duration: 1, label: "b" },
        ],
      }),
    );
    expect((c.segments.get("a.position") ?? []).map((s) => [s.start, s.duration])).toEqual([
      [0, 2],
      [2, 2],
    ]);
    expect(c.beatTimes.get("intro")).toEqual({ t0: 0, t1: 4 });
    expect(c.labelTimes.get("b")).toEqual({ t0: 2, t1: 4 });
  });

  test("absolute `at` places the beat rigidly", () => {
    const c = compile(
      scene({
        kind: "seq",
        children: [
          { kind: "clip", driver: moveDriver, duration: 2 },
          { kind: "beat", name: "b", at: 5, children: [{ kind: "clip", driver: moveDriver, duration: 1 }] },
        ],
      }),
    );
    expect(c.beatTimes.get("b")).toEqual({ t0: 5, t1: 6 });
  });
});

describe("compile — ease defaults", () => {
  test("clip ease defaults to power1.out; explicit ease is kept per channel", () => {
    const c = compile(
      scene({
        kind: "par",
        children: [
          { kind: "clip", driver: moveDriver, duration: 1 },
          { kind: "clip", driver: orbitDriver, duration: 1, ease: "sine.inOut" },
        ],
      }),
    );
    expect(c.segments.get("a.position")![0]!.ease).toBe("power1.out");
    expect(c.segments.get("camera.position")![0]!.ease).toBe("sine.inOut");
  });
});
