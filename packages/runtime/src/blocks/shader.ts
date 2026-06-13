/**
 * <sf-shader> — author a fragment shader directly, with the boilerplate wired up.
 *
 * The escape hatch (`<script type="stereoframe">`) can already do custom GLSL,
 * but it's verbose. This element lets an author drop a fragment shader as the
 * element's text and get `uTime`, `uResolution`, a sin-free noise toolkit, and a
 * full-screen or mesh-bound surface for free. The biggest lever against the
 * "looks auto-generated" feel — generative/abstract/organic looks the markup
 * vocabulary can't express — while staying deterministic.
 *
 *   <sf-shader fullscreen u-tint="#ff5a36" u-speed="0.3">
 *     void main() {
 *       vec2 p = vUv * 3.0;
 *       float n = fbm(p + uTime * uSpeed);
 *       gl_FragColor = vec4(mix(vec3(0.04), uTint, n), 1.0);
 *     }
 *   </sf-shader>
 *
 * Determinism: `uTime` is a pure function of seek `t` (registered as a
 * timeUniform, set in seek.ts). The noise toolkit is sin-free hash noise, so it
 * is also byte-stable across runs. No wall clock, no accumulation.
 *
 * In scope inside your fragment: `vUv` (0..1), `uTime` (seconds), `uResolution`
 * (px), any `u-<name>` attribute as `u<Name>`, and `hash21/hash22/vnoise/fbm`.
 */
import * as THREE from "three";

export interface ShaderBuild {
  mesh: THREE.Mesh;
  timeUniform: { value: number };
}

/** Sin-free hash noise (Dave Hoskins style) — deterministic + seek-safe. */
const TOOLKIT = `
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash22(vec2 p){ vec3 a = fract(p.xyx * vec3(123.34, 234.34, 345.65)); a += dot(a, a + 34.45); return fract(vec2(a.x * a.y, a.y * a.z)); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  float a=hash21(i), b=hash21(i+vec2(1.0,0.0)), c=hash21(i+vec2(0.0,1.0)), d=hash21(i+vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v += a*vnoise(p); p*=2.0; a*=0.5; } return v; }
`;

const FULLSCREEN_VERT = `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const MESH_VERT = `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** A pleasant default so `<sf-shader fullscreen>` is never blank. */
const DEFAULT_FRAG = `void main(){
  vec2 p = vUv * 3.0;
  float n = fbm(p + vec2(uTime * 0.15, uTime * 0.05));
  vec3 col = mix(vec3(0.03,0.04,0.07), vec3(0.20,0.55,0.85), smoothstep(0.2,0.8,n));
  gl_FragColor = vec4(col, 1.0);
}`;

const toCamel = (name: string) => "u" + name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());

/** Parse a `u-*` attribute value into a typed three uniform + its GLSL decl. */
function parseUniform(raw: string): { value: unknown; glsl: string } | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^#|^0x/i.test(v) || /^[a-z]+$/i.test(v)) {
    return { value: new THREE.Color(v), glsl: "vec3" }; // color → vec3
  }
  const nums = v.split(/[\s,]+/).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 1) return { value: nums[0], glsl: "float" };
  if (nums.length === 2) return { value: new THREE.Vector2(nums[0], nums[1]), glsl: "vec2" };
  if (nums.length === 3) return { value: new THREE.Vector3(nums[0], nums[1], nums[2]), glsl: "vec3" };
  if (nums.length === 4) return { value: new THREE.Vector4(nums[0], nums[1], nums[2], nums[3]), glsl: "vec4" };
  return null;
}

export function buildShader(
  el: Element,
  opts: { width: number; height: number; geometry: THREE.BufferGeometry; fullscreen: boolean },
): ShaderBuild {
  const timeUniform = { value: 0 };
  const uniforms: Record<string, { value: unknown }> = {
    uTime: timeUniform,
    uResolution: { value: new THREE.Vector2(opts.width, opts.height) },
  };
  const decls: string[] = ["uniform float uTime;", "uniform vec2 uResolution;", "varying vec2 vUv;"];

  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith("u-")) continue;
    const parsed = parseUniform(attr.value);
    if (!parsed) continue;
    const name = toCamel(attr.name.slice(2));
    uniforms[name] = { value: parsed.value };
    decls.push(`uniform ${parsed.glsl} ${name};`);
  }

  const body = (el.textContent ?? "").trim() || DEFAULT_FRAG;
  const fragmentShader = `${decls.join("\n")}\n${TOOLKIT}\n${body}`;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: opts.fullscreen ? FULLSCREEN_VERT : MESH_VERT,
    fragmentShader,
    transparent: el.getAttribute("transparent") === "true",
    depthTest: !opts.fullscreen,
    depthWrite: !opts.fullscreen,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(opts.geometry, material);
  if (opts.fullscreen) {
    // A clip-space quad drawn first, ignoring the camera — a background canvas
    // that 3D geometry composites on top of.
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
  }
  return { mesh, timeUniform };
}
