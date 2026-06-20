import { describe, expect, test } from "bun:test";
import { Euler, Quaternion } from "three";
import { compile } from "../../src/ir/compile";
import { evaluate } from "../../src/ir/evaluate";
import type { NodeBase, SceneIR, Vec3 } from "../../src/ir/types";

const camera: NodeBase = {
  id: "camera",
  kind: "camera",
  position: [0, 0.35, 4.4],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  fov: 33,
};
const product: NodeBase = {
  id: "product",
  kind: "model",
  position: [0, 0.15, 0],
  rotation: [0, 0, 0],
  scale: [6, 6, 6],
};

describe("evaluate — drivers", () => {
  test("orbit places the camera on the arc around the subject", () => {
    const scene: SceneIR = {
      nodes: [camera, product],
      behaviors: [],
      timeline: {
        kind: "par",
        children: [
          {
            kind: "clip",
            ease: "linear",
            duration: 8,
            driver: { kind: "orbit", target: "camera", around: "product", radius: 4, fromDeg: 0, toDeg: 90, height: 0 },
          },
        ],
      },
    };
    const c = compile(scene);

    const a = evaluate(c, 0);
    expect(a.camera.position![0]).toBeCloseTo(0);
    expect(a.camera.position![1]).toBeCloseTo(0.15); // subject y + height
    expect(a.camera.position![2]).toBeCloseTo(4);

    const b = evaluate(c, 8);
    expect(b.camera.position![0]).toBeCloseTo(4); // 90° → on +X
    expect(b.camera.position![2]).toBeCloseTo(0);
  });

  test("zoom ramps camera fov", () => {
    const scene: SceneIR = {
      nodes: [camera],
      behaviors: [],
      timeline: { kind: "clip", ease: "linear", duration: 2, driver: { kind: "zoom", target: "camera", from: 30, to: 60 } },
    };
    const c = compile(scene);
    expect(evaluate(c, 1).camera.fov).toBeCloseTo(45);
    expect(evaluate(c, 2).camera.fov).toBeCloseTo(60);
  });
});

describe("evaluate — behaviors", () => {
  test("turntable spins about the axis as f(t)", () => {
    const scene: SceneIR = {
      nodes: [product],
      behaviors: [{ kind: "turntable", target: "product", rpm: 5, axis: "y" }],
    };
    const c = compile(scene);
    // 5 rpm → 0.5 rev at 6s → π
    expect(evaluate(c, 6).nodes.get("product")!.rotation[1]).toBeCloseTo(Math.PI);
  });

  test("per-part turntable spins an off-center part about its pivot", () => {
    const wheel: NodeBase = { id: "wheel", kind: "mesh", position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [wheel],
      behaviors: [{ kind: "turntable", target: "wheel", rpm: 60, axis: "y", pivot: [0, 0, 0] }],
    };
    const c = compile(scene);
    const p = evaluate(c, 0.25).nodes.get("wheel")!.position; // 60rpm → quarter rev at 0.25s
    expect(p[0]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(-1);
  });

  test("turntable + sway compose additively on Y (IR fix vs legacy clobber)", () => {
    // Legacy `sway` ASSIGNS rotation.y, overwriting turntable's Y spin when both
    // run on one object (type-poster). IR adds both — the spin is preserved.
    const node: NodeBase = { id: "f", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [node],
      behaviors: [
        { kind: "turntable", target: "f", rpm: 6, axis: "y" },
        { kind: "sway", target: "f", amount: 0.15, period: 6 },
      ],
    };
    const c = compile(scene);
    const spinOnly = (6 / 60) * Math.PI * 2 * 5; // turntable y at t=5
    const y = evaluate(c, 5).nodes.get("f")!.rotation[1];
    expect(y).toBeGreaterThan(spinOnly - 0.2); // spin retained (sway only nudges it)
    expect(y).not.toBe(spinOnly); // sway's Y term is added on top
  });

  test("float bobs additively on Y", () => {
    const node: NodeBase = { id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = { nodes: [node], behaviors: [{ kind: "float", target: "a", amplitude: 1, period: 4 }] };
    const c = compile(scene);
    expect(evaluate(c, 1).nodes.get("a")!.position[1]).toBeCloseTo(1); // quarter period → peak
  });
});

describe("evaluate — behavior windows (start/until/ramp)", () => {
  const node = (): NodeBase => ({ id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

  test("turntable start: 0 before start; angle = legacy max(0,t-start) worth (parity)", () => {
    const c = compile({ nodes: [node()], behaviors: [{ kind: "turntable", target: "a", rpm: 60, axis: "y", from: 2 }] });
    expect(evaluate(c, 1).nodes.get("a")!.rotation[1]).toBe(0); // before start
    // 60rpm = 1 rev/s = 2π/s; at t=3, active=1s → 2π. legacy activeTime(3)=max(0,3-2)=1.
    expect(evaluate(c, 3).nodes.get("a")!.rotation[1]).toBeCloseTo(2 * Math.PI);
  });

  test("turntable until: angle freezes after the window (holds, never unwinds)", () => {
    const c = compile({ nodes: [node()], behaviors: [{ kind: "turntable", target: "a", rpm: 60, axis: "y", until: 5 }] });
    const atEnd = evaluate(c, 5).nodes.get("a")!.rotation[1]; // 5 revs → 10π
    expect(atEnd).toBeCloseTo(10 * Math.PI);
    expect(evaluate(c, 9).nodes.get("a")!.rotation[1]).toBeCloseTo(atEnd); // frozen
  });

  test("turntable ramp: ramped-in angle is less than the un-ramped angle", () => {
    const plain = compile({ nodes: [node()], behaviors: [{ kind: "turntable", target: "a", rpm: 60, axis: "y" }] });
    const ramped = compile({ nodes: [node()], behaviors: [{ kind: "turntable", target: "a", rpm: 60, axis: "y", ramp: 2 }] });
    const p = evaluate(plain, 1).nodes.get("a")!.rotation[1];
    const r = evaluate(ramped, 1).nodes.get("a")!.rotation[1];
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(p); // velocity eased in → less accumulated angle at t=1
  });

  test("float until: contribution returns to base after the window", () => {
    const c = compile({ nodes: [node()], behaviors: [{ kind: "float", target: "a", amplitude: 1, period: 4, until: 3 }] });
    expect(evaluate(c, 1).nodes.get("a")!.position[1]).toBeCloseTo(1); // in window, peak
    expect(evaluate(c, 5).nodes.get("a")!.position[1]).toBe(0); // past until → base
  });

  test("default (no window) is unchanged — always-on from t=0", () => {
    const c = compile({ nodes: [node()], behaviors: [{ kind: "turntable", target: "a", rpm: 60, axis: "y" }] });
    expect(evaluate(c, 0.5).nodes.get("a")!.rotation[1]).toBeCloseTo(Math.PI); // half rev — same as before windows
  });
});

describe("evaluate — per-channel hold + dynamic refs", () => {
  const a: NodeBase = { id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

  test("a not-yet-started later move does NOT clobber the active one (hold fix)", () => {
    const scene: SceneIR = {
      nodes: [a],
      behaviors: [],
      timeline: {
        kind: "seq",
        children: [
          { kind: "clip", ease: "linear", duration: 2, driver: { kind: "move", target: "a", to: [10, 0, 0] } },
          { kind: "clip", ease: "linear", duration: 2, driver: { kind: "move", target: "a", from: [10, 0, 0], to: [10, 5, 0] } },
        ],
      },
    };
    const c = compile(scene);
    expect(evaluate(c, 1).nodes.get("a")!.position).toEqual([5, 0, 0]); // seg1 active, seg2 ignored
    expect(evaluate(c, 2).nodes.get("a")!.position).toEqual([10, 0, 0]); // seg2 just held, p=0
    expect(evaluate(c, 4).nodes.get("a")!.position).toEqual([10, 5, 0]); // seg2 done
  });

  test("orbit center tracks a moving subject (pass-2 dynamic ref)", () => {
    const cam: NodeBase = { id: "camera", kind: "camera", position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1], fov: 35 };
    const s: NodeBase = { id: "s", kind: "model", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [cam, s],
      behaviors: [],
      timeline: {
        kind: "par",
        children: [
          { kind: "clip", ease: "linear", duration: 4, driver: { kind: "move", target: "s", to: [10, 0, 0] } },
          { kind: "clip", ease: "linear", duration: 4, driver: { kind: "orbit", target: "camera", around: "s", radius: 2, fromDeg: 0, toDeg: 0, height: 0 } },
        ],
      },
    };
    const c = compile(scene);
    const cp = evaluate(c, 4).camera.position!;
    expect(cp[0]).toBeCloseTo(10); // subject moved to x=10, camera orbits around it
    expect(cp[2]).toBeCloseTo(2);
  });

  test("follow tracks a moving subject at a fixed offset", () => {
    const cam: NodeBase = { id: "camera", kind: "camera", position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1], fov: 35 };
    const s: NodeBase = { id: "s", kind: "model", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [cam, s],
      behaviors: [],
      timeline: {
        kind: "par",
        children: [
          { kind: "clip", ease: "linear", duration: 4, driver: { kind: "move", target: "s", to: [10, 0, 0] } },
          { kind: "clip", ease: "linear", duration: 4, driver: { kind: "follow", target: "camera", subject: "s", offset: [0, 1, 5] } },
        ],
      },
    };
    const c = compile(scene);
    expect(evaluate(c, 4).camera.position).toEqual([10, 1, 5]);
  });
});

describe("evaluate — entrance + material channels", () => {
  const a: NodeBase = { id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] };

  test("bounce-in holds scale 0 before its window, then scales to rest", () => {
    const scene: SceneIR = {
      nodes: [a],
      behaviors: [],
      timeline: { kind: "seq", children: [{ kind: "wait", duration: 1 }, { kind: "clip", ease: "linear", duration: 0.6, driver: { kind: "bounce-in", target: "a" } }] },
    };
    const c = compile(scene);
    expect(evaluate(c, 0.5).nodes.get("a")!.scale).toEqual([0, 0, 0]); // before start = from(0)
    expect(evaluate(c, 1.3).nodes.get("a")!.scale[0]).toBeCloseTo(1); // half → rest×0.5
    expect(evaluate(c, 2).nodes.get("a")!.scale).toEqual([2, 2, 2]); // done = rest
  });

  test("fade-in holds opacity 0 before its window, then ramps to 1", () => {
    const scene: SceneIR = {
      nodes: [a],
      behaviors: [],
      timeline: { kind: "seq", children: [{ kind: "wait", duration: 1 }, { kind: "clip", ease: "linear", duration: 0.6, driver: { kind: "fade-in", target: "a" } }] },
    };
    const c = compile(scene);
    expect(evaluate(c, 0.5).materials.get("a")!.opacity).toBe(0);
    expect(evaluate(c, 1.3).materials.get("a")!.opacity).toBeCloseTo(0.5);
    expect(evaluate(c, 2).materials.get("a")!.opacity).toBe(1);
  });

  test("variant chain: base before first, latest-active-wins, from=prev.to", () => {
    const g: NodeBase = { id: "g", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const v1: SceneIR["timeline"] = { kind: "clip", ease: "linear", duration: 1, driver: { kind: "variant", target: "g", from: { color: "#111111" }, to: { color: "#ff0000" } } };
    const v2: SceneIR["timeline"] = { kind: "clip", ease: "linear", duration: 1, driver: { kind: "variant", target: "g", from: { color: "#ff0000" }, to: { color: "#00ff00" } } };
    const scene: SceneIR = {
      nodes: [g],
      behaviors: [],
      timeline: { kind: "seq", children: [{ kind: "wait", duration: 1 }, v1, { kind: "wait", duration: 1 }, v2] },
    };
    const c = compile(scene);
    expect(evaluate(c, 0.5).materials.get("g")).toBeUndefined(); // before first variant (not an entrance)
    expect(evaluate(c, 1).materials.get("g")!.color).toEqual({ from: "#111111", to: "#ff0000", mix: 0 });
    expect(evaluate(c, 1.5).materials.get("g")!.color!.mix).toBeCloseTo(0.5);
    expect(evaluate(c, 2.5).materials.get("g")!.color!.mix).toBe(1); // between v1 end and v2 start → v1 held at p=1
    expect(evaluate(c, 3.5).materials.get("g")!.color).toEqual({ from: "#ff0000", to: "#00ff00", mix: 0.5 });
  });

  test("tween drives an arbitrary transform channel; state chain via held", () => {
    // Single-axis angle (slerp ≡ linear in the angle here, no gimbal extraction).
    const node: NodeBase = { id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [node],
      behaviors: [],
      timeline: {
        kind: "seq",
        children: [
          { kind: "clip", ease: "linear", duration: 1, driver: { kind: "tween", target: "a", channel: "rotation", from: [0, 0, 0], to: [0, 1, 0] } },
          { kind: "clip", ease: "linear", duration: 1, driver: { kind: "tween", target: "a", channel: "rotation", from: [0, 1, 0], to: [0, 0, 0] } },
        ],
      },
    };
    const c = compile(scene);
    expect(evaluate(c, 0.5).nodes.get("a")!.rotation[1]).toBeCloseTo(0.5);
    expect(evaluate(c, 1).nodes.get("a")!.rotation[1]).toBeCloseTo(1); // state A reached
    expect(evaluate(c, 1.5).nodes.get("a")!.rotation[1]).toBeCloseTo(0.5);
    expect(evaluate(c, 2).nodes.get("a")!.rotation[1]).toBeCloseTo(0); // back to initial
  });

  test("node id with '/' (lifted GLB part) drives + segment key parses on last '.'", () => {
    const part: NodeBase = { id: "car/wheel", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene: SceneIR = {
      nodes: [part],
      behaviors: [{ kind: "turntable", target: "car/wheel", rpm: 60, axis: "x" }],
      timeline: { kind: "clip", ease: "linear", duration: 1, driver: { kind: "tween", target: "car/wheel", channel: "scale", from: [1, 1, 1], to: [2, 2, 2] } },
    };
    const c = compile(scene);
    expect(c.segments.has("car/wheel.scale")).toBe(true); // key splits on the last '.'
    const fs = evaluate(c, 0.5);
    expect(fs.nodes.get("car/wheel")!.scale[0]).toBeCloseTo(1.5); // tween
    expect(fs.nodes.get("car/wheel")!.rotation[0]).toBeCloseTo(Math.PI); // turntable 60rpm @ t=0.5
  });

  test("rotation tween slerps (shortest arc), not componentwise Euler lerp", () => {
    const node: NodeBase = { id: "a", kind: "mesh", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const to: Vec3 = [Math.PI / 2, Math.PI / 2, 0];
    const scene: SceneIR = {
      nodes: [node],
      behaviors: [],
      timeline: { kind: "clip", ease: "linear", duration: 1, driver: { kind: "tween", target: "a", channel: "rotation", from: [0, 0, 0], to } },
    };
    const c = compile(scene);
    const mid = evaluate(c, 0.5).nodes.get("a")!.rotation;
    // Componentwise lerp would be [π/4, π/4, 0]; slerp takes a different (correct) arc.
    const drift = Math.abs(mid[0] - Math.PI / 4) + Math.abs(mid[1] - Math.PI / 4) + Math.abs(mid[2]);
    expect(drift).toBeGreaterThan(0.05);
    // …and it matches THREE's quaternion slerp → Euler.
    const ref = new Euler().setFromQuaternion(
      new Quaternion().slerp(new Quaternion().setFromEuler(new Euler(to[0], to[1], to[2], "XYZ")), 0.5),
      "XYZ",
    );
    expect(mid[0]).toBeCloseTo(ref.x, 9);
    expect(mid[1]).toBeCloseTo(ref.y, 9);
    expect(mid[2]).toBeCloseTo(ref.z, 9);
  });

  test("light-tween: intensity + color lerp resolved by the held model (day→night)", () => {
    const key: NodeBase = { id: "key", kind: "light", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const toNight: SceneIR["timeline"] = {
      kind: "clip",
      ease: "linear",
      duration: 1,
      driver: { kind: "light-tween", target: "key", from: { intensity: 2, color: "#ffffff" }, to: { intensity: 0.2, color: "#102040" } },
    };
    const scene: SceneIR = {
      nodes: [key],
      behaviors: [],
      timeline: { kind: "seq", children: [{ kind: "wait", duration: 1 }, toNight] },
    };
    const c = compile(scene);
    expect(evaluate(c, 0.5).lights.get("key")).toBeUndefined(); // before the transition (base light, no override)
    const mid = evaluate(c, 1.5).lights.get("key")!;
    expect(mid.intensity).toBeCloseTo(1.1); // halfway 2 → 0.2
    expect(mid.color).toEqual({ from: "#ffffff", to: "#102040", mix: 0.5 });
    expect(evaluate(c, 2).lights.get("key")!.intensity).toBeCloseTo(0.2); // night reached, held after
    expect(evaluate(c, 5).lights.get("key")!.intensity).toBeCloseTo(0.2);
  });
});

describe("evaluate — determinism", () => {
  const scene: SceneIR = {
    nodes: [camera, product],
    behaviors: [{ kind: "turntable", target: "product", rpm: 5, axis: "y" }],
    timeline: {
      kind: "par",
      children: [
        {
          kind: "clip",
          ease: "sine.inOut",
          duration: 8,
          driver: { kind: "orbit", target: "camera", around: "product", radius: 4, fromDeg: 0, toDeg: 35, height: 0 },
        },
      ],
    },
  };
  const c = compile(scene);

  function snap(t: number): string {
    const fs = evaluate(c, t);
    return JSON.stringify({ cam: fs.camera, prod: fs.nodes.get("product") });
  }

  test("evaluating the same t twice is identical", () => {
    expect(snap(3.21)).toBe(snap(3.21));
  });

  test("out-of-order seeks match in-order (no cross-t state)", () => {
    const ref = snap(3.21);
    snap(7);
    snap(0);
    snap(5.5);
    expect(snap(3.21)).toBe(ref);
  });
});
