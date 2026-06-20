import { describe, expect, test } from "bun:test";
import { Euler, Quaternion } from "three";
import { eulerToQuat, quatToEuler, slerp } from "../../src/ir/quat";
import type { Vec3 } from "../../src/ir/types";

// The pure helpers must match three.js (XYZ order) exactly — they're the shared
// orientation math the future path/lookAt migration relies on.

const ANGLES: Vec3[] = [
  [0, 0, 0],
  [Math.PI / 6, 0, 0], // single axis, small
  [0, Math.PI / 2, 0], // single axis, 90° (gimbal threshold)
  [0, Math.PI, 0], // 180° — extracts to an equivalent triple
  [0.3, -0.7, 1.1], // multi-axis
  [Math.PI / 3, Math.PI / 4, -Math.PI / 6],
];

describe("quat — matches THREE (XYZ)", () => {
  test("eulerToQuat == THREE.Quaternion.setFromEuler", () => {
    for (const a of ANGLES) {
      const q = eulerToQuat(a);
      const ref = new Quaternion().setFromEuler(new Euler(a[0], a[1], a[2], "XYZ"));
      expect(q[0]).toBeCloseTo(ref.x, 9);
      expect(q[1]).toBeCloseTo(ref.y, 9);
      expect(q[2]).toBeCloseTo(ref.z, 9);
      expect(q[3]).toBeCloseTo(ref.w, 9);
    }
  });

  test("quatToEuler == THREE.Euler.setFromQuaternion", () => {
    for (const a of ANGLES) {
      const ref = new Quaternion().setFromEuler(new Euler(a[0], a[1], a[2], "XYZ"));
      const e = quatToEuler([ref.x, ref.y, ref.z, ref.w]);
      const refE = new Euler().setFromQuaternion(ref, "XYZ");
      expect(e[0]).toBeCloseTo(refE.x, 9);
      expect(e[1]).toBeCloseTo(refE.y, 9);
      expect(e[2]).toBeCloseTo(refE.z, 9);
    }
  });

  test("180° Y-rotation round-trips to the equivalent [π,0,π] triple (documented nuance)", () => {
    const e = quatToEuler(eulerToQuat([0, Math.PI, 0]));
    expect(Math.abs(e[0])).toBeCloseTo(Math.PI, 9);
    expect(e[1]).toBeCloseTo(0, 9);
    expect(Math.abs(e[2])).toBeCloseTo(Math.PI, 9);
  });

  test("slerp == THREE.Quaternion.slerp (incl. shortest-arc on negative dot)", () => {
    const pairs: [Vec3, Vec3][] = [
      [[0, 0, 0], [0, Math.PI / 2, 0]],
      [[0, 0, 0], [0, Math.PI, 0]],
      [[0.2, 0.1, 0], [-0.5, 1.2, 0.3]],
      [[Math.PI / 2, 0, 0], [-Math.PI / 2, 0, 0]], // opposite → negative dot path
    ];
    for (const [from, to] of pairs) {
      const qa = eulerToQuat(from);
      const qb = eulerToQuat(to);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const r = slerp(qa, qb, t);
        const ref = new Quaternion(qa[0], qa[1], qa[2], qa[3]).slerp(
          new Quaternion(qb[0], qb[1], qb[2], qb[3]),
          t,
        );
        expect(r[0]).toBeCloseTo(ref.x, 9);
        expect(r[1]).toBeCloseTo(ref.y, 9);
        expect(r[2]).toBeCloseTo(ref.z, 9);
        expect(r[3]).toBeCloseTo(ref.w, 9);
      }
    }
  });
});
