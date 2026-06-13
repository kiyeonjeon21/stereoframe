/**
 * `stereoframe stage <model.glb> --preset <name>` — drop in any GLB, get a
 * directed cinematic motion graphic. The model is auto-framed (the runtime
 * normalizes its size + center via `fit`), so a fixed director preset
 * (camera move + lighting rig + timing + finish) frames it perfectly
 * regardless of the model's original scale/origin.
 *
 * This is stereoframe's core value: not generating the asset, but directing
 * it — the layer motion designers actually spend their time on.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Character, ModelManifest, PartManifest } from "./inspect";
import { resolveRuntimeBundle } from "./scaffold";

export const PRESETS = ["reveal", "hero-orbit", "turntable", "exploded-view", "spec", "teardown"] as const;
export type Preset = (typeof PRESETS)[number];

/** An auto-generated spec callout (from the segment manifest). */
export interface CalloutSpec {
  part: string;
  value: string;
  text: string;
  anchor: "left" | "right";
  leadY: number;
  start: number;
  duration: number;
}

export interface StageOptions {
  model: string;
  projectDir: string;
  preset: Preset;
  duration?: number;
  background?: string;
  title?: string;
  /** spec preset: auto-callouts derived from `stereoframe inspect`. */
  callouts?: CalloutSpec[];
  /** when the model is dominantly metallic: tame exposure + swap the studio
   *  preset for a cool-rim/warm-fill rig so chrome doesn't blow out. */
  metalRig?: boolean;
}

/** A cool rim + warm fill + dim hemisphere — separates a metal subject and
 *  keeps highlights from blowing out (the killer-demos dark-metal recipe). */
export const METAL_RIG = `<sf-light type="hemisphere" color="#2a3040" intensity="0.4"></sf-light>
      <sf-light type="directional" color="#bcd4ff" intensity="2.0" position="-5 3.5 -4"></sf-light>
      <sf-light type="directional" color="#ffd0a0" intensity="1.4" position="5 2 3"></sf-light>`;

/** For a metallic model: drop exposure ~0.12 (floor 0.6) and replace the studio
 *  light preset with the metal rig. Applied to the generated HTML — markers
 *  (`exposure="…"`, `<sf-light preset="studio">`) are stable in our templates. */
export function applyMetalRig(html: string): string {
  return html
    .replace(/exposure="([\d.]+)"/, (_m, v) => `exposure="${Math.max(0.6, Number(v) - 0.12).toFixed(2)}"`)
    .replace(/<sf-light preset="studio"><\/sf-light>/g, METAL_RIG);
}

export function head(bg: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${bg}; }
      body { font-family: "Helvetica Neue", Arial, sans-serif; }
      sf-scene { position: absolute; inset: 0; }
      #title {
        position: absolute; bottom: 110px; width: 100%; text-align: center;
        font-size: 70px; font-weight: 700; letter-spacing: 0.04em; color: #f4f1e8;
        text-shadow: 0 4px 30px rgba(0,0,0,0.55);
      }
    </style>
  </head>
  <body>`;
}

export const tail = `
    <script type="module">
      import "./assets/stereoframe.js";
    </script>
  </body>
</html>
`;

export function titleBlock(title: string | undefined, t1: number): { anim: string; dom: string } {
  if (!title) return { anim: "", dom: "" };
  return {
    anim: `      <sf-animate target="#title" verb="fade-in" start="${t1}" duration="1.2" rise="34"></sf-animate>\n`,
    dom: `    <div id="title" class="clip" data-start="${t1}">${title}</div>\n`,
  };
}

function reveal(model: string, d: number, bg: string, title?: string): string {
  const t1 = Math.max(1.2, d * 0.4);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="0.92"
              samples="2" bloom="0.22" bloom-threshold="0.86" vignette="0.45"
              chromatic-aberration="0.14" grain="0.03" contrast="1.05" saturation="1.05"
              ground="contact-shadow" ground-y="0" ground-size="6" light-sweep="0.1">
      <sf-camera fov="34" position="-3 0.5 5.2" look-at="0 1 0"></sf-camera>
      <sf-light type="hemisphere" color="#2a3450" intensity="0.5"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="2.6" position="4 7 5"></sf-light>
      <sf-light type="directional" color="#9db8ff" intensity="1.5" position="-5 3 -4"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.6" fit-ground></sf-model>
      <sf-animate target="#m" verb="bounce-in" start="0.2" duration="1" ease="back.out"></sf-animate>
      <sf-animate target="#m" verb="turntable" rpm="2.4" start="0.5"></sf-animate>
      <sf-animate target="camera" verb="camera-path" look="none"
                  points="-3 0.5 5.2, -1.8 0.9 4.4, -0.7 1.1 3.9, 0.25 1.1 3.7"
                  start="0" duration="${d}" ease="power2.inOut"></sf-animate>
${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

function heroOrbit(model: string, d: number, bg: string, title?: string): string {
  const t1 = Math.max(1.2, d * 0.4);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="1.0"
              samples="2" bloom="0.12" bloom-threshold="0.9" vignette="0.32"
              grain="0.025" contrast="1.03" saturation="1.05"
              ground="contact-shadow" ground-y="0" ground-size="6" light-sweep="0.1">
      <sf-camera fov="34" position="0 1.3 5.2" look-at="0 1 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.4" fit-ground></sf-model>
      <sf-animate target="#m" verb="turntable" rpm="1.4"></sf-animate>
      <sf-animate target="camera" verb="orbit" around="0 1 0" radius="5.4"
                  from="-38deg" to="38deg" height="0.5" start="0" duration="${d}"
                  ease="sine.inOut"></sf-animate>
${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

function turntable(model: string, d: number, bg: string, title?: string): string {
  const t1 = Math.max(1.2, d * 0.4);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="1.02"
              samples="2" bloom="0.12" bloom-threshold="0.9" vignette="0.3"
              grain="0.02" contrast="1.03" light-sweep="0.1">
      <sf-camera fov="33" position="0 1.4 5.4" look-at="0 1 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-mesh geometry="cylinder" args="2 2.2 0.12" color="#1c1f26"
               roughness="0.3" metalness="0.6" position="0 -0.06 0"></sf-mesh>
      <sf-model id="m" src="assets/${model}" fit="2.3" fit-ground></sf-model>
      <sf-animate target="#m" verb="turntable" rpm="5"></sf-animate>
      <sf-animate target="camera" verb="dolly" toward="0 1 0" distance="0.5"
                  start="0" duration="${d}" ease="sine.inOut"></sf-animate>
${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

function explodedView(model: string, d: number, bg: string, title?: string): string {
  const t1 = Math.max(1.2, d * 0.5);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="1.0"
              samples="2" bloom="0.12" bloom-threshold="0.9" vignette="0.3"
              grain="0.025" contrast="1.03" saturation="1.05">
      <sf-camera fov="38" position="0 0.4 6.2" look-at="0 0 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.6"></sf-model>
      <sf-animate target="#m" verb="explode" distance="0.8" start="0.6" duration="2.6"
                  ease="power2.inOut"></sf-animate>
      <sf-animate target="#m" verb="turntable" rpm="2"></sf-animate>
      <sf-animate target="camera" verb="orbit" around="0 0 0" radius="6.2"
                  from="-26deg" to="26deg" height="0.5" start="0" duration="${d}"
                  ease="sine.inOut"></sf-animate>
${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

/** CamelCase/underscore/hyphen part name → human title ("ToyCar" → "Toy Car"). */
function humanizeName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return "Part";
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A short, honest caption from the tagged material character. */
const CHARACTER_CAPTION: Record<Character, string> = {
  glass: "Optical glass",
  metal: "Metal body",
  fabric: "Soft-touch",
  emissive: "Illuminated",
  matte: "Composite",
  "—": "Component",
};

/** A one-word noun from the material character (for synthesised labels). */
const CHARACTER_NOUN: Record<Character, string> = {
  glass: "Glass",
  metal: "Metal",
  fabric: "Fabric",
  emissive: "Light",
  matte: "",
  "—": "",
};

/**
 * Default exporter names ("Mesh 0", "Node001", "Object", a bare number) carry
 * no meaning, so labelling a callout with them is noise. The fuzzer showed this
 * is common in real/generated GLBs (a well-authored model like ToyCar names its
 * parts; many don't).
 */
function isGenericName(name: string): boolean {
  const s = (name ?? "").trim();
  if (!s || s.length <= 1) return true;
  return (
    /^(mesh|node|object|primitive|group|polysurface|geometry|default|material)[\s._-]*\d*$/i.test(s) ||
    /^\d+$/.test(s)
  );
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A callout label for a part. A real name is used as-is (name + material
 * caption); a generic name is replaced with something synthesised from what we
 * DID tag — material character and where the part sits — so the label still
 * reads ("Glass / TOP", "Metal / FRONT · LEFT") instead of "Mesh 0".
 */
function labelFor(part: PartManifest): { value: string; text: string } {
  if (!isGenericName(part.name)) {
    return { value: humanizeName(part.name), text: CHARACTER_CAPTION[part.character] };
  }
  const place = part.spatial.filter((s) => s !== "core").map(cap).join(" · ");
  const noun = CHARACTER_NOUN[part.character];
  if (noun) return { value: noun, text: place || CHARACTER_CAPTION[part.character] };
  if (place) return { value: place, text: "Component" };
  return { value: part.sizeRank === 0 ? "Main body" : `Part ${part.index + 1}`, text: "Component" };
}

/** Explode timing for the teardown preset — single source for the template and
 *  the callout start (callouts draw on once the parts have separated). */
export function explodeTiming(duration: number): { start: number; dur: number; end: number } {
  const start = 0.5;
  const dur = Math.round(Math.max(1.6, duration * 0.32) * 100) / 100;
  return { start, dur, end: start + dur };
}

/**
 * Derive auto-callouts from a segment manifest: annotate the most detailed mesh
 * parts (by triangle count), label them by name + material caption, side by
 * spatial position, and stagger the draw-ons. Returns [] for single-mesh models
 * (nothing to point at). `startAt` overrides when the first callout begins
 * (teardown waits for the parts to finish separating).
 */
export function buildAutoCallouts(
  manifest: ModelManifest,
  duration: number,
  opts: { max?: number; startAt?: number; leadFan?: number } = {},
): CalloutSpec[] {
  const max = opts.max ?? 3;
  // How much each successive label is pushed up the screen. Needed when parts
  // cluster (spec); off for teardown, where the explode already separates the
  // anchors and a fan would push the highest part's label off the top edge.
  const leadFan = opts.leadFan ?? 66;
  const parts = manifest.parts
    .filter((p) => p.kind === "mesh" && p.bounds)
    .sort((a, b) => b.triangles - a.triangles)
    .slice(0, max);
  if (parts.length < 2) return [];

  const base = opts.startAt ?? Math.max(1, duration * 0.32);
  const step = Math.min(0.9, (duration - base - 0.8) / Math.max(1, parts.length - 1));
  let alt = 0;
  return parts.map((p, i) => {
    const side: "left" | "right" = p.spatial.includes("left")
      ? "left"
      : p.spatial.includes("right")
        ? "right"
        : alt++ % 2 === 0
          ? "right"
          : "left";
    const { value, text } = labelFor(p);
    return {
      // Target by name when it's real (stable across re-exports); fall back to
      // the index for generic/unnamed parts.
      part: isGenericName(p.name) ? String(p.index) : p.name,
      value,
      text,
      anchor: side,
      // Fan the labels up the screen so parts that cluster (e.g. a canopy on
      // a body) and land on the same side don't stack on top of each other.
      leadY: -82 - i * leadFan,
      start: Math.round((base + i * step) * 100) / 100,
      duration: 0.7,
    };
  });
}

export function calloutMarkup(callouts: CalloutSpec[] | undefined): string {
  if (!callouts || callouts.length === 0) return "";
  return (
    callouts
      .map(
        (c) =>
          `      <sf-callout target="#m" part="${c.part}" value="${c.value}" text="${c.text}"` +
          ` anchor="${c.anchor}" lead-y="${c.leadY}" start="${c.start}" duration="${c.duration}"></sf-callout>`,
      )
      .join("\n") + "\n"
  );
}

/**
 * `spec` — the annotated product film. The model rests grounded and still
 * (so tracked labels stay readable) while the camera makes a slow arc; the
 * top parts get named spec callouts that draw on in sequence. Auto-populated
 * by `stage` from the segment manifest.
 */
function spec(model: string, d: number, bg: string, title?: string, callouts?: CalloutSpec[]): string {
  const t1 = Math.max(1.2, d * 0.4);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="1.0"
              samples="2" bloom="0.1" bloom-threshold="0.9" vignette="0.34"
              contrast="1.04" saturation="1.05"
              ground="contact-shadow" ground-y="0" ground-size="6" light-sweep="0.08">
      <sf-camera fov="34" position="2.2 1.2 4.9" look-at="0 0.9 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.3" fit-ground></sf-model>
      <sf-animate target="camera" verb="orbit" around="0 0.9 0" radius="5.4"
                  from="20deg" to="-6deg" height="0.5" start="0" duration="${d}" ease="sine.inOut"></sf-animate>
${calloutMarkup(callouts)}${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

/**
 * `teardown` — an exploded view where each separated part is labelled. The
 * parts fly apart from the model center, the camera makes a slow arc (the model
 * itself does NOT spin, so the tracked labels stay readable), and a spec callout
 * draws on over each part once it has settled. Auto-populated by `stage`.
 */
function teardown(model: string, d: number, bg: string, title?: string, callouts?: CalloutSpec[]): string {
  const ex = explodeTiming(d);
  const t1 = Math.max(1.2, d * 0.4);
  const t = titleBlock(title, t1);
  return `${head(bg)}
    <sf-scene duration="${d}" width="1920" height="1080" background="${bg}"
              environment="room" exposure="1.0" samples="2"
              bloom="0.12" bloom-threshold="0.9" vignette="0.32"
              contrast="1.04" saturation="1.05" light-sweep="0.07">
      <sf-camera fov="40" position="0 0.7 6.6" look-at="0 0 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.3"></sf-model>
      <sf-animate target="#m" verb="explode" distance="0.8" start="${ex.start}" duration="${ex.dur}" ease="power2.inOut"></sf-animate>
      <sf-animate target="camera" verb="orbit" around="0 0 0" radius="6.4"
                  from="-20deg" to="20deg" height="0.5" start="0" duration="${d}" ease="sine.inOut"></sf-animate>
${calloutMarkup(callouts)}${t.anim}    </sf-scene>
${t.dom}${tail}`;
}

const TEMPLATES: Record<Preset, (m: string, d: number, bg: string, t?: string) => string> = {
  "reveal": reveal,
  "hero-orbit": heroOrbit,
  "turntable": turntable,
  "exploded-view": explodedView,
  "spec": spec,
  "teardown": teardown,
};

export const DEFAULT_BG: Record<Preset, string> = {
  "reveal": "#0a0a0e",
  "hero-orbit": "#16181c",
  "turntable": "#15171b",
  "exploded-view": "#14161a",
  "spec": "#101216",
  "teardown": "#0e1014",
};

export function stageModel(opts: StageOptions): string {
  const modelPath = resolve(opts.model);
  if (!existsSync(modelPath)) throw new Error(`model not found: ${opts.model}`);
  if (!/\.(glb|gltf)$/i.test(modelPath)) {
    throw new Error("stage expects a .glb or .gltf model");
  }
  const dir = resolve(opts.projectDir);
  mkdirSync(join(dir, "assets"), { recursive: true });

  const modelFile = basename(modelPath);
  copyFileSync(modelPath, join(dir, "assets", modelFile));
  copyFileSync(resolveRuntimeBundle(), join(dir, "assets", "stereoframe.js"));
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "renders/\n");

  const d = opts.duration && opts.duration > 0 ? opts.duration : 8;
  const bg = opts.background ?? DEFAULT_BG[opts.preset];
  const base =
    opts.preset === "spec"
      ? spec(modelFile, d, bg, opts.title, opts.callouts)
      : opts.preset === "teardown"
        ? teardown(modelFile, d, bg, opts.title, opts.callouts)
        : TEMPLATES[opts.preset](modelFile, d, bg, opts.title);
  const html = opts.metalRig ? applyMetalRig(base) : base;
  writeFileSync(join(dir, "index.html"), html);

  return dir;
}
