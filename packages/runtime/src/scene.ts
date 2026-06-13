/**
 * Compiles <sf-scene> markup into a three.js scene graph.
 *
 * Everything async (GLB, HDRI, shader compilation) is gathered into the
 * returned `ready` promise. Callers must await it before the first seek —
 * the boot module top-level-awaits it, which delays DOMContentLoaded and
 * therefore delays the HyperFrames runtime (and the render engine's
 * `window.__hf` readiness poll) until all assets are resident.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildPostFX, type PostFX } from "./postfx";
import { getMatcap } from "./matcaps";
import { buildMetaball } from "./blocks/metaball";
import { buildContactShadow } from "./blocks/contactshadow";
import { buildOcean, type OceanBuild } from "./blocks/ocean";
import { buildSky } from "./blocks/sky";
import { buildSwarm } from "./blocks/swarm";
import { buildScatter } from "./blocks/scatter";
import { buildBaked } from "./blocks/baked";
import { buildShader } from "./blocks/shader";
import { buildParticles } from "./particles";
import type { ShotSpec } from "./shots";
import {
  parseAngleDeg,
  parseColorString,
  parseNumber,
  parseRotationRad,
  parseScale,
  parseVec3,
} from "./parse";

export type LookAtSpec =
  | { object: THREE.Object3D; offset: [number, number, number] }
  | { point: [number, number, number] }
  | null;

export interface CompiledScene {
  host: HTMLElement;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  /** Post-processing chain (bloom/vignette); null = render directly. */
  post: PostFX | null;
  /** Runs before the main render each frame (e.g. contact-shadow depth pass). */
  preRender: (() => void) | null;
  /** Shot window — single default scene: start 0, always visible. */
  shot: ShotSpec;
  /** `mode="forward"`: this scene opts OUT of seek-idempotency so it may carry
   *  cross-frame state (live sim/accumulation). Cost: no random-access seek —
   *  correct only under the monotonic render loop. Must be a solo, full-timeline
   *  scene (validate enforces). Forward seekFns receive `dt` (seconds since the
   *  last seek; 0 on the first frame or a non-forward step). */
  forward: boolean;
  forwardState: { lastT: number };
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mixers: THREE.AnimationMixer[];
  lookAt: LookAtSpec;
  objectsById: Map<string, THREE.Object3D>;
  /** Named animation-clip actions per sf-model group (for clip verbs). */
  actionsByObject: Map<THREE.Object3D, Map<string, THREE.AnimationAction>>;
  /** Per-seek state writers (animation verbs register here). Receive `(t, dt)`;
   *  analytic writers ignore `dt`, forward-scene writers may step by it. */
  seekFns: Array<(t: number, dt: number) => void>;
  /** Writers that must run after seekFns (camera follow tracks moved subjects). */
  lateSeekFns: Array<(t: number) => void>;
  /** DOM-overlay writers that run after camera lookAt — they read the final
   *  camera matrices to project 3D points to screen (e.g. sf-callout labels). */
  overlayFns: Array<(t: number) => void>;
  /** DOM-overlay roots (sf-callout layers). Shown/hidden with the scene's shot
   *  window so a hidden shot's labels don't linger over later shots. */
  overlayEls: HTMLElement[];
  /** uTime uniforms (particles, escape-hatch shaders) set to t before render. */
  timeUniforms: Array<{ value: number }>;
  ready: Promise<void>;
}

function compositionSize(host: HTMLElement): { width: number; height: number } {
  const root = host.closest<HTMLElement>("[data-composition-id]");
  const width = parseNumber(host.getAttribute("width") ?? root?.dataset.width ?? null, 1920);
  const height = parseNumber(host.getAttribute("height") ?? root?.dataset.height ?? null, 1080);
  return { width, height };
}

function applyTransform(
  obj: THREE.Object3D,
  el: Element,
  opts: { rotation?: boolean } = {},
): void {
  obj.position.set(...parseVec3(el.getAttribute("position"), [0, 0, 0]));
  // sf-model puts the base pose on the inner gltf.scene instead (so `fit`
  // measures + recenters the *posed* bounds), passing rotation:false here.
  if (opts.rotation !== false) obj.rotation.set(...parseRotationRad(el.getAttribute("rotation")));
  obj.scale.set(...parseScale(el.getAttribute("scale")));
}

function buildGeometry(el: Element): THREE.BufferGeometry {
  const kind = (el.getAttribute("geometry") ?? "box").toLowerCase();
  const args = (el.getAttribute("args") ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  const a = (i: number, fallback: number) =>
    Number.isFinite(args[i]) ? (args[i] as number) : fallback;
  switch (kind) {
    case "sphere":
      return new THREE.SphereGeometry(a(0, 1), 48, 24);
    case "plane":
      // args: width height [widthSegments] [heightSegments] — segments default to
      // 1 (unchanged), but matter for <sf-shader> vertex displacement on a sheet.
      return new THREE.PlaneGeometry(
        a(0, 1),
        a(1, 1),
        Math.max(1, Math.floor(a(2, 1))),
        Math.max(1, Math.floor(a(3, 1))),
      );
    case "cylinder":
      return new THREE.CylinderGeometry(a(0, 1), a(1, 1), a(2, 1), 48);
    case "torus":
      return new THREE.TorusGeometry(a(0, 1), a(1, 0.4), 24, 96);
    case "icosahedron":
      return new THREE.IcosahedronGeometry(a(0, 1), Math.max(0, Math.floor(a(1, 2))));
    case "rounded-box":
      // args: width height depth cornerRadius
      return new RoundedBoxGeometry(a(0, 1), a(1, 1), a(2, 1), 4, a(3, 0.08));
    case "box":
    default:
      return new THREE.BoxGeometry(a(0, 1), a(1, 1), a(2, 1));
  }
}

function buildMeshMaterial(el: Element): THREE.Material {
  const kind = (el.getAttribute("material") ?? "standard").toLowerCase();
  const color = new THREE.Color(parseColorString(el.getAttribute("color"), "#ffffff"));
  const metalness = parseNumber(el.getAttribute("metalness"), 0);
  const emissive = new THREE.Color(parseColorString(el.getAttribute("emissive"), "#000000"));
  const emissiveIntensity = parseNumber(el.getAttribute("emissive-intensity"), 1);
  const envMapIntensity = parseNumber(el.getAttribute("env-map-intensity"), 1);
  if (kind === "matcap") {
    // A baked material look that needs no lighting — instant distinctive
    // materials (pearl/chrome/iridescent/clay/holo). `color` tints it.
    return new THREE.MeshMatcapMaterial({
      matcap: getMatcap(el.getAttribute("matcap")),
      color: el.getAttribute("color") ? color : new THREE.Color("#ffffff"),
    });
  }
  if (kind === "glass" || kind === "physical") {
    // `glass` is a tuned MeshPhysicalMaterial preset; every knob can still be
    // overridden by an explicit attribute. Transmission re-renders the scene
    // behind the mesh each frame — pure per-frame state, seek-safe.
    const glass = kind === "glass";
    return new THREE.MeshPhysicalMaterial({
      color,
      metalness,
      roughness: parseNumber(el.getAttribute("roughness"), glass ? 0.08 : 0.5),
      transmission: parseNumber(el.getAttribute("transmission"), glass ? 1 : 0),
      thickness: parseNumber(el.getAttribute("thickness"), glass ? 0.4 : 0),
      ior: parseNumber(el.getAttribute("ior"), 1.5),
      clearcoat: parseNumber(el.getAttribute("clearcoat"), glass ? 1 : 0),
      clearcoatRoughness: parseNumber(el.getAttribute("clearcoat-roughness"), 0.1),
      dispersion: parseNumber(el.getAttribute("dispersion"), 0),
      emissive,
      emissiveIntensity,
      envMapIntensity,
    });
  }
  return new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness: parseNumber(el.getAttribute("roughness"), 0.5),
    emissive,
    emissiveIntensity,
    envMapIntensity,
  });
}

/**
 * Geometric specular anti-aliasing (filament/Toksvig). On a moving glossy/metal
 * surface, sharp specular highlights flicker as they cross pixels (sub-pixel
 * aliasing supersampling can't fully fix). This widens the specular lobe per
 * pixel by the amount the shading normal varies on screen (`dFdx`/`dFdy`), so
 * high-curvature/high-frequency areas read smoother instead of sparkling. It is
 * a pure function of geometry + camera at time `t` → stays seek-idempotent.
 * Also applies a small roughness floor (mirror-sharp metal is the worst sparkler).
 */
const SPEC_AA_INJECT = `#include <normal_fragment_maps>
  {
    vec3 sfNx = dFdx( normal );
    vec3 sfNy = dFdy( normal );
    float sfVar = 0.5 * ( dot( sfNx, sfNx ) + dot( sfNy, sfNy ) );
    roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor + min( sfVar, 0.6 ) ) );
  }`;

/** Max anisotropic filtering on every texture slot — the cheapest, biggest win
 *  against grazing-angle texture/normal-map shimmer on metal/glossy surfaces. */
function applyAnisotropy(mat: THREE.Material, maxAniso: number): void {
  const m = mat as THREE.MeshStandardMaterial;
  for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap] as Array<THREE.Texture | null | undefined>) {
    if (tex && tex.anisotropy !== maxAniso) {
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
    }
  }
}

function tuneMaterial(mat: THREE.Material, specularAA: boolean, maxAniso: number): void {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return; // Standard + Physical
  applyAnisotropy(mat, maxAniso);
  const transmission = (mat as THREE.MeshPhysicalMaterial).transmission ?? 0;
  if (transmission > 0) return; // don't frost glass / transmissive materials
  // Metals are the worst sparklers (near-mirror specular on fine curvature) → a
  // higher roughness floor softens their specular; matte stays crisp.
  mat.roughness = Math.max(mat.roughness, mat.metalness > 0.5 ? 0.15 : 0.06);
  if (!specularAA) return;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    if (
      shader.fragmentShader.includes("#include <normal_fragment_maps>") &&
      !shader.fragmentShader.includes("sfVar")
    ) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        SPEC_AA_INJECT,
      );
    }
  };
  mat.needsUpdate = true;
}

function buildMesh(el: Element, specularAA: boolean, maxAniso: number): THREE.Mesh {
  const mesh = new THREE.Mesh(buildGeometry(el), buildMeshMaterial(el));
  tuneMaterial(mesh.material as THREE.Material, specularAA, maxAniso);
  mesh.castShadow = true;
  mesh.receiveShadow = true; // a floor/backdrop plane receives the model's cast shadow
  applyTransform(mesh, el);
  return mesh;
}

function buildLights(el: Element, scene: THREE.Scene): void {
  const preset = (el.getAttribute("preset") ?? "").toLowerCase();
  if (preset === "studio") {
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 1.1);
    rim.position.set(-4, 2.5, -3);
    scene.add(rim);
    return;
  }
  if (preset === "soft") {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x33404f, 1.6));
    const fill = new THREE.DirectionalLight(0xffffff, 1.0);
    fill.position.set(2, 3, 4);
    scene.add(fill);
    return;
  }
  if (preset === "sunset") {
    scene.add(new THREE.HemisphereLight(0xffd9b3, 0x2a2238, 1.0));
    const key = new THREE.DirectionalLight(0xffb070, 2.4);
    key.position.set(-5, 1.5, 3);
    scene.add(key);
    return;
  }
  // Explicit single light
  const type = (el.getAttribute("type") ?? "directional").toLowerCase();
  const color = new THREE.Color(parseColorString(el.getAttribute("color"), "#ffffff"));
  const intensity = parseNumber(el.getAttribute("intensity"), 1);
  let light: THREE.Light;
  if (type === "ambient") light = new THREE.AmbientLight(color, intensity);
  else if (type === "hemisphere") light = new THREE.HemisphereLight(color, 0x222233, intensity);
  else if (type === "point") light = new THREE.PointLight(color, intensity);
  else light = new THREE.DirectionalLight(color, intensity);
  if ("position" in light && el.getAttribute("position")) {
    light.position.set(...parseVec3(el.getAttribute("position"), [0, 1, 0]));
  }
  scene.add(light);
}

/** Enable PCF-soft shadow maps from the scene's brightest directional light. Only
 *  one caster (multiple overlapping shadow maps look muddy + cost more). The ortho
 *  frustum frames the normalized subject (models are `fit` to ~2.6 around origin).
 *  Deterministic: the shadow depth is a pure function of geometry at time `t`. */
function setupShadows(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  let key: THREE.DirectionalLight | null = null;
  scene.traverse((o) => {
    if (o instanceof THREE.DirectionalLight && (!key || o.intensity > key.intensity)) key = o;
  });
  if (!key) return;
  const light = key as THREE.DirectionalLight;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const cam = light.shadow.camera;
  cam.left = -6;
  cam.right = 6;
  cam.top = 6;
  cam.bottom = -6;
  cam.near = 0.1;
  cam.far = 60;
  cam.updateProjectionMatrix();
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.02;
}

/** Shot duration in seconds: own `duration` attr, else inherited, else 5. */
export function sceneDuration(host: HTMLElement): number {
  const own = parseNumber(host.getAttribute("duration"), 0);
  if (own > 0) return own;
  const root = host.closest<HTMLElement>("[data-composition-id]");
  const inherited = parseNumber(root?.dataset.duration ?? null, 0);
  return inherited > 0 ? inherited : 5;
}

export function compileScene(host: HTMLElement): CompiledScene {
  const { width, height } = compositionSize(host);

  const shot: ShotSpec = {
    start: parseNumber(host.getAttribute("start"), 0),
    duration: sceneDuration(host),
    transition:
      (host.getAttribute("transition") ?? "cut").toLowerCase() === "crossfade"
        ? "crossfade"
        : "cut",
    transitionDuration: parseNumber(host.getAttribute("transition-duration"), 0.6),
  };

  const forward =
    (host.getAttribute("mode") ?? "").toLowerCase() === "forward" || host.hasAttribute("forward-only");

  // Supersampling AA: render the canvas at samples× and let the capture
  // downsample. Deterministic (unlike driver MSAA), and the single biggest
  // step up in visual quality. samples=2 → 4× pixels.
  const samples = Math.max(1, Math.min(6, Math.round(parseNumber(host.getAttribute("samples"), 2))));
  const bufW = width * samples;
  const bufH = height * samples;
  // Hardware MSAA on top of supersampling — coverage AA for thin geometry edges
  // (wheel spokes, splitter mesh). Kept moderate (×4) so it doesn't OOM on the
  // already-supersampled buffer. `msaa="0"` disables.
  const msaa = Math.max(0, Math.min(8, Math.round(parseNumber(host.getAttribute("msaa"), 4))));
  // Geometric specular AA on lit materials (on by default; `specular-aa="none"` opts out).
  const specularAA = (host.getAttribute("specular-aa") ?? "") !== "none";
  // Real soft shadow maps from the key light (on by default; `shadows="none"` opts out).
  const shadows = (host.getAttribute("shadows") ?? "") !== "none";

  const canvas = document.createElement("canvas");
  canvas.width = bufW;
  canvas.height = bufH;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  host.prepend(canvas);

  const backgroundAttr = host.getAttribute("background") ?? "";
  const transparent = backgroundAttr === "transparent" || backgroundAttr === "";

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // context MSAA is driver-dependent; supersampling instead
    alpha: true,
  });
  renderer.setSize(bufW, bufH, false);
  renderer.setPixelRatio(1);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const toneMapping = (host.getAttribute("tone-mapping") ?? "aces").toLowerCase();
  renderer.toneMapping = toneMapping === "none" ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = parseNumber(host.getAttribute("exposure"), 1);

  const scene = new THREE.Scene();
  if (!transparent && backgroundAttr !== "environment") {
    scene.background = new THREE.Color(parseColorString(backgroundAttr, "#000000"));
  }

  const camera = new THREE.PerspectiveCamera(
    parseAngleDeg(null, 35),
    width / height,
    0.05,
    200,
  );
  camera.position.set(0, 1, 5);

  const mixers: THREE.AnimationMixer[] = [];
  const objectsById = new Map<string, THREE.Object3D>();
  const actionsByObject = new Map<THREE.Object3D, Map<string, THREE.AnimationAction>>();
  const timeUniforms: Array<{ value: number }> = [];
  const pending: Promise<unknown>[] = [];
  let lookAt: LookAtSpec = null;
  let lookAtSelector: string | null = null;
  let lookAtOffset: [number, number, number] = [0, 0, 0];
  let skySunDirection: THREE.Vector3 | null = null;
  const oceans: OceanBuild[] = [];
  // Blocks with built-in choreography (sf-swarm) push writers here at
  // compile time; compileAnimations appends verb writers later.
  const seekFns: Array<(t: number) => void> = [];

  // Compressed-GLB support so any real downloaded/generated model loads:
  // Meshopt is bundled (self-contained); Draco + KTX2 decoders are fetched
  // once from a pinned CDN during preload (before the ready gate, so
  // seekability is preserved). This covers the vast majority of GLBs.
  const gltfLoader = new GLTFLoader();
  const DECODER_BASE = "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs";
  gltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${DECODER_BASE}/draco/gltf/`));
  gltfLoader.setKTX2Loader(
    new KTX2Loader().setTranscoderPath(`${DECODER_BASE}/basis/`).detectSupport(renderer),
  );
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  const hdrLoader = new HDRLoader();

  // Environment map — drives PBR reflections on metal/glass (the difference
  // between "plastic" and "chrome"). `room`/`studio` build a procedural
  // studio environment with NO asset; anything else is treated as an HDR path.
  const envSrc = host.getAttribute("environment");
  // Pre-blur the procedural environment. The synthetic RoomEnvironment is a box of
  // hard-edged emissive panels; at near-zero sigma those edges reflect as sharp bands
  // that *sparkle* on metal as the surface/light-sweep rotates. A moderate blur softens
  // the reflection (less banding/flicker) while keeping a sense of environment.
  const envBlur = parseNumber(host.getAttribute("env-blur"), 0.2);
  if (envSrc === "room" || envSrc === "studio") {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), envBlur).texture;
    pmrem.dispose();
  } else if (envSrc) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pending.push(
      hdrLoader.loadAsync(envSrc).then((hdr) => {
        const envMap = pmrem.fromEquirectangular(hdr).texture;
        scene.environment = envMap;
        if (backgroundAttr === "environment") scene.background = envMap;
        hdr.dispose();
        pmrem.dispose();
      }),
    );
  }

  for (const el of Array.from(host.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "sf-camera") {
      camera.fov = parseAngleDeg(el.getAttribute("fov"), 35);
      camera.far = parseNumber(el.getAttribute("far"), 200);
      camera.position.set(...parseVec3(el.getAttribute("position"), [0, 1, 5]));
      camera.updateProjectionMatrix();
      const la = el.getAttribute("look-at");
      lookAtOffset = parseVec3(el.getAttribute("look-at-offset"), [0, 0, 0]);
      if (la && la.startsWith("#")) lookAtSelector = la.slice(1);
      else if (la) lookAt = { point: parseVec3(la, [0, 0, 0]) };
    } else if (tag === "sf-mesh") {
      const mesh = buildMesh(el, specularAA, maxAniso);
      scene.add(mesh);
      if (el.id) objectsById.set(el.id, mesh);
    } else if (tag === "sf-model") {
      const group = new THREE.Group();
      // Position/scale on the group (the handle verbs animate); the base pose
      // rotation goes on the inner gltf.scene below, before `fit` measures it.
      applyTransform(group, el, { rotation: false });
      scene.add(group);
      if (el.id) objectsById.set(el.id, group);
      const src = el.getAttribute("src");
      const clipAttr = el.getAttribute("clip");
      // Auto-framing: normalize any model to a known size + center so a
      // fixed camera/lighting preset frames it perfectly. `fit` = target
      // longest-dimension (world units); `fit-ground` rests it on y=0.
      const fit = parseNumber(el.getAttribute("fit"), 0);
      const fitGround = el.getAttribute("fit-ground") !== null;
      if (src) {
        pending.push(
          gltfLoader.loadAsync(src).then((gltf) => {
            group.add(gltf.scene);
            // Calm imported materials: roughness floor + geometric specular AA, so
            // glossy/metal GLBs stop sparkling as they move (see tuneMaterial).
            gltf.scene.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (!mesh.isMesh || !mesh.material) return;
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              for (const mat of mats) tuneMaterial(mat, specularAA, maxAniso);
            });
            // Base pose on the model itself, applied BEFORE `fit` so the box is
            // measured on the posed geometry and recenters in the group's
            // (rotation-free) frame — keeps fit/fit-ground correct under any pose.
            gltf.scene.rotation.set(...parseRotationRad(el.getAttribute("rotation")));
            if (fit > 0) {
              const box = new THREE.Box3().setFromObject(gltf.scene);
              const size = box.getSize(new THREE.Vector3());
              const center = box.getCenter(new THREE.Vector3());
              const maxDim = Math.max(size.x, size.y, size.z) || 1;
              const s = fit / maxDim;
              gltf.scene.scale.multiplyScalar(s);
              gltf.scene.position.sub(center.multiplyScalar(s));
              if (fitGround) gltf.scene.position.y += (size.y * s) / 2;
            }
            if (gltf.animations.length > 0) {
              const mixer = new THREE.AnimationMixer(gltf.scene);
              const actions = new Map<string, THREE.AnimationAction>();
              // Every action stays play()'d with an explicit weight so
              // mixer.setTime(t) seeks idempotently; clip selection and
              // crossfades only ever touch weights.
              const initial = clipAttr ?? gltf.animations[0]!.name;
              for (const clip of gltf.animations) {
                const action = mixer.clipAction(clip);
                action.setEffectiveTimeScale(1);
                action.setEffectiveWeight(clip.name === initial ? 1 : 0);
                action.play();
                actions.set(clip.name, action);
              }
              actionsByObject.set(group, actions);
              mixers.push(mixer);
            }
          }),
        );
      }
    } else if (tag === "sf-light") {
      buildLights(el, scene);
    } else if (tag === "sf-particles") {
      const { points, timeUniform } = buildParticles(el);
      scene.add(points);
      if (el.id) objectsById.set(el.id, points);
      timeUniforms.push(timeUniform);
    } else if (tag === "sf-sky") {
      const { sky, sunDirection } = buildSky(el);
      scene.add(sky);
      if (el.id) objectsById.set(el.id, sky);
      skySunDirection = sunDirection;
    } else if (tag === "sf-ocean") {
      const ocean = buildOcean(el);
      scene.add(ocean.water);
      if (el.id) objectsById.set(el.id, ocean.water);
      timeUniforms.push(ocean.timeProxy);
      pending.push(ocean.pending);
      oceans.push(ocean);
    } else if (tag === "sf-swarm") {
      const swarm = buildSwarm(el);
      scene.add(swarm.mesh);
      if (el.id) objectsById.set(el.id, swarm.mesh);
      seekFns.push(swarm.writer);
    } else if (tag === "sf-metaball") {
      const metaball = buildMetaball(el, buildMeshMaterial(el));
      scene.add(metaball.mesh);
      if (el.id) objectsById.set(el.id, metaball.mesh);
      seekFns.push(metaball.writer);
    } else if (tag === "sf-scatter") {
      const scatter = buildScatter(el, buildGeometry(el), buildMeshMaterial(el));
      scene.add(scatter.mesh);
      if (el.id) objectsById.set(el.id, scatter.mesh);
      seekFns.push(scatter.writer);
    } else if (tag === "sf-baked") {
      const baked = buildBaked(el, buildGeometry(el), buildMeshMaterial(el));
      scene.add(baked.group);
      if (el.id) objectsById.set(el.id, baked.group);
      pending.push(baked.pending);
      seekFns.push(baked.writer);
    } else if (tag === "sf-shader") {
      const fullscreen = el.hasAttribute("fullscreen");
      const geometry = fullscreen ? new THREE.PlaneGeometry(2, 2) : buildGeometry(el);
      const { mesh, timeUniform } = buildShader(el, { width, height, geometry, fullscreen });
      if (!fullscreen) applyTransform(mesh, el);
      scene.add(mesh);
      if (el.id) objectsById.set(el.id, mesh);
      timeUniforms.push(timeUniform);
    }
  }

  // An <sf-sky> sun drives <sf-ocean> specular highlights automatically.
  if (skySunDirection) {
    for (const ocean of oceans) ocean.setSunDirection(skySunDirection);
  }

  // Real soft cast shadows from the brightest directional — a grounded directional
  // shadow (vs the top-down contact-shadow blob). Pure per t → seek-safe.
  if (shadows) setupShadows(scene, renderer);

  // Contact shadow — grounds the subject. `ground="contact-shadow"` (the
  // shadow sits at `ground-y`, default 0; pair with sf-model fit-ground).
  let preRender: (() => void) | null = null;
  const groundMode = (host.getAttribute("ground") ?? "").toLowerCase();
  if (groundMode === "contact-shadow" || groundMode === "shadow") {
    const cs = buildContactShadow(renderer, scene, {
      y: parseNumber(host.getAttribute("ground-y"), 0),
      size: parseNumber(host.getAttribute("ground-size"), 6),
      opacity: parseNumber(host.getAttribute("ground-opacity"), 0.75),
      blur: parseNumber(host.getAttribute("ground-blur"), 3),
      darkness: parseNumber(host.getAttribute("ground-darkness"), 1.4),
    });
    scene.add(cs.group);
    preRender = cs.update;
  }

  // Light sweep — rotate the environment so a specular streak travels across
  // metal/glass (the signature "premium product" move). `light-sweep` =
  // revolutions per second (e.g. 0.15). Pure function of t.
  const sweepSpeed = parseNumber(host.getAttribute("light-sweep"), 0);
  if (sweepSpeed !== 0) {
    seekFns.push((t) => {
      scene.environmentRotation.y = t * sweepSpeed * Math.PI * 2;
    });
  }

  const ready = Promise.all(pending).then(async () => {
    if (lookAtSelector) {
      const target = objectsById.get(lookAtSelector);
      if (target) lookAt = { object: target, offset: lookAtOffset };
    }
    // Pre-compile shaders and upload textures so frame 0 is never blank.
    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      renderer.compile(scene, camera);
    }
  });

  const post = buildPostFX(renderer, scene, camera, {
    width: bufW,
    height: bufH,
    bloom: parseNumber(host.getAttribute("bloom"), 0),
    bloomThreshold: parseNumber(host.getAttribute("bloom-threshold"), 0.85),
    bloomRadius: parseNumber(host.getAttribute("bloom-radius"), 0.6),
    vignette: parseNumber(host.getAttribute("vignette"), 0),
    contrast: parseNumber(host.getAttribute("contrast"), 1),
    saturation: parseNumber(host.getAttribute("saturation"), 1),
    chromaticAberration: parseNumber(host.getAttribute("chromatic-aberration"), 0),
    grain: parseNumber(host.getAttribute("grain"), 0),
    msaa,
  });

  return {
    host,
    width,
    height,
    canvas,
    post,
    preRender,
    shot,
    forward,
    forwardState: { lastT: -1 },
    renderer,
    scene,
    camera,
    mixers,
    get lookAt() {
      return lookAt;
    },
    objectsById,
    actionsByObject,
    seekFns,
    lateSeekFns: [],
    overlayFns: [],
    overlayEls: [],
    timeUniforms,
    ready,
  };
}
