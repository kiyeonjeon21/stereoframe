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
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { buildMetaball } from "./blocks/metaball";
import { buildOcean, type OceanBuild } from "./blocks/ocean";
import { buildSky } from "./blocks/sky";
import { buildSwarm } from "./blocks/swarm";
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

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  host.prepend(canvas);

  const backgroundAttr = host.getAttribute("background") ?? "";
  const transparent = backgroundAttr === "transparent" || backgroundAttr === "";

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // context MSAA is driver-dependent; determinism first
    alpha: true,
  });
  renderer.setSize(width, height, false);
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

  const gltfLoader = new GLTFLoader();
  const hdrLoader = new HDRLoader();

  // Environment map (also drives PBR reflections on sf-model materials)
  const envSrc = host.getAttribute("environment");
  if (envSrc) {
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
      if (src) {
        pending.push(
          gltfLoader.loadAsync(src).then((gltf) => {
            group.add(gltf.scene);
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
    }
  }

  // An <sf-sky> sun drives <sf-ocean> specular highlights automatically.
  if (skySunDirection) {
    for (const ocean of oceans) ocean.setSunDirection(skySunDirection);
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

  return {
    host,
    width,
    height,
    canvas,
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
    timeUniforms,
    ready,
  };
}
