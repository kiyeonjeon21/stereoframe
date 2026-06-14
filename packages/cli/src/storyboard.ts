/**
 * `stereoframe storyboard <plan.json>` — compile a shot plan into a multi-shot
 * film. This productizes the directing layer: an agent (or person) writes a JSON
 * storyboard (beats: camera / lighting / grade / duration per shot) and gets a
 * multi-shot `<sf-scene>` index.html — the shape of the hand-authored
 * killer-demos/camera/v4-cinematic spot, generated.
 *
 * `compileStoryboard` is PURE (a fully-resolved plan → HTML string), so it's
 * unit-tested without a browser. `buildStoryboard` is the impure scaffolder:
 * it resolves `lighting:"auto"` / `callout:"auto"` via `inspect`, copies models +
 * runtime, and writes the project (mirrors stage.ts `stageModel`).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { EASE_NAMES } from "stereoframe-runtime/vocab";
import { resolveRuntimeBundle } from "./scaffold";
import {
  buildAutoCallouts,
  calloutMarkup,
  explodeTiming,
  head,
  METAL_RIG,
  tail,
  type CalloutSpec,
} from "./stage";
import { inspectModel } from "./inspect";

// ── schema ──────────────────────────────────────────────────────────────────
export interface Finish {
  exposure?: number;
  samples?: number;
  bloom?: number;
  bloomThreshold?: number;
  vignette?: number;
  contrast?: number;
  saturation?: number;
  grain?: number;
  chromaticAberration?: number;
  lightSweep?: number;
  ground?: "contact-shadow" | "none";
}
export interface LightSpec {
  color?: string;
  intensity?: number;
  position?: string;
  type?: string;
}
export type Lighting =
  | { preset: string }
  | "auto"
  | { key?: LightSpec; fill?: LightSpec; rim?: LightSpec };
export interface Camera {
  type: "static" | "orbit" | "dolly" | "push-in" | "pull-back" | "path" | "hero" | "flythrough";
  fov?: number;
  position?: string;
  lookAt?: string;
  around?: string;
  radius?: number;
  from?: number;
  to?: number;
  height?: number;
  toward?: string;
  distance?: number;
  points?: string;
  ease?: string;
}
export interface CalloutInput {
  part: string | number;
  value?: string;
  text?: string;
  anchor?: "left" | "right";
  start?: number;
}
export interface ShotDefaults {
  bg?: string;
  environment?: string;
  fit?: number;
  fitGround?: boolean;
  /** Base-pose rotation "x y z" in degrees → sf-model `rotation`. Re-orient a
   *  model whatever orientation it was generated in (e.g. a phone that came out
   *  lying flat → "90 0 90" to stand it up). */
  pose?: string;
  /** Animated nebula backdrop (vs flat black) → a tinted `<sf-shader fullscreen>`.
   *  `"none"` opts out. Omit for the default subtle dark backdrop. */
  backdrop?: { coldGlow?: string; warmGlow?: string } | "none";
  /** Drifting atmosphere → `<sf-particles>`. Dropped (with a warning) on a shot
   *  that is the outgoing half of a crossfade — particles break seek-idempotency
   *  there. Safe on cut-followed or final shots. */
  atmosphere?: "dust" | "snow" | "none";
  /** Secondary motion layered on the model *while* the camera moves (the biggest
   *  "alive vs dead" lever): turntable rpm + sway degrees + float amplitude. */
  secondaryMotion?: { spin?: number; sway?: number; float?: number };
  /** A real ground plane under the subject (so it doesn't float on the backdrop).
   *  `"road"` = dark semi-reflective asphalt, `"studio"` = glossy infinity-cove,
   *  `"none"` = no plane, or a custom `{color,metalness,roughness,size}`. Pairs
   *  with `finish.ground:"contact-shadow"`. */
  floor?: "road" | "studio" | "none" | { color?: string; metalness?: number; roughness?: number; size?: number };
  finish?: Finish;
  lighting?: Lighting;
}
export interface Shot extends ShotDefaults {
  name?: string;
  model?: string;
  duration: number;
  transition?: "cut" | "crossfade";
  transitionDuration?: number;
  camera: Camera;
  spin?: number;
  isolate?: { part: string | number; dim?: number };
  explode?: { distance?: number };
  callout?: "auto" | "none" | CalloutInput[];
  text?: { title?: string; subtitle?: string; spec?: string };
}
export interface Storyboard {
  title?: string;
  model?: string;
  width?: number;
  height?: number;
  fps?: number;
  defaults?: ShotDefaults;
  shots: Shot[];
}

const CAMERA_TYPES = ["static", "orbit", "dolly", "push-in", "pull-back", "path", "hero", "flythrough"];

// ── timeline (pure) ─────────────────────────────────────────────────────────
export interface ShotWindow {
  start: number;
  duration: number;
  transition: "cut" | "crossfade";
  transitionDuration: number;
  end: number;
}

export function computeTimeline(shots: Shot[]): ShotWindow[] {
  const out: ShotWindow[] = [];
  let prevStart = 0;
  let prevDur = 0;
  shots.forEach((s, i) => {
    const transition = (i === 0 ? "cut" : (s.transition ?? "crossfade")) as "cut" | "crossfade";
    const td = s.transitionDuration ?? 0.4;
    const overlap = transition === "crossfade" ? td : 0;
    const start = i === 0 ? 0 : prevStart + prevDur - overlap;
    out.push({ start, duration: s.duration, transition, transitionDuration: td, end: start + s.duration });
    prevStart = start;
    prevDur = s.duration;
  });
  return out;
}

// ── validation (pure) ───────────────────────────────────────────────────────
export function validateStoryboard(plan: Storyboard): string[] {
  const errs: string[] = [];
  if (!plan || typeof plan !== "object") return ["storyboard must be a JSON object"];
  if (!Array.isArray(plan.shots) || plan.shots.length === 0) {
    return ["storyboard.shots must be a non-empty array"];
  }
  for (const dim of ["width", "height", "fps"] as const) {
    if (plan[dim] !== undefined && !(typeof plan[dim] === "number" && plan[dim]! > 0)) {
      errs.push(`storyboard.${dim} must be a positive number`);
    }
  }
  const badPose = (p: string | undefined): boolean => {
    if (p === undefined) return false;
    const n = p.trim().split(/\s+/).map(Number);
    return n.length !== 3 || n.some((x) => !Number.isFinite(x));
  };
  const badVec3 = (v: string | undefined): boolean => badPose(v); // same shape: 3 finite numbers
  if (badPose(plan.defaults?.pose)) {
    errs.push(`storyboard.defaults.pose must be "x y z" (3 numbers, degrees)`);
  }
  const eases = new Set<string>(EASE_NAMES);
  plan.shots.forEach((s, i) => {
    const tag = `shot ${i + 1}${s.name ? ` "${s.name}"` : ""}`;
    if (!(typeof s.duration === "number" && s.duration > 0)) errs.push(`${tag}: duration must be > 0`);
    if (!s.model && !plan.model) errs.push(`${tag}: no model (set storyboard.model or shot.model)`);
    if (badPose(s.pose)) errs.push(`${tag}: pose must be "x y z" (3 numbers, degrees)`);
    if (s.transition && s.transition !== "cut" && s.transition !== "crossfade") {
      errs.push(`${tag}: transition must be "cut" or "crossfade"`);
    }
    const td = s.transitionDuration;
    if (td !== undefined && !(typeof td === "number" && td > 0)) {
      errs.push(`${tag}: transitionDuration must be > 0`);
    }
    if (i > 0 && td !== undefined && (td > s.duration || td > plan.shots[i - 1]!.duration)) {
      errs.push(`${tag}: transitionDuration (${td}s) longer than this or the previous shot`);
    }
    const cam = s.camera;
    if (!cam || !CAMERA_TYPES.includes(cam.type)) {
      errs.push(`${tag}: camera.type must be one of ${CAMERA_TYPES.join("/")}`);
    } else {
      if (cam.type === "orbit" && (cam.radius == null || cam.from == null || cam.to == null)) {
        errs.push(`${tag}: orbit camera needs radius, from, to`);
      }
      if ((cam.type === "dolly" || cam.type === "push-in" || cam.type === "pull-back") && cam.distance == null) {
        errs.push(`${tag}: ${cam.type} camera needs distance`);
      }
      if ((cam.type === "path" || cam.type === "flythrough") && !cam.points) {
        errs.push(`${tag}: ${cam.type} camera needs points`);
      }
      if (cam.type === "static" && !cam.position) errs.push(`${tag}: static camera needs position`);
      if (cam.ease && !eases.has(cam.ease)) errs.push(`${tag}: unknown ease "${cam.ease}"`);
      // Catch malformed vectors (e.g. an LLM writing "0 0 z") and camera paths that
      // run through the subject (the #1 wrecker — chaotic grazing/flicker).
      if (badVec3(cam.position)) errs.push(`${tag}: camera.position must be "x y z" numbers`);
      if (badVec3(cam.lookAt)) errs.push(`${tag}: camera.lookAt must be "x y z" numbers`);
      if (cam.points) {
        for (const p of cam.points.split(",").map((s) => s.trim()).filter(Boolean)) {
          const n = p.split(/\s+/).map(Number);
          if (n.length !== 3 || !n.every((x) => Number.isFinite(x))) {
            errs.push(`${tag}: camera.points has a bad waypoint "${p}" (need "x y z")`);
          } else if (Math.hypot(n[0]!, n[1]!, n[2]!) < 1.8) {
            errs.push(`${tag}: camera waypoint "${p}" is inside the subject — a flythrough/path must arc AROUND it (keep every waypoint ≥ ~4 from origin)`);
          }
        }
      }
    }
    if (s.atmosphere && !["dust", "snow", "none"].includes(s.atmosphere)) {
      errs.push(`${tag}: atmosphere must be "dust", "snow", or "none"`);
    }
    if (typeof s.floor === "string" && !["road", "studio", "none"].includes(s.floor)) {
      errs.push(`${tag}: floor must be "road", "studio", "none", or an object`);
    }
  });
  if (plan.defaults?.atmosphere && !["dust", "snow", "none"].includes(plan.defaults.atmosphere)) {
    errs.push(`storyboard.defaults.atmosphere must be "dust", "snow", or "none"`);
  }
  return errs;
}

export type StoryboardWarningCode =
  | "too_few_shots"
  | "low_motion_energy"
  | "low_camera_variety"
  | "missing_secondary_motion"
  | "floating_subject_risk"
  | "metal_flicker_risk";

export interface StoryboardWarning {
  code: StoryboardWarningCode;
  message: string;
  shot?: number;
}

export interface ShotMotionScore {
  shot: number;
  name?: string;
  cameraType: Camera["type"] | "unknown";
  energy: number;
}

export interface MotionAnalysis {
  totalDuration: number;
  shotCount: number;
  cameraTypes: Camera["type"][];
  cameraVariety: number;
  averageMotionEnergy: number;
  shotScores: ShotMotionScore[];
  warnings: StoryboardWarning[];
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const cleanEnergy = (n: number): number => Math.round(n * 100) / 100;

function hasSecondaryMotion(shot: Shot, defaults?: ShotDefaults): boolean {
  const secondary = shot.secondaryMotion ?? defaults?.secondaryMotion;
  return !!(
    shot.spin ||
    secondary?.spin ||
    secondary?.sway ||
    secondary?.float
  );
}

function effectiveFinish(shot: Shot, defaults?: ShotDefaults): Finish {
  return { ...(defaults?.finish ?? {}), ...(shot.finish ?? {}) };
}

function cameraSweep(cam: Camera): number {
  if (cam.type === "orbit" || cam.type === "hero") return Math.abs((cam.to ?? 0) - (cam.from ?? 0));
  return 0;
}

function waypointCount(points: string | undefined): number {
  return points ? points.split(",").map((p) => p.trim()).filter(Boolean).length : 0;
}

function cameraEnergy(cam: Camera): number {
  switch (cam.type) {
    case "static":
      return 0;
    case "orbit":
    case "hero":
      return clamp(cameraSweep(cam) / 45, 0.2, 2.1);
    case "dolly":
    case "push-in":
    case "pull-back":
      return clamp(Math.abs(cam.distance ?? 0.6) / 0.45, 0.45, 1.7);
    case "path":
      return 1.55 + clamp((waypointCount(cam.points) - 2) * 0.12, 0, 0.35);
    case "flythrough":
      return 1.75 + clamp((waypointCount(cam.points) - 2) * 0.12, 0, 0.35);
  }
}

function shotMotionEnergy(shot: Shot, defaults?: ShotDefaults): number {
  const secondary = shot.secondaryMotion ?? defaults?.secondaryMotion;
  const finish = effectiveFinish(shot, defaults);
  const spin = secondary?.spin ?? shot.spin ?? 0;
  const energy =
    cameraEnergy(shot.camera) +
    clamp(Math.abs(spin) / 2, 0, 1.4) * 0.55 +
    clamp(Math.abs(secondary?.sway ?? 0) / 2, 0, 0.6) +
    clamp(Math.abs(secondary?.float ?? 0) / 0.12, 0, 0.5) +
    clamp(Math.abs(finish.lightSweep ?? 0) / 0.12, 0, 0.4) +
    (shot.explode ? 0.65 : 0) +
    (shot.isolate ? 0.25 : 0);
  return cleanEnergy(energy);
}

function hasBackdrop(shot: Shot, defaults?: ShotDefaults): boolean {
  const backdrop = shot.backdrop ?? defaults?.backdrop;
  return backdrop !== undefined && backdrop !== "none";
}

function hasFloorAndContact(shot: Shot, defaults?: ShotDefaults): boolean {
  const floor = shot.floor ?? defaults?.floor;
  const finish = effectiveFinish(shot, defaults);
  return floor !== undefined && floor !== "none" && finish.ground !== undefined && finish.ground !== "none";
}

export function analyzeStoryboardMotion(plan: Storyboard, opts: { metal?: boolean } = {}): MotionAnalysis {
  const shots = Array.isArray(plan?.shots) ? plan.shots : [];
  const windows = computeTimeline(shots);
  const totalDuration = windows.reduce((m, w) => Math.max(m, w.end), 0);
  const shotScores = shots.map((shot, i): ShotMotionScore => ({
    shot: i + 1,
    ...(shot.name ? { name: shot.name } : {}),
    cameraType: shot.camera?.type ?? "unknown",
    energy: shot.camera ? shotMotionEnergy(shot, plan.defaults) : 0,
  }));
  const cameraTypes = shots.map((s) => s.camera?.type).filter(Boolean) as Camera["type"][];
  const cameraVariety = new Set(cameraTypes).size;
  const averageMotionEnergy =
    shotScores.length > 0
      ? cleanEnergy(shotScores.reduce((sum, s) => sum + s.energy, 0) / shotScores.length)
      : 0;

  const warnings: StoryboardWarning[] = [];
  if (shots.length > 0 && shots.length < 6) {
    warnings.push({
      code: "too_few_shots",
      message: `cinematic briefs should usually use 6-9 shots; this plan has ${shots.length}.`,
    });
  }
  if (shots.length >= 3 && cameraVariety < 3) {
    warnings.push({
      code: "low_camera_variety",
      message: `camera variety is low (${[...new Set(cameraTypes)].join(", ") || "none"}); mix orbit/dolly/path/flythrough/hero beats.`,
    });
  }
  if (shots.length >= 2 && averageMotionEnergy < 0.85) {
    warnings.push({
      code: "low_motion_energy",
      message: `average motion energy is ${averageMotionEnergy}; add camera moves, secondaryMotion, or a reveal beat.`,
    });
  }
  for (const score of shotScores) {
    const shot = shots[score.shot - 1]!;
    if (shot.duration >= 1.8 && score.energy < 0.45) {
      warnings.push({
        code: "low_motion_energy",
        shot: score.shot,
        message: `shot ${score.shot}${shot.name ? ` "${shot.name}"` : ""} has very low motion energy (${score.energy}).`,
      });
    }
  }

  const movingShots = shots.filter((s) => hasSecondaryMotion(s, plan.defaults)).length;
  if (shots.length >= 3 && movingShots / shots.length < 0.5) {
    warnings.push({
      code: "missing_secondary_motion",
      message: `only ${movingShots}/${shots.length} shots include secondaryMotion/spin; add subtle spin/sway/float so the subject stays alive.`,
    });
  }

  shots.forEach((shot, i) => {
    if (hasBackdrop(shot, plan.defaults) && !hasFloorAndContact(shot, plan.defaults)) {
      warnings.push({
        code: "floating_subject_risk",
        shot: i + 1,
        message: `shot ${i + 1}${shot.name ? ` "${shot.name}"` : ""} uses a backdrop without both floor and finish.ground contact shadow.`,
      });
    }
    if (opts.metal && shot.camera) {
      const secondary = shot.secondaryMotion ?? plan.defaults?.secondaryMotion;
      const spin = Math.abs(secondary?.spin ?? shot.spin ?? 0);
      const sweep = cameraSweep(shot.camera);
      const lightSweep = Math.abs(effectiveFinish(shot, plan.defaults).lightSweep ?? 0);
      if ((spin > 2.2 && sweep > 70) || (spin > 1.7 && lightSweep > 0.12) || (sweep > 90 && lightSweep > 0.12)) {
        warnings.push({
          code: "metal_flicker_risk",
          shot: i + 1,
          message: `shot ${i + 1}${shot.name ? ` "${shot.name}"` : ""} stacks fast metal motion/reflection changes; reduce spin, orbit sweep, or lightSweep.`,
        });
      }
    }
  });

  return {
    totalDuration: cleanEnergy(totalDuration),
    shotCount: shots.length,
    cameraTypes,
    cameraVariety,
    averageMotionEnergy,
    shotScores,
    warnings,
  };
}

export function critiqueStoryboard(plan: Storyboard, opts: { metal?: boolean } = {}): StoryboardWarning[] {
  return analyzeStoryboardMotion(plan, opts).warnings;
}

// ── compile (pure) ──────────────────────────────────────────────────────────
/** Per-shot data the compiler needs that can't be derived purely (resolved by
 *  buildStoryboard from `inspect`). Defaults make the compiler usable in tests. */
export interface ResolvedShot {
  modelBasename: string;
  metalRig: boolean;
  callouts?: CalloutSpec[];
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const mergeFinish = (d?: Finish, s?: Finish): Finish => ({ ...(d ?? {}), ...(s ?? {}) });
const mergeLighting = (d?: Lighting, s?: Lighting): Lighting | undefined => s ?? d;

function finishAttrs(f: Finish, metalRig: boolean): string {
  const exposure = metalRig ? Math.max(0.6, (f.exposure ?? 1) - 0.12) : f.exposure;
  const a: string[] = [];
  if (exposure !== undefined) a.push(`exposure="${num(exposure)}"`);
  if (f.samples !== undefined) a.push(`samples="${f.samples}"`);
  if (f.bloom !== undefined) a.push(`bloom="${num(f.bloom)}"`);
  if (f.bloomThreshold !== undefined) a.push(`bloom-threshold="${num(f.bloomThreshold)}"`);
  if (f.vignette !== undefined) a.push(`vignette="${num(f.vignette)}"`);
  if (f.contrast !== undefined) a.push(`contrast="${num(f.contrast)}"`);
  if (f.saturation !== undefined) a.push(`saturation="${num(f.saturation)}"`);
  if (f.grain !== undefined) a.push(`grain="${num(f.grain)}"`);
  if (f.chromaticAberration !== undefined) a.push(`chromatic-aberration="${num(f.chromaticAberration)}"`);
  if (f.lightSweep !== undefined) a.push(`light-sweep="${num(f.lightSweep)}"`);
  if (f.ground && f.ground !== "none") a.push(`ground="${f.ground}" ground-y="0" ground-size="6"`);
  return a.length ? "\n              " + a.join(" ") : "";
}

function lightMarkup(lighting: Lighting | undefined, metalRig: boolean): string {
  if (metalRig) return METAL_RIG;
  if (!lighting || lighting === "auto") return `<sf-light preset="studio"></sf-light>`;
  if ("preset" in lighting) return `<sf-light preset="${lighting.preset}"></sf-light>`;
  const lines: string[] = [];
  const emit = (l: LightSpec | undefined, color: string, intensity: number, position: string) => {
    if (!l) return;
    lines.push(
      `<sf-light type="${l.type ?? "directional"}" color="${l.color ?? color}" intensity="${num(l.intensity ?? intensity)}" position="${l.position ?? position}"></sf-light>`,
    );
  };
  emit(lighting.key, "#ffffff", 2.4, "4 5 4");
  emit(lighting.rim, "#9db8ff", 2.0, "-5 3.5 -4");
  emit(lighting.fill, "#ffe6c8", 1.0, "5 1.5 3");
  return lines.join("\n      ");
}

/** A moody nebula `<sf-shader fullscreen>` — a tinted cyan/magenta fbm gradient
 *  with vignette. The single biggest "not a flat black void" lever. */
function backdropMarkup(backdrop: ShotDefaults["backdrop"]): string {
  if (backdrop === "none") return "";
  const cold = (backdrop && typeof backdrop === "object" && backdrop.coldGlow) || "#0a3550";
  const warm = (backdrop && typeof backdrop === "object" && backdrop.warmGlow) || "#2a0a1e";
  return `<sf-shader fullscreen u-cold-glow="${cold}" u-warm-glow="${warm}">
        void main(){
          vec2 uv = vUv; vec2 c = uv - vec2(0.5, 0.46); c.x *= uResolution.x / uResolution.y;
          float d = length(c); float vig = smoothstep(1.2, 0.1, d);
          float n = fbm(uv * 2.4 + vec2(uTime * 0.022, uTime * 0.035));
          float n2 = fbm(uv * 4.0 - vec2(uTime * 0.018, 0.0));
          vec3 glow = mix(uColdGlow, uWarmGlow, smoothstep(0.12, 0.92, uv.y + n * 0.3));
          gl_FragColor = vec4(vec3(0.006,0.009,0.015) + glow * (0.11 + 0.17 * n2) * vig, 1.0);
        }
      </sf-shader>`;
}

/** A real ground plane so the subject sits on a surface (and the floor occludes the
 *  fullscreen backdrop below the subject). `road` = damp dark asphalt under neon;
 *  `studio` = glossy infinity-cove. Slightly below y=0 to avoid z-fighting the
 *  contact-shadow plane. */
function floorMarkup(floor: ShotDefaults["floor"]): string {
  if (floor === undefined || floor === "none") return "";
  const presets = {
    road: { color: "#0a0a0d", metalness: 0.25, roughness: 0.6, size: 60 },
    studio: { color: "#0a0a0c", metalness: 0.8, roughness: 0.16, size: 60 },
  };
  const f = typeof floor === "string" ? presets[floor] : { color: "#0a0a0d", metalness: 0.25, roughness: 0.6, size: 60, ...floor };
  return `<sf-mesh geometry="plane" args="${num(f.size)} ${num(f.size)}" rotation="-90 0 0" position="0 -0.01 0" color="${f.color}" metalness="${num(f.metalness)}" roughness="${num(f.roughness)}"></sf-mesh>`;
}

/** Drifting atmosphere particles. Caller enforces the crossfade-outgoing guard. */
function atmosphereMarkup(kind: "dust" | "snow", seed: number): string {
  if (kind === "snow") {
    return `<sf-particles preset="snow" count="500" seed="${seed}" color="#dceaff" size="0.04" opacity="0.6" area="10 6 10"></sf-particles>`;
  }
  return `<sf-particles preset="dust" count="340" seed="${seed}" color="#7ab6ff" size="0.03" opacity="0.45" area="9 5 9"></sf-particles>`;
}

function cameraMarkup(cam: Camera, d: number): { camera: string; animate: string } {
  const fov = cam.fov ?? 35;
  const ease = cam.ease ?? "sine.inOut";
  const dd = num(d);
  if (cam.type === "static") {
    return {
      camera: `<sf-camera fov="${fov}" position="${cam.position ?? "0 1 5"}"${cam.lookAt ? ` look-at="${cam.lookAt}"` : ""}></sf-camera>`,
      animate: "",
    };
  }
  if (cam.type === "path") {
    const first = (cam.points ?? "0 1 5").split(",")[0]!.trim();
    return {
      camera: `<sf-camera fov="${fov}" position="${first}"></sf-camera>`,
      animate: `<sf-animate target="camera" verb="camera-path" look="ahead" points="${cam.points}" start="0" duration="${dd}" ease="${ease}"></sf-animate>`,
    };
  }
  if (cam.type === "flythrough") {
    // Dynamic spline that stays locked on the subject: camera-path moves the
    // position, look="none" leaves aiming to the sf-camera look-at (re-applied
    // each frame after the path). No lint conflict (conflict is look="ahead" only).
    const first = (cam.points ?? "0 1 5").split(",")[0]!.trim();
    const lookAt = cam.lookAt ?? "0 0.9 0";
    return {
      camera: `<sf-camera fov="${fov}" position="${first}" look-at="${lookAt}"></sf-camera>`,
      animate: `<sf-animate target="camera" verb="camera-path" look="none" points="${cam.points}" start="0" duration="${dd}" ease="${ease}"></sf-animate>`,
    };
  }
  if (cam.type === "orbit" || cam.type === "hero") {
    const around = cam.around ?? "0 0.9 0";
    const radius = cam.radius ?? 5;
    const from = cam.from ?? (cam.type === "hero" ? 8 : 30);
    const to = cam.to ?? (cam.type === "hero" ? -12 : -8);
    const height = cam.height ?? (cam.type === "hero" ? 0.35 : 0.5);
    const pos = cam.position ?? (cam.type === "hero" ? "0.5 0.25 5" : undefined);
    const lookAt = cam.lookAt ?? (cam.type === "hero" ? "0 1 0" : undefined);
    return {
      camera: `<sf-camera fov="${fov}"${pos ? ` position="${pos}"` : ""}${lookAt ? ` look-at="${lookAt}"` : ""}></sf-camera>`,
      animate: `<sf-animate target="camera" verb="orbit" around="${around}" radius="${num(radius)}" from="${num(from)}deg" to="${num(to)}deg" height="${num(height)}" start="0" duration="${dd}" ease="${ease}"></sf-animate>`,
    };
  }
  // dolly / push-in / pull-back
  const toward = cam.toward ?? "0 0.9 0";
  const distance = cam.type === "pull-back" ? -Math.abs(cam.distance ?? 0.6) : (cam.distance ?? 0.6);
  return {
    camera: `<sf-camera fov="${fov}" position="${cam.position ?? "0 1 6"}"${cam.lookAt ? ` look-at="${cam.lookAt}"` : ""}></sf-camera>`,
    animate: `<sf-animate target="camera" verb="dolly" toward="${toward}" distance="${num(distance)}" start="0" duration="${dd}" ease="${ease}"></sf-animate>`,
  };
}

export function compileStoryboard(
  plan: Storyboard,
  resolved: ResolvedShot[],
  opts: { warn?: (msg: string) => void } = {},
): string {
  const warn = opts.warn ?? (() => {});
  const W = plan.width ?? 1920;
  const H = plan.height ?? 1080;
  const windows = computeTimeline(plan.shots);
  const firstBg = (plan.shots[0]?.bg ?? plan.defaults?.bg ?? "#0a0a0e");

  const sceneBlocks: string[] = [];
  const domBlocks: string[] = [];

  plan.shots.forEach((shot, i) => {
    const r = resolved[i] ?? { modelBasename: "model.glb", metalRig: false };
    const w = windows[i]!;
    const id = `m${i + 1}`;
    const bg = shot.bg ?? plan.defaults?.bg ?? firstBg;
    const env = shot.environment ?? plan.defaults?.environment ?? "room";
    const fit = shot.fit ?? plan.defaults?.fit ?? 2.4;
    const fitGround = shot.fitGround ?? plan.defaults?.fitGround ?? true;
    const pose = shot.pose ?? plan.defaults?.pose;
    const backdrop = shot.backdrop ?? plan.defaults?.backdrop;
    const atmosphere = shot.atmosphere ?? plan.defaults?.atmosphere;
    const floor = shot.floor ?? plan.defaults?.floor;
    const secondaryMotion = shot.secondaryMotion ?? plan.defaults?.secondaryMotion;
    const finish = mergeFinish(plan.defaults?.finish, shot.finish);
    const lighting = mergeLighting(plan.defaults?.lighting, shot.lighting);
    const cam = cameraMarkup(shot.camera, shot.duration);

    // Atmosphere is unsafe on the outgoing half of a crossfade (particle time
    // uniform isn't advanced while fading out → non-idempotent seek). The
    // outgoing shot is this one when the NEXT shot crossfades in.
    const nextCrossfades = plan.shots[i + 1]?.transition === "crossfade";
    const wantAtmosphere = atmosphere && atmosphere !== "none";
    const emitAtmosphere = wantAtmosphere && !nextCrossfades;
    if (wantAtmosphere && nextCrossfades) {
      warn(`shot ${i + 1}${shot.name ? ` "${shot.name}"` : ""}: atmosphere dropped — a shot that crossfades out can't hold seekable particles. Use a cut after it, or make it the last shot.`);
    }

    const anims: string[] = [];
    if (shot.explode) {
      const ex = explodeTiming(shot.duration);
      anims.push(
        `<sf-animate target="#${id}" verb="explode" distance="${num(shot.explode.distance ?? 0.8)}" start="${num(ex.start)}" duration="${num(ex.dur)}" ease="power2.inOut"></sf-animate>`,
      );
    }
    // Secondary motion (composes with the camera move) — the "alive" layer.
    const spin = secondaryMotion?.spin ?? shot.spin;
    if (spin) anims.push(`<sf-animate target="#${id}" verb="turntable" rpm="${num(spin)}"></sf-animate>`);
    if (secondaryMotion?.sway) {
      anims.push(`<sf-animate target="#${id}" verb="sway" amount="${num(secondaryMotion.sway)}" period="7"></sf-animate>`);
    }
    if (secondaryMotion?.float) {
      anims.push(`<sf-animate target="#${id}" verb="float" amplitude="${num(secondaryMotion.float)}" period="5"></sf-animate>`);
    }
    if (shot.isolate) {
      anims.push(
        `<sf-animate target="#${id}" verb="isolate" part="${shot.isolate.part}"${shot.isolate.dim != null ? ` dim="${num(shot.isolate.dim)}"` : ""} start="0.3" duration="0.8"></sf-animate>`,
      );
    }
    if (cam.animate) anims.push(cam.animate);

    // callouts target #m{i} (rewrite the part-target's host id via the markup)
    const callouts = (r.callouts ?? []).map((c) => ({ ...c }));
    const calloutBlock = calloutMarkup(callouts).replace(/target="#m"/g, `target="#${id}"`);

    // text overlay (DOM, clipped to this shot's window) — up to three staggered
    // tiers (title / subtitle / spec), the flagship title-card pattern.
    if (shot.text?.title || shot.text?.subtitle || shot.text?.spec) {
      const t1 = Math.min(0.7, shot.duration * 0.3);
      const tiers: Array<{ key: string; text: string; bottom: number; style: string; rise: number; start: number }> = [];
      if (shot.text.title) {
        tiers.push({ key: `sbtitle${i}`, text: shot.text.title, bottom: 148, rise: 26, start: t1,
          style: "font-size:80px;font-weight:800;letter-spacing:0.06em;color:#f4f6ff;text-shadow:0 6px 38px rgba(0,0,0,.7)" });
      }
      if (shot.text.subtitle) {
        tiers.push({ key: `sbsub${i}`, text: shot.text.subtitle, bottom: 112, rise: 18, start: t1 + 0.5,
          style: "font-size:19px;font-weight:500;letter-spacing:0.4em;text-transform:uppercase;color:#8fd0ff" });
      }
      if (shot.text.spec) {
        tiers.push({ key: `sbspec${i}`, text: shot.text.spec, bottom: 74, rise: 12, start: t1 + 1.0,
          style: "font-size:15px;font-weight:500;letter-spacing:0.3em;text-transform:uppercase;color:#aeb6c2" });
      }
      for (const tier of tiers) {
        anims.push(`<sf-animate target="#${tier.key}" verb="fade-in" start="${num(tier.start)}" duration="0.9" rise="${tier.rise}"></sf-animate>`);
        domBlocks.push(
          `<div id="${tier.key}" class="clip" data-start="${num(w.start)}" data-duration="${num(shot.duration)}" style="position:absolute;bottom:${tier.bottom}px;width:100%;text-align:center;${tier.style}">${tier.text}</div>`,
        );
      }
    }

    const transitionAttr =
      w.transition === "crossfade"
        ? ` transition="crossfade" transition-duration="${num(w.transitionDuration)}"`
        : "";

    // backdrop emits only when the field is set (keeps existing plans unchanged;
    // cinematic "always-on backdrop" is a director-layer default, not the compiler's).
    const backdropStr = backdrop === undefined ? "" : backdropMarkup(backdrop);
    const atmosphereStr = emitAtmosphere ? atmosphereMarkup(atmosphere!, i + 1) : "";
    const floorStr = floorMarkup(floor);
    const head2 = [backdropStr, cam.camera, lightMarkup(lighting, r.metalRig), floorStr, atmosphereStr]
      .filter(Boolean)
      .map((s) => `      ${s}`)
      .join("\n");

    sceneBlocks.push(
      `    <!-- shot ${i + 1}${shot.name ? ` · ${shot.name}` : ""} · ${num(w.start)}–${num(w.end)}s -->
    <sf-scene start="${num(w.start)}" duration="${num(shot.duration)}"${transitionAttr}
              width="${W}" height="${H}" background="${bg}"
              environment="${env}"${finishAttrs(finish, r.metalRig)}>
${head2}
      <sf-model id="${id}" src="assets/${r.modelBasename}" fit="${num(fit)}"${fitGround ? " fit-ground" : ""}${pose ? ` rotation="${pose}"` : ""}></sf-model>
${anims.map((a) => `      ${a}`).join("\n")}${calloutBlock ? "\n" + calloutBlock : ""}
    </sf-scene>`,
    );
  });

  return `${head(firstBg, W, H)}
${sceneBlocks.join("\n\n")}

${domBlocks.map((d) => `    ${d}`).join("\n")}
${tail}`;
}

// ── scaffold (impure) ───────────────────────────────────────────────────────
export interface BuildStoryboardOptions {
  plan: Storyboard;
  planDir: string; // dir the plan file lives in (model paths resolve against it)
  outDir: string;
}

function calloutInputToSpec(c: CalloutInput, i: number): CalloutSpec {
  return {
    part: String(c.part),
    value: c.value ?? `Part ${i + 1}`,
    text: c.text ?? "",
    anchor: c.anchor ?? (i % 2 === 0 ? "right" : "left"),
    leadY: -92 - i * 46,
    start: c.start ?? 1,
    duration: 0.7,
  };
}

export async function buildStoryboard(opts: BuildStoryboardOptions): Promise<{ dir: string; duration: number }> {
  const { plan, planDir, outDir } = opts;
  const dir = resolve(outDir);
  mkdirSync(join(dir, "assets"), { recursive: true });

  // Resolve + copy each referenced model; inspect once per distinct model.
  const manifestCache = new Map<string, Awaited<ReturnType<typeof inspectModel>>>();
  const basenames = new Map<string, string>(); // resolved path → basename
  const resolved: ResolvedShot[] = [];

  for (const shot of plan.shots) {
    const rel = shot.model ?? plan.model!;
    const modelPath = resolve(planDir, rel);
    if (!existsSync(modelPath)) throw new Error(`storyboard: model not found: ${rel}`);
    const base = basename(modelPath);
    if (!basenames.has(modelPath)) {
      const existing = [...basenames.values()].includes(base);
      if (existing) throw new Error(`storyboard: two different models share the basename "${base}" — rename one`);
      const destPath = join(dir, "assets", base);
      // Skip the copy when the model already lives at the destination (the one-shot
      // `brief --gen` writes the GLB straight into the out dir's assets/).
      if (resolve(modelPath) !== resolve(destPath)) copyFileSync(modelPath, destPath);
      basenames.set(modelPath, base);
    }

    const needsInspect = shot.lighting === "auto" || shot.callout === "auto";
    let manifest = manifestCache.get(modelPath);
    if (needsInspect && !manifest) {
      manifest = await inspectModel({ model: modelPath, silent: true, write: false });
      manifestCache.set(modelPath, manifest);
    }

    const metalRig =
      shot.lighting === "auto" &&
      !!manifest &&
      manifest.dominant.character === "metal" &&
      (manifest.dominant.metalness ?? 0) > 0.6;

    let callouts: CalloutSpec[] | undefined;
    if (shot.callout === "auto" && manifest) {
      callouts = buildAutoCallouts(manifest, shot.duration, { max: 3 });
    } else if (Array.isArray(shot.callout)) {
      callouts = shot.callout.map(calloutInputToSpec);
    }

    resolved.push({ modelBasename: base, metalRig, callouts });
  }

  const html = compileStoryboard(plan, resolved, { warn: (m) => console.warn(`note: ${m}`) });
  copyFileSync(resolveRuntimeBundle(), join(dir, "assets", "stereoframe.js"));
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "renders/\n");
  writeFileSync(join(dir, "index.html"), html);

  const duration = Math.max(...computeTimeline(plan.shots).map((w) => w.end));
  return { dir, duration };
}

/** Read + parse a storyboard JSON file (clear error on bad JSON). */
export function readStoryboard(path: string): { plan: Storyboard; planDir: string } {
  const full = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(full, "utf8");
  } catch {
    throw new Error(`storyboard: cannot read ${path}`);
  }
  let plan: Storyboard;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw new Error(`storyboard: invalid JSON in ${path} — ${(e as Error).message}`);
  }
  return { plan, planDir: dirname(full) };
}

// ── schema description (single source of truth for the `brief` LLM prompt) ────
/** A compact, LLM-facing description of the storyboard JSON. Kept next to the
 *  schema it documents so the two never drift. Consumed by `brief.ts`. */
export const STORYBOARD_SCHEMA_DOC = `STORYBOARD PLAN — JSON schema (a shot list that compiles to a multi-shot 3D film)

Top level:
  { title?, model (GLB basename), width?=1920, height?=1080, fps?=30,
    defaults?: ShotDefaults, shots: Shot[] (required, >=1) }

ShotDefaults (inherited by every shot; any shot may override):
  bg?            : "#hex" scene background
  environment?   : "studio" | "room" (procedural reflections; keep "studio")
  fit?=2.6       : normalize model longest-dim to this size
  fitGround?=true: rest model on the floor
  pose?          : "x y z" degrees — re-orient the model (text-to-3D often returns
                   odd poses; a phone flat -> "0 90 90"). Use the model facts below.
  backdrop?      : { coldGlow:"#hex", warmGlow:"#hex" } -> a moody nebula shader
                   behind the subject (NOT flat black). Or "none". SET THIS on most shots.
  atmosphere?    : "dust" | "snow" | "none" -> drifting particles. CONSTRAINT: only on
                   a shot whose NEXT shot is a cut, or the LAST shot (it is dropped on a
                   shot that crossfades out). Good on the cold-open and the hero.
  secondaryMotion: { spin?(rpm), sway?(deg), float?(amplitude) } -> keeps the subject
                   ALIVE while the camera moves. SET THIS (e.g. spin 1-2, sway 1) on most shots.
  floor?         : "road" (dark damp asphalt under neon) | "studio" (glossy infinity-cove) |
                   "none" | {color,metalness,roughness,size}. A real ground plane so the
                   subject doesn't float on the backdrop. SET THIS (with finish.ground:
                   "contact-shadow") whenever you set a backdrop. "road" suits vehicles.
  finish?        : { exposure?, samples?=2, bloom?, bloomThreshold?, vignette?, contrast?,
                     saturation?, grain?, chromaticAberration?, lightSweep?, ground?:"contact-shadow" }
                   SANE RANGES (stay in these or the film flickers/blows out):
                   exposure 0.4-1.1 · bloom 0.06-0.16 · bloomThreshold 0.80-0.95 (NEVER below
                   0.6 — low threshold makes the whole image bloom and pulse) · vignette 0.3-0.6 ·
                   contrast 1.0-1.15 · saturation 1.0-1.35 · grain 0-0.03 (keep tiny; it changes
                   every frame) · chromaticAberration 0-0.12 · lightSweep 0.05-0.24.
  lighting?      : { preset:"studio"|"soft"|"sunset" } | "auto" (metal-aware rig) |
                   { key?, fill?, rim? } each { color:"#hex", intensity, position:"x y z" }

Shot (extends ShotDefaults):
  name?            : short label
  duration         : seconds (required). Vary across shots (e.g. 2.4 / 3.3 / 3 / 3 / 4).
  transition?      : "cut" | "crossfade" (default crossfade after shot 1). Use a CUT for
                     a dramatic "lights-on" reveal.
  transitionDuration?=0.4
  camera           : { type, fov?, ease?, ...type fields } (required), where type is:
                       static     {position, lookAt}
                       orbit      {around, radius, from, to, height}     (from/to in degrees)
                       dolly|push-in|pull-back {position, lookAt, toward, distance}
                       path       {points:"x y z, x y z, ..."}           (looks ahead; no lookAt)
                       flythrough {points, lookAt}                       (dynamic, stays on subject)
                       hero       {position, lookAt, around, radius, from, to, height} (low heroic orbit)
  CAMERA SAFETY (critical — a too-close camera wrecks the shot): the subject is
  normalized to ~fit units (about 2.6) centered at the origin, so it spans roughly +/-1.3.
  Keep EVERY camera position / points waypoint OUTSIDE it — distance from origin
  >= ~4 (never a point like "1 0.5 0", that is INSIDE the model). A flythrough/path
  must arc AROUND the subject (e.g. all points ~5 out, in front), NEVER a straight
  line through it. All position/lookAt/points values are plain numbers "x y z".
  isolate?         : { part, dim? }   explode?: { distance? }   spin?: rpm
  callout?         : "auto" | "none"  (auto = inspect-driven spec labels; multi-part models only)
  text?            : { title?, subtitle?, spec? } -> staggered 3-tier title card (use on the hero)

CINEMATIC DIRECTION (aim for a real film, not a turntable):
- 6-9 shots, 18-28s total, VARIED beat lengths.
- A strong arc: cold-open (dark, low exposure, vignette, one rim light) -> hard CUT to a
  lit reveal -> 1-2 detail/macro beats -> a flythrough -> hero (full light) with a staggered
  title card. Vary camera TYPE across shots (don't repeat orbit every time).
- Set backdrop + secondaryMotion on (almost) every shot. Put atmosphere:"dust" on the
  cold-open (followed by a cut) and the final hero.
- Colour = lighting + grade: complementary split (e.g. cyan key / magenta rim), per-beat
  exposure/vignette/saturation, light-sweep 0.06-0.12 for the specular highlight sweep.
- ANTI-FLICKER (important for glossy/metal subjects): do NOT stack fast motions — a fast
  camera orbit + a subject spin + a high light-sweep all churn the sharp reflections and make
  the surface SPARKLE (specular aliasing). Per shot, prefer EITHER a camera move OR a subject
  spin (a small sway/float is fine alongside either). Keep camera "hero"/orbit sweeps modest
  (~30-60 deg, not 300+). Keep light-sweep <=0.1 on metal. Use finish.samples:3 on the hero /
  any beat where a shiny subject fills the frame.
- Determinism: atmosphere never on a crossfade-out shot. Keep everything a function of time.`;
