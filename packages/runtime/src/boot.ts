/**
 * Bootstraps every <sf-scene> on the page.
 *
 * Standalone mode: exposes `window.__stereoframe` ({ ready, duration, seek })
 * for the stereoframe CLI renderer, drives `.clip` visibility, and supports
 * `?sf-preview` wall-clock playback.
 *
 * HyperFrames embed mode (a `[data-composition-id]` root exists): gates
 * `window.__hf` until assets are ready and follows `hf-seek` events.
 */
import * as THREE from "three";
import { compileAnimations } from "./animate";
import { parseSeconds } from "./parse";
import { compileScene, sceneDuration } from "./scene";
import { installHfGate, installSeekListener, isStandalone, startPreviewLoop } from "./seek";

const STYLES = `
sf-scene { display: block; line-height: 0; }
sf-scene > canvas { display: block; }
sf-camera, sf-model, sf-mesh, sf-light, sf-env, sf-animate, sf-particles, sf-sky, sf-ocean, sf-swarm, sf-metaball { display: none; }
`;

function injectStyles(): void {
  if (document.getElementById("__stereoframe-styles")) return;
  const style = document.createElement("style");
  style.id = "__stereoframe-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Total video duration: max(shot start + shot duration) across scenes. */
function resolveDuration(hosts: HTMLElement[]): number {
  let total = 0;
  for (const host of hosts) {
    const start = parseSeconds(host.getAttribute("start"), 0);
    total = Math.max(total, start + sceneDuration(host));
  }
  if (total <= 0) {
    console.warn('[stereoframe] no duration found; add duration="<seconds>" to <sf-scene>. Using 5s.');
    return 5;
  }
  return total;
}

export async function boot(): Promise<void> {
  injectStyles();
  const hosts = Array.from(document.querySelectorAll<HTMLElement>("sf-scene"));
  if (hosts.length === 0) return;

  const standalone = isStandalone();

  // Synchronous prologue (embed mode): the gate must exist before the
  // HyperFrames producer bridge wires up the engine-facing __hf object.
  const gate = standalone ? null : installHfGate();
  const duration = resolveDuration(hosts);
  const scenes = hosts.map(compileScene);
  const controller = installSeekListener(scenes, { duration, standalone });

  await Promise.all(scenes.map((s) => s.ready));
  for (const s of scenes) compileAnimations(s);
  runEscapeHatchScripts(scenes);

  controller.markReady();
  gate?.open();

  if (standalone && new URLSearchParams(location.search).has("sf-preview")) {
    startPreviewLoop(duration);
  }
}

/**
 * Escape hatch: <script type="stereoframe"> bodies run once after assets are
 * ready, with an `sf` API bound to the first scene. Code must stay a pure
 * function of seek time — same determinism rules as the markup verbs.
 */
function runEscapeHatchScripts(scenes: ReturnType<typeof compileScene>[]): void {
  const first = scenes[0];
  if (!first) return;
  const sf = {
    // The full three.js namespace — build custom geometry, materials, and
    // GLSL shaders that the markup vocabulary can't express. Drive any
    // uniform from `onSeek(t)` to stay deterministic.
    THREE,
    scene: first.scene,
    camera: first.camera,
    renderer: first.renderer,
    width: first.width,
    height: first.height,
    objects: first.objectsById,
    scenes,
    onSeek: (fn: (t: number) => void) => {
      first.seekFns.push(fn);
    },
  };
  for (const el of Array.from(document.querySelectorAll('script[type="stereoframe"]'))) {
    try {
      new Function("sf", el.textContent ?? "")(sf);
    } catch (err) {
      console.error("[stereoframe] escape-hatch script failed:", err);
    }
  }
}
