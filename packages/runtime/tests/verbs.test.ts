import { describe, expect, test } from "bun:test";
import {
  bounceIn,
  crossfadeClips,
  dolly,
  fadeIn,
  float,
  follow,
  makeTiming,
  move,
  orbit,
  staggeredProgress,
  turntable,
} from "../src/verbs";
import type { TransformLike } from "../src/verbs";

function makeTarget(overrides: Partial<TransformLike> = {}): TransformLike {
  return {
    position: { x: 0, y: 0, z: 0, ...overrides.position },
    rotation: { x: 0, y: 0, z: 0, ...overrides.rotation },
    scale: { x: 1, y: 1, z: 1, ...overrides.scale },
  };
}

describe("turntable", () => {
  test("rotates at rpm as a pure function of t", () => {
    const target = makeTarget();
    const writer = turntable(target, makeTiming({}), { rpm: 6, axis: "y" });
    writer(10); // 6 rpm → 1 rev / 10s
    expect(target.rotation.y).toBeCloseTo(Math.PI * 2);
    writer(5);
    expect(target.rotation.y).toBeCloseTo(Math.PI);
  });

  test("idempotent: seeking the same t twice gives the same pose", () => {
    const target = makeTarget();
    const writer = turntable(target, makeTiming({}), { rpm: 10, axis: "y" });
    writer(3.21);
    const first = target.rotation.y;
    writer(7);
    writer(3.21);
    expect(target.rotation.y).toBe(first);
  });

  test("preserves base rotation and respects start offset", () => {
    const target = makeTarget({ rotation: { x: 0, y: 1, z: 0 } });
    const writer = turntable(target, makeTiming({ start: 2 }), { rpm: 6, axis: "y" });
    writer(0);
    expect(target.rotation.y).toBeCloseTo(1); // inert before start
    writer(12); // 10 active seconds = 1 rev
    expect(target.rotation.y).toBeCloseTo(1 + Math.PI * 2);
  });
});

describe("orbit", () => {
  const center = () => ({ x: 0, y: 0, z: 0 });

  test("places target on the circle at from/to angles", () => {
    const target = makeTarget();
    const writer = orbit(target, makeTiming({ duration: 4, ease: "linear" }), {
      center,
      radius: 5,
      fromDeg: 0,
      toDeg: 90,
      height: 2,
    });
    writer(0); // azimuth 0° → +Z
    expect(target.position.x).toBeCloseTo(0);
    expect(target.position.z).toBeCloseTo(5);
    expect(target.position.y).toBeCloseTo(2);
    writer(4); // azimuth 90° → +X
    expect(target.position.x).toBeCloseTo(5);
    expect(target.position.z).toBeCloseTo(0);
  });

  test("clamps before start and after end", () => {
    const target = makeTarget();
    const writer = orbit(target, makeTiming({ start: 1, duration: 2, ease: "linear" }), {
      center,
      radius: 1,
      fromDeg: 0,
      toDeg: 180,
      height: 0,
    });
    writer(0);
    expect(target.position.z).toBeCloseTo(1); // still at from
    writer(99);
    expect(target.position.z).toBeCloseTo(-1); // clamped at to
  });

  test("tracks a moving center", () => {
    const target = makeTarget();
    let cx = 0;
    const writer = orbit(target, makeTiming({ duration: 1, ease: "linear" }), {
      center: () => ({ x: cx, y: 0, z: 0 }),
      radius: 2,
      fromDeg: 0,
      toDeg: 0,
      height: 0,
    });
    writer(0);
    expect(target.position.x).toBeCloseTo(0);
    cx = 10;
    writer(0);
    expect(target.position.x).toBeCloseTo(10);
  });
});

describe("dolly", () => {
  test("moves toward the point by eased distance", () => {
    const target = makeTarget({ position: { x: 0, y: 0, z: 10 } });
    const writer = dolly(target, makeTiming({ duration: 2, ease: "linear" }), {
      toward: () => ({ x: 0, y: 0, z: 0 }),
      distance: 4,
    });
    writer(1); // halfway → moved 2 toward origin
    expect(target.position.z).toBeCloseTo(8);
    writer(2);
    expect(target.position.z).toBeCloseTo(6);
    writer(0);
    expect(target.position.z).toBeCloseTo(10); // idempotent return to start
  });
});

describe("bounce-in", () => {
  test("hidden before start, full scale after end, overshoots mid-way", () => {
    const target = makeTarget({ scale: { x: 2, y: 2, z: 2 } });
    const writer = bounceIn(target, makeTiming({ start: 1, duration: 1, ease: "back.out" }));
    writer(0.5);
    expect(target.scale.x).toBe(0);
    writer(1.7); // back.out overshoots around p≈0.7
    expect(target.scale.x).toBeGreaterThan(2);
    writer(5);
    expect(target.scale.x).toBeCloseTo(2);
  });
});

describe("fade-in", () => {
  test("drives the opacity factor through the window", () => {
    const values: number[] = [];
    const writer = fadeIn((f) => values.push(f), makeTiming({ start: 0, duration: 2, ease: "linear" }));
    writer(0);
    writer(1);
    writer(2);
    expect(values[0]).toBeCloseTo(0);
    expect(values[1]).toBeCloseTo(0.5);
    expect(values[2]).toBeCloseTo(1);
  });
});

describe("move", () => {
  test("lerps from initial position to target over the window", () => {
    const target = makeTarget({ position: { x: 0, y: 0, z: 0 } });
    const writer = move(target, makeTiming({ start: 1, duration: 2, ease: "linear" }), {
      to: { x: 4, y: 0, z: -8 },
    });
    writer(0);
    expect(target.position.x).toBeCloseTo(0);
    writer(2); // halfway
    expect(target.position.x).toBeCloseTo(2);
    expect(target.position.z).toBeCloseTo(-4);
    writer(10); // clamped at end
    expect(target.position.x).toBeCloseTo(4);
    writer(2); // idempotent random-access
    expect(target.position.x).toBeCloseTo(2);
  });

  test("explicit from overrides initial position", () => {
    const target = makeTarget({ position: { x: 99, y: 0, z: 0 } });
    const writer = move(target, makeTiming({ duration: 1, ease: "linear" }), {
      from: { x: 0, y: 0, z: 0 },
      to: { x: 10, y: 0, z: 0 },
    });
    writer(0.5);
    expect(target.position.x).toBeCloseTo(5);
  });
});

describe("follow", () => {
  test("tracks a moving subject at a fixed offset", () => {
    const target = makeTarget();
    let sx = 0;
    const writer = follow(target, {
      subject: () => ({ x: sx, y: 0, z: 0 }),
      offset: { x: 0, y: 2, z: 5 },
    });
    writer(0);
    expect(target.position.z).toBeCloseTo(5);
    sx = 7;
    writer(1);
    expect(target.position.x).toBeCloseTo(7);
    expect(target.position.y).toBeCloseTo(2);
  });
});

describe("crossfade-clip", () => {
  test("weights sum to 1 and ramp through the window", () => {
    let fw = -1;
    let tw = -1;
    const writer = crossfadeClips(
      (f, t) => {
        fw = f;
        tw = t;
      },
      makeTiming({ start: 2, duration: 1, ease: "linear" }),
    );
    writer(0);
    expect(fw).toBeCloseTo(1);
    expect(tw).toBeCloseTo(0);
    writer(2.5);
    expect(fw).toBeCloseTo(0.5);
    expect(tw).toBeCloseTo(0.5);
    expect(fw + tw).toBeCloseTo(1);
    writer(9);
    expect(fw).toBeCloseTo(0);
    expect(tw).toBeCloseTo(1);
  });
});

describe("staggered-progress", () => {
  test("instance with zero delay finishes before the span ends", () => {
    expect(staggeredProgress(0, 0, 0.5)).toBeCloseTo(0);
    expect(staggeredProgress(0.5, 0, 0.5)).toBeCloseTo(1);
  });

  test("max-delay instance starts late and ends exactly at 1", () => {
    expect(staggeredProgress(0.5, 0.5, 0.5)).toBeCloseTo(0);
    expect(staggeredProgress(0.75, 0.5, 0.5)).toBeCloseTo(0.5);
    expect(staggeredProgress(1, 0.5, 0.5)).toBeCloseTo(1);
  });

  test("no stagger degenerates to identity", () => {
    expect(staggeredProgress(0.3, 0, 0)).toBeCloseTo(0.3);
  });
});

describe("metaball orbits", () => {
  test("seeded orbits are reproducible and positions are pure in t", () => {
    const { makeOrbits, orbitPosition } =
      require("../src/blocks/metaball") as typeof import("../src/blocks/metaball");
    const a = makeOrbits(4, 7, 0.7);
    const b = makeOrbits(4, 7, 0.7);
    expect(a).toEqual(b);
    const p1 = orbitPosition(a[0]!, 1.23);
    orbitPosition(a[0]!, 9.9);
    expect(orbitPosition(a[0]!, 1.23)).toEqual(p1);
    // stays inside the unit field with margin
    for (const o of a) {
      for (const t of [0, 1.7, 4.2, 11]) {
        const p = orbitPosition(o, t);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(1);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(1);
      }
    }
  });
});

describe("float", () => {
  test("sinusoidal bob is a pure function of t", () => {
    const target = makeTarget({ position: { x: 0, y: 3, z: 0 } });
    const writer = float(target, makeTiming({}), { amplitude: 0.5, period: 4 });
    writer(1); // quarter period → peak
    expect(target.position.y).toBeCloseTo(3.5);
    writer(2); // half period → back to base
    expect(target.position.y).toBeCloseTo(3);
    writer(3); // three-quarter → trough
    expect(target.position.y).toBeCloseTo(2.5);
  });
});
