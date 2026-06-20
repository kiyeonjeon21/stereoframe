/**
 * Pure quaternion helpers for the IR evaluator — three.js-free (the determinism
 * boundary stays Node-safe). The math mirrors three.js exactly so results match
 * `THREE.Quaternion`/`THREE.Euler` (XYZ order): `eulerToQuat` ↔ `Quaternion.
 * setFromEuler`, `quatToEuler` ↔ `Euler.setFromQuaternion` (via the same
 * rotation-matrix extraction), `slerp` ↔ `Quaternion.slerp`. This keeps named-state
 * rotation transitions on the natural shortest-arc path (no gimbal flips) and is the
 * shared orientation math the future `path`/lookAt migration will reuse.
 *
 * Rotation stays Euler radians in the IR/FrameState; slerp is an interpolation detail
 * here. quat→Euler can return a different-but-equivalent Euler triple for large/
 * multi-axis rotations (e.g. a 180° Y-rotation → [π,0,π]); the orientation is identical.
 */
import type { Vec3 } from "./types";

/** [x, y, z, w]. */
export type Quat = [number, number, number, number];

/** Euler radians (XYZ order) → quaternion. Mirrors THREE.Quaternion.setFromEuler. */
export function eulerToQuat(e: Vec3): Quat {
  const c1 = Math.cos(e[0] / 2);
  const c2 = Math.cos(e[1] / 2);
  const c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2);
  const s2 = Math.sin(e[1] / 2);
  const s3 = Math.sin(e[2] / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Quaternion → Euler radians (XYZ order). Mirrors THREE.Euler.setFromQuaternion
 *  (build the rotation matrix, then extract) so it matches three byte-for-byte. */
export function quatToEuler(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  // Rotation-matrix elements (math notation) for an unscaled quaternion.
  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m13 = xz + wy;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);

  const clamp = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
  const ey = Math.asin(clamp(m13));
  let ex: number;
  let ez: number;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  return [ex, ey, ez];
}

/** Shortest-arc spherical interpolation. Mirrors THREE.Quaternion.slerp (negates
 *  the target on a negative dot so it takes the short way round). */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  if (t <= 0) return [a[0], a[1], a[2], a[3]];
  if (t >= 1) return [b[0], b[1], b[2], b[3]];

  let [bx, by, bz, bw] = b;
  const [ax, ay, az, aw] = a;
  let cosHalfTheta = aw * bw + ax * bx + ay * by + az * bz;
  if (cosHalfTheta < 0) {
    cosHalfTheta = -cosHalfTheta;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cosHalfTheta >= 1.0) return [ax, ay, az, aw];

  const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;
  if (sqrSinHalfTheta <= Number.EPSILON) {
    const s = 1 - t;
    const r: Quat = [s * ax + t * bx, s * ay + t * by, s * az + t * bz, s * aw + t * bw];
    const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return [r[0] / len, r[1] / len, r[2] / len, r[3] / len];
  }

  const sinHalfTheta = Math.sqrt(sqrSinHalfTheta);
  const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return [
    ax * ratioA + bx * ratioB,
    ay * ratioA + by * ratioB,
    az * ratioA + bz * ratioB,
    aw * ratioA + bw * ratioB,
  ];
}
