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
import { resolveRuntimeBundle } from "./scaffold";

export const PRESETS = ["reveal", "hero-orbit", "turntable", "exploded-view"] as const;
export type Preset = (typeof PRESETS)[number];

export interface StageOptions {
  model: string;
  projectDir: string;
  preset: Preset;
  duration?: number;
  background?: string;
  title?: string;
}

function head(bg: string): string {
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

const tail = `
    <script type="module">
      import "./assets/stereoframe.js";
    </script>
  </body>
</html>
`;

function titleBlock(title: string | undefined, t1: number): { anim: string; dom: string } {
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
              chromatic-aberration="0.14" grain="0.03" contrast="1.05" saturation="1.05">
      <sf-camera fov="34" position="-3 -0.8 5.2" look-at="0 0.1 0"></sf-camera>
      <sf-light type="hemisphere" color="#2a3450" intensity="0.5"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="2.6" position="4 6 5"></sf-light>
      <sf-light type="directional" color="#9db8ff" intensity="1.5" position="-5 2 -4"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.6"></sf-model>
      <sf-animate target="#m" verb="bounce-in" start="0.2" duration="1" ease="back.out"></sf-animate>
      <sf-animate target="#m" verb="turntable" rpm="2.4" start="0.5"></sf-animate>
      <sf-animate target="camera" verb="camera-path" look="none"
                  points="-3 -0.8 5.2, -1.8 0 4.4, -0.7 0.5 3.9, 0.25 0.7 3.7"
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
              grain="0.025" contrast="1.03" saturation="1.05">
      <sf-camera fov="34" position="0 0.6 5" look-at="0 0 0"></sf-camera>
      <sf-light preset="studio"></sf-light>
      <sf-model id="m" src="assets/${model}" fit="2.6"></sf-model>
      <sf-animate target="#m" verb="turntable" rpm="1.4"></sf-animate>
      <sf-animate target="camera" verb="orbit" around="0 0 0" radius="5"
                  from="-38deg" to="38deg" height="0.6" start="0" duration="${d}"
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
              grain="0.02" contrast="1.03">
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

const TEMPLATES: Record<Preset, (m: string, d: number, bg: string, t?: string) => string> = {
  "reveal": reveal,
  "hero-orbit": heroOrbit,
  "turntable": turntable,
  "exploded-view": explodedView,
};

const DEFAULT_BG: Record<Preset, string> = {
  "reveal": "#0a0a0e",
  "hero-orbit": "#16181c",
  "turntable": "#15171b",
  "exploded-view": "#14161a",
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
  const html = TEMPLATES[opts.preset](modelFile, d, bg, opts.title);
  writeFileSync(join(dir, "index.html"), html);

  return dir;
}
