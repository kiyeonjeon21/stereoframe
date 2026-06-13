/**
 * <sf-scatter> — seeded instancing of a primitive across a distribution, with
 * analytic per-instance spin + float. A field of objects (a forest, a debris
 * cloud, a grid of tiles) in one element — huge creative range vs a single mesh,
 * and fully deterministic: every instance's transform is a closed-form function
 * of (seeded attributes, t). Mirrors the swarm.ts InstancedMesh pattern.
 *
 *   <sf-scatter geometry="icosahedron" args="0.4 0"
 *               count="120" seed="3" area="8 4 8" distribution="sphere"
 *               material="matcap" matcap="chrome"
 *               spin="6" float="0.3" scale-min="0.5" scale-max="1.4"></sf-scatter>
 */
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import type { BufferGeometry, Material } from "three";
import { mulberry32 } from "../rng";
import { parseNumber, parseVec3 } from "../parse";

export interface ScatterBuild {
  mesh: InstancedMesh;
  writer: (t: number) => void;
}

const _pos = new Vector3();
const _quat = new Quaternion();
const _axis = new Vector3();
const _scale = new Vector3();
const _mat = new Matrix4();

export function buildScatter(
  el: Element,
  geometry: BufferGeometry,
  material: Material,
): ScatterBuild {
  const count = Math.max(1, Math.floor(parseNumber(el.getAttribute("count"), 80)));
  const seed = Math.floor(parseNumber(el.getAttribute("seed"), 1));
  const area = parseVec3(el.getAttribute("area"), [6, 3, 6]);
  const center = parseVec3(el.getAttribute("position"), [0, 0, 0]);
  const sphere = (el.getAttribute("distribution") ?? "box").toLowerCase() === "sphere";
  const sMin = parseNumber(el.getAttribute("scale-min"), 0.6);
  const sMax = parseNumber(el.getAttribute("scale-max"), 1.2);
  const spinRpm = parseNumber(el.getAttribute("spin"), 0);
  const floatAmp = parseNumber(el.getAttribute("float"), 0);
  const paletteAttr = el.getAttribute("palette");
  const palette = paletteAttr ? paletteAttr.split(",").map((c) => new Color(c.trim())) : null;

  const rand = mulberry32(seed);
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.position.set(center[0], center[1], center[2]);
  mesh.frustumCulled = false;

  const basePos = new Float32Array(count * 3);
  const scaleArr = new Float32Array(count);
  const axes: Vector3[] = [];
  const baseAngle = new Float32Array(count);
  const spinSign = new Float32Array(count);
  const floatPhase = new Float32Array(count);
  const floatFreq = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    if (sphere) {
      // uniform-ish in an ellipsoid: random direction × cube-root radius
      const dir = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      const r = Math.cbrt(rand());
      basePos[i * 3] = dir.x * r * area[0];
      basePos[i * 3 + 1] = dir.y * r * area[1];
      basePos[i * 3 + 2] = dir.z * r * area[2];
    } else {
      basePos[i * 3] = (rand() - 0.5) * area[0];
      basePos[i * 3 + 1] = (rand() - 0.5) * area[1];
      basePos[i * 3 + 2] = (rand() - 0.5) * area[2];
    }
    scaleArr[i] = sMin + rand() * Math.max(0, sMax - sMin);
    axes.push(new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize());
    baseAngle[i] = rand() * Math.PI * 2;
    spinSign[i] = rand() < 0.5 ? -1 : 1;
    floatPhase[i] = rand() * Math.PI * 2;
    floatFreq[i] = 0.5 + rand();
    if (palette) mesh.setColorAt(i, palette[Math.floor(rand() * palette.length)]!);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const radPerSec = (spinRpm / 60) * Math.PI * 2;

  const writer = (t: number): void => {
    for (let i = 0; i < count; i++) {
      const angle = baseAngle[i]! + radPerSec * spinSign[i]! * t;
      _axis.set(axes[i]!.x, axes[i]!.y, axes[i]!.z);
      _quat.setFromAxisAngle(_axis, angle);
      const y = basePos[i * 3 + 1]! + floatAmp * Math.sin(floatPhase[i]! + t * floatFreq[i]! * Math.PI);
      _pos.set(basePos[i * 3]!, y, basePos[i * 3 + 2]!);
      _scale.setScalar(scaleArr[i]!);
      _mat.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  writer(0);

  return { mesh, writer };
}
