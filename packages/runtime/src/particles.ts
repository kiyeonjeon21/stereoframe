/**
 * <sf-particles> — stateless, analytically-animated GPU particles.
 *
 * Every particle's position is a closed-form function of (per-particle
 * seeded attributes, uTime). No simulation steps, no ping-pong state: any
 * frame can be seeked in any order and re-rendered bit-identically. The
 * per-particle attributes come from mulberry32(seed), which is bit-exact
 * across JS engines.
 *
 * Presets:
 *   fountain — ballistic emitter (cone up, gravity, looping lifecycles)
 *   snow     — box volume, falling with sway, vertical wrap
 *   dust     — box volume, slow sinusoidal wander (ambient motes)
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Blending,
} from "three";
import { parseColorString, parseNumber, parseVec3 } from "./parse";
import { mulberry32 } from "./rng";

const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.15, d) * vFade * uOpacity;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const VERTEX_FOUNTAIN = /* glsl */ `
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  uniform float uTime;
  uniform float uSize;
  uniform float uGravity;
  varying float vFade;
  void main() {
    float age = mod(uTime + aBirth, aLife);
    float n = age / aLife;
    vec3 pos = position + aVel * age + 0.5 * vec3(0.0, -uGravity, 0.0) * age * age;
    vFade = smoothstep(0.0, 0.08, n) * (1.0 - smoothstep(0.65, 1.0, n));
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uSize * (300.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const VERTEX_SNOW = /* glsl */ `
  attribute vec3 aWobble; // x: phase, y: fall speed, z: sway amplitude
  uniform float uTime;
  uniform float uSize;
  uniform vec3 uArea;
  varying float vFade;
  void main() {
    vec3 pos = position;
    pos.x += aWobble.z * sin(uTime * 0.8 + aWobble.x);
    pos.z += aWobble.z * cos(uTime * 0.6 + aWobble.x * 1.37);
    pos.y = uArea.y * 0.5 - mod(position.y + uTime * aWobble.y, uArea.y);
    vFade = 1.0;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uSize * (300.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const VERTEX_DUST = /* glsl */ `
  attribute vec3 aFreq;
  attribute vec3 aPhase;
  uniform float uTime;
  uniform float uSize;
  uniform float uAmp;
  varying float vFade;
  void main() {
    vec3 pos = position + uAmp * vec3(
      sin(uTime * aFreq.x + aPhase.x),
      sin(uTime * aFreq.y + aPhase.y),
      sin(uTime * aFreq.z + aPhase.z)
    );
    vFade = 0.55 + 0.45 * sin(uTime * aFreq.y * 0.7 + aPhase.z);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uSize * (300.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

export interface ParticleBuild {
  points: Points;
  timeUniform: { value: number };
}

export function buildParticles(el: Element): ParticleBuild {
  const preset = (el.getAttribute("preset") ?? "fountain").toLowerCase();
  const count = Math.max(1, Math.floor(parseNumber(el.getAttribute("count"), 500)));
  const seed = Math.floor(parseNumber(el.getAttribute("seed"), 1));
  const size = parseNumber(el.getAttribute("size"), 0.08);
  const opacity = parseNumber(el.getAttribute("opacity"), 0.9);
  const color = new Color(parseColorString(el.getAttribute("color"), "#ffffff"));
  const area = parseVec3(el.getAttribute("area"), [6, 4, 6]);
  const rand = mulberry32(seed);

  const geometry = new BufferGeometry();
  const positions = new Float32Array(count * 3);
  const uTime = { value: 0 };

  const uniforms: Record<string, { value: unknown }> = {
    uTime,
    uSize: { value: size },
    uColor: { value: color },
    uOpacity: { value: opacity },
  };

  let vertexShader: string;
  let blending: Blending = AdditiveBlending;

  if (preset === "snow") {
    const wobble = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * area[0];
      positions[i * 3 + 1] = rand() * area[1];
      positions[i * 3 + 2] = (rand() - 0.5) * area[2];
      wobble[i * 3] = rand() * Math.PI * 2; // phase
      wobble[i * 3 + 1] = 0.4 + rand() * 0.8; // fall speed
      wobble[i * 3 + 2] = 0.05 + rand() * 0.25; // sway
    }
    geometry.setAttribute("aWobble", new BufferAttribute(wobble, 3));
    uniforms.uArea = { value: { x: area[0], y: area[1], z: area[2] } };
    vertexShader = VERTEX_SNOW;
    blending = NormalBlending;
  } else if (preset === "dust") {
    const freq = new Float32Array(count * 3);
    const phase = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * area[0];
      positions[i * 3 + 1] = (rand() - 0.5) * area[1];
      positions[i * 3 + 2] = (rand() - 0.5) * area[2];
      for (let k = 0; k < 3; k++) {
        freq[i * 3 + k] = 0.1 + rand() * 0.5;
        phase[i * 3 + k] = rand() * Math.PI * 2;
      }
    }
    geometry.setAttribute("aFreq", new BufferAttribute(freq, 3));
    geometry.setAttribute("aPhase", new BufferAttribute(phase, 3));
    uniforms.uAmp = { value: parseNumber(el.getAttribute("amplitude"), 0.4) };
    vertexShader = VERTEX_DUST;
  } else {
    // fountain
    const speed = parseNumber(el.getAttribute("speed"), 3);
    const spreadDeg = parseNumber(el.getAttribute("spread"), 25);
    const life = parseNumber(el.getAttribute("life"), 2.5);
    const vel = new Float32Array(count * 3);
    const birth = new Float32Array(count);
    const lifeAttr = new Float32Array(count);
    const spreadRad = (spreadDeg * Math.PI) / 180;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * 0.05;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = (rand() - 0.5) * 0.05;
      const az = rand() * Math.PI * 2;
      const tilt = rand() * spreadRad;
      const s = speed * (0.7 + rand() * 0.6);
      vel[i * 3] = Math.sin(tilt) * Math.sin(az) * s;
      vel[i * 3 + 1] = Math.cos(tilt) * s;
      vel[i * 3 + 2] = Math.sin(tilt) * Math.cos(az) * s;
      lifeAttr[i] = life * (0.6 + rand() * 0.8);
      birth[i] = rand() * lifeAttr[i];
    }
    geometry.setAttribute("aVel", new BufferAttribute(vel, 3));
    geometry.setAttribute("aBirth", new BufferAttribute(birth, 1));
    geometry.setAttribute("aLife", new BufferAttribute(lifeAttr, 1));
    uniforms.uGravity = { value: parseNumber(el.getAttribute("gravity"), 4) };
    vertexShader = VERTEX_FOUNTAIN;
  }

  geometry.setAttribute("position", new BufferAttribute(positions, 3));

  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false; // analytic positions live in the shader
  points.position.set(...parseVec3(el.getAttribute("position"), [0, 0, 0]));
  return { points, timeUniform: uTime };
}
