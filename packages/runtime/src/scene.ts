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
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mixers: THREE.AnimationMixer[];
  lookAt: LookAtSpec;
  objectsById: Map<string, THREE.Object3D>;
  /** Named animation-clip actions per sf-model group (for clip verbs). */
  actionsByObject: Map<THREE.Object3D, Map<string, THREE.AnimationAction>>;
  /** Per-seek state writers (animation verbs register here). */
  seekFns: Array<(t: number) => void>;
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

function applyTransform(obj: THREE.Object3D, el: Element): void {
  obj.position.set(...parseVec3(el.getAttribute("position"), [0, 0, 0]));
  obj.rotation.set(...parseRotationRad(el.getAttribute("rotation")));
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
      return new THREE.PlaneGeometry(a(0, 1), a(1, 1));
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

function buildMesh(el: Element): THREE.Mesh {
  const mesh = new THREE.Mesh(buildGeometry(el), buildMeshMaterial(el));
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

  // Supersampling AA: render the canvas at samples× and let the capture
  // downsample. Deterministic (unlike driver MSAA), and the single biggest
  // step up in visual quality. samples=2 → 4× pixels.
  const samples = Math.max(1, Math.min(4, Math.round(parseNumber(host.getAttribute("samples"), 2))));
  const bufW = width * samples;
  const bufH = height * samples;

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
  if (envSrc === "room" || envSrc === "studio") {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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
      const mesh = buildMesh(el);
      scene.add(mesh);
      if (el.id) objectsById.set(el.id, mesh);
    } else if (tag === "sf-model") {
      const group = new THREE.Group();
      applyTransform(group, el);
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
  });

  return {
    host,
    width,
    height,
    canvas,
    post,
    preRender,
    shot,
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
