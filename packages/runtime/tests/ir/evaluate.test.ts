import { describe, expect, test } from "bun:test";
import { compile } from "../../src/ir/compile";
import { evaluate } from "../../src/ir/evaluate";
import type { NodeBase, SceneIR } from "../../src/ir/types";

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
