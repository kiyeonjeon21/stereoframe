/**
 * <sf-ocean> — animated water plane (three.js Water addon).
 *
 * The Water shader's `time` uniform is the only moving part; we expose it
 * through a setter proxy so the seek loop's `u.value = t` assignment lands
 * as `t * speed` — a pure function of seek time, idempotent for any seek
 * order. The reflection render target updates inside renderer.render(),
 * also purely from current scene state.
 *
 *   <sf-ocean size="2000" color="#001e0f" speed="1"
 *             normals="assets/waternormals.jpg"></sf-ocean>
 *
 * Requires the water normal map (install with `stereoframe add ocean`).
 */
import { Color, PlaneGeometry, RepeatWrapping, TextureLoader, Vector3 } from "three";
import { Water } from "three/addons/objects/Water.js";
import { parseColorString, parseNumber, parseVec3 } from "../parse";

export interface OceanBuild {
  water: Water;
  /** Seek-loop compatible: assigning `value = t` advances the shader by t*speed. */
  timeProxy: { value: number };
  pending: Promise<unknown>;
  /** Call when an <sf-sky> sun direction is known (overrides the attr). */
  setSunDirection: (dir: Vector3) => void;
}

export function buildOcean(el: Element): OceanBuild {
  const size = parseNumber(el.getAttribute("size"), 2000);
  const speed = parseNumber(el.getAttribute("speed"), 1);
  const normalsSrc = el.getAttribute("normals") ?? "assets/waternormals.jpg";

  const loader = new TextureLoader();
  let resolveNormals!: (v: unknown) => void;
  const pending = new Promise((r) => {
    resolveNormals = r;
  });

  const water = new Water(new PlaneGeometry(size, size), {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: loader.load(normalsSrc, (tex) => {
      tex.wrapS = tex.wrapT = RepeatWrapping;
      resolveNormals(tex);
    }),
    sunDirection: new Vector3(...parseVec3(el.getAttribute("sun-direction"), [0.7, 0.6, 0.3])),
    sunColor: new Color(parseColorString(el.getAttribute("sun-color"), "#ffffff")),
    waterColor: new Color(parseColorString(el.getAttribute("color"), "#001e0f")),
    distortionScale: parseNumber(el.getAttribute("distortion-scale"), 3.7),
    alpha: parseNumber(el.getAttribute("alpha"), 1),
    clipBias: 0.0,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.set(...parseVec3(el.getAttribute("position"), [0, 0, 0]));

  const uniforms = water.material.uniforms;
  const timeProxy = {
    get value(): number {
      return uniforms.time!.value / (speed || 1);
    },
    set value(t: number) {
      uniforms.time!.value = t * speed;
    },
  };

  return {
    water,
    timeProxy,
    pending,
    setSunDirection: (dir) => {
      (uniforms.sunDirection!.value as Vector3).copy(dir).normalize();
    },
  };
}
