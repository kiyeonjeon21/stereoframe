/**
 * <sf-metaball> — gooey marching-cubes blobs (liquid/marble look).
 *
 * Ball centers follow closed-form seeded orbits — position = f(seed_i, t) —
 * so the field is rebuilt from scratch every seek: stateless, random-access
 * safe, bit-stable per seed. Material attributes reuse the sf-mesh
 * vocabulary (color/material/roughness/metalness/transmission/…).
 *
 *   <sf-metaball count="5" seed="3" resolution="56" scale="2.4"
 *                color="#f5f5f0" material="physical" roughness="0.08"
 *                position="0 1 0" speed="0.7"></sf-metaball>
 */
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import type { Material } from "three";
import { parseNumber, parseVec3 } from "../parse";
import { mulberry32 } from "../rng";

export interface BallOrbit {
  /** Base position inside the unit field (0..1). */
  cx: number;
  cy: number;
  cz: number;
  /** Per-axis orbit radii, angular speeds, phases. */
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  px: number;
  py: number;
  pz: number;
  strength: number;
}

/** Pure: seeded orbit parameters for `count` balls (unit-tested). */
export function makeOrbits(count: number, seed: number, strength: number): BallOrbit[] {
  const rand = mulberry32(seed);
  const orbits: BallOrbit[] = [];
  for (let i = 0; i < count; i++) {
    orbits.push({
      cx: 0.38 + rand() * 0.24,
      cy: 0.38 + rand() * 0.24,
      cz: 0.38 + rand() * 0.24,
      rx: 0.06 + rand() * 0.16,
      ry: 0.06 + rand() * 0.16,
      rz: 0.04 + rand() * 0.1,
      wx: 0.3 + rand() * 0.7,
      wy: 0.3 + rand() * 0.7,
      wz: 0.3 + rand() * 0.7,
      px: rand() * Math.PI * 2,
      py: rand() * Math.PI * 2,
      pz: rand() * Math.PI * 2,
      strength: strength * (0.7 + rand() * 0.6),
    });
  }
  return orbits;
}

/** Pure: ball center inside the unit field at time t. */
export function orbitPosition(o: BallOrbit, t: number): { x: number; y: number; z: number } {
  return {
    x: o.cx + o.rx * Math.sin(t * o.wx + o.px),
    y: o.cy + o.ry * Math.sin(t * o.wy + o.py),
    z: o.cz + o.rz * Math.cos(t * o.wz + o.pz),
  };
}

export interface MetaballBuild {
  mesh: MarchingCubes;
  writer: (t: number) => void;
}

export function buildMetaball(el: Element, material: Material): MetaballBuild {
  const count = Math.max(1, Math.floor(parseNumber(el.getAttribute("count"), 5)));
  const seed = Math.floor(parseNumber(el.getAttribute("seed"), 1));
  const resolution = Math.max(16, Math.floor(parseNumber(el.getAttribute("resolution"), 56)));
  const speed = parseNumber(el.getAttribute("speed"), 0.7);
  const strength = parseNumber(el.getAttribute("strength"), 0.7);
  const scale = parseNumber(el.getAttribute("scale"), 2);

  const mesh = new MarchingCubes(resolution, material, true, true, 60000);
  mesh.isolation = parseNumber(el.getAttribute("isolation"), 60);
  mesh.position.set(...parseVec3(el.getAttribute("position"), [0, 0, 0]));
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const orbits = makeOrbits(count, seed, strength);

  const writer = (t: number): void => {
    const time = t * speed;
    mesh.reset();
    for (const orbit of orbits) {
      const p = orbitPosition(orbit, time);
      mesh.addBall(p.x, p.y, p.z, orbit.strength, 12);
    }
    mesh.update();
  };
  writer(0);

  return { mesh, writer };
}
