/**
 * <sf-sky> — physical atmosphere dome (three.js Sky addon).
 *
 * Pure shader, no assets, no time dependence — deterministic by construction.
 * The sun position doubles as the reference other blocks can read (sf-ocean
 * picks it up automatically when present).
 *
 *   <sf-sky elevation="12" azimuth="200" turbidity="8" rayleigh="2"></sf-sky>
 */
import { MathUtils, Vector3 } from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { parseNumber } from "../parse";

export interface SkyBuild {
  sky: Sky;
  sunDirection: Vector3;
}

export function buildSky(el: Element): SkyBuild {
  const sky = new Sky();
  sky.scale.setScalar(parseNumber(el.getAttribute("scale"), 2000));

  const uniforms = sky.material.uniforms;
  uniforms.turbidity!.value = parseNumber(el.getAttribute("turbidity"), 10);
  uniforms.rayleigh!.value = parseNumber(el.getAttribute("rayleigh"), 2);
  uniforms.mieCoefficient!.value = parseNumber(el.getAttribute("mie-coefficient"), 0.005);
  uniforms.mieDirectionalG!.value = parseNumber(el.getAttribute("mie-directional-g"), 0.8);

  const elevation = parseNumber(el.getAttribute("elevation"), 15);
  const azimuth = parseNumber(el.getAttribute("azimuth"), 180);
  const phi = MathUtils.degToRad(90 - elevation);
  const theta = MathUtils.degToRad(azimuth);
  const sunDirection = new Vector3().setFromSphericalCoords(1, phi, theta);
  uniforms.sunPosition!.value.copy(sunDirection);

  return { sky, sunDirection };
}
