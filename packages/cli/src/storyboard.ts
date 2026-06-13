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
  type: "static" | "orbit" | "dolly" | "push-in" | "pull-back" | "path" | "hero";
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
  text?: { title?: string; subtitle?: string };
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

const CAMERA_TYPES = ["static", "orbit", "dolly", "push-in", "pull-back", "path", "hero"];

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
      if (cam.type === "path" && !cam.points) errs.push(`${tag}: path camera needs points`);
      if (cam.type === "static" && !cam.position) errs.push(`${tag}: static camera needs position`);
      if (cam.ease && !eases.has(cam.ease)) errs.push(`${tag}: unknown ease "${cam.ease}"`);
    }
  });
  return errs;
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

export function compileStoryboard(plan: Storyboard, resolved: ResolvedShot[]): string {
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
    const finish = mergeFinish(plan.defaults?.finish, shot.finish);
    const lighting = mergeLighting(plan.defaults?.lighting, shot.lighting);
    const cam = cameraMarkup(shot.camera, shot.duration);

    const anims: string[] = [];
    if (shot.explode) {
      const ex = explodeTiming(shot.duration);
      anims.push(
        `<sf-animate target="#${id}" verb="explode" distance="${num(shot.explode.distance ?? 0.8)}" start="${num(ex.start)}" duration="${num(ex.dur)}" ease="power2.inOut"></sf-animate>`,
      );
    }
    if (shot.spin) {
      anims.push(`<sf-animate target="#${id}" verb="turntable" rpm="${num(shot.spin)}"></sf-animate>`);
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

    // text overlay (DOM, clipped to this shot's global window)
    if (shot.text?.title || shot.text?.subtitle) {
      const t1 = Math.min(0.6, shot.duration * 0.3);
      if (shot.text.title) {
        anims.push(`<sf-animate target="#sbtitle${i}" verb="fade-in" start="${num(t1)}" duration="0.9" rise="24"></sf-animate>`);
        domBlocks.push(
          `<div id="sbtitle${i}" class="clip" data-start="${num(w.start)}" data-duration="${num(shot.duration)}" style="position:absolute;bottom:120px;width:100%;text-align:center;font-size:64px;font-weight:800;letter-spacing:0.04em;color:#f4f1e8;text-shadow:0 4px 30px rgba(0,0,0,.6)">${shot.text.title}</div>`,
        );
      }
      if (shot.text.subtitle) {
        anims.push(`<sf-animate target="#sbsub${i}" verb="fade-in" start="${num(t1 + 0.3)}" duration="0.9" rise="16"></sf-animate>`);
        domBlocks.push(
          `<div id="sbsub${i}" class="clip" data-start="${num(w.start)}" data-duration="${num(shot.duration)}" style="position:absolute;bottom:92px;width:100%;text-align:center;font-size:18px;font-weight:500;letter-spacing:0.3em;text-transform:uppercase;color:#aeb6c2">${shot.text.subtitle}</div>`,
        );
      }
    }

    const transitionAttr =
      w.transition === "crossfade"
        ? ` transition="crossfade" transition-duration="${num(w.transitionDuration)}"`
        : "";

    sceneBlocks.push(
      `    <!-- shot ${i + 1}${shot.name ? ` · ${shot.name}` : ""} · ${num(w.start)}–${num(w.end)}s -->
    <sf-scene start="${num(w.start)}" duration="${num(shot.duration)}"${transitionAttr}
              width="${W}" height="${H}" background="${bg}"
              environment="${env}"${finishAttrs(finish, r.metalRig)}>
      ${cam.camera}
      ${lightMarkup(lighting, r.metalRig)}
      <sf-model id="${id}" src="assets/${r.modelBasename}" fit="${num(fit)}"${fitGround ? " fit-ground" : ""}${pose ? ` rotation="${pose}"` : ""}></sf-model>
${anims.map((a) => `      ${a}`).join("\n")}${calloutBlock ? "\n" + calloutBlock : ""}
    </sf-scene>`,
    );
  });

  return `${head(firstBg)}
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
      copyFileSync(modelPath, join(dir, "assets", base));
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

  const html = compileStoryboard(plan, resolved);
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
