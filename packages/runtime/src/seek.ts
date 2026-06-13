/**
 * The single seek path. Everything rendered is a pure function of `t`
 * (seconds): verb timelines, mixers, particles, DOM clips, camera framing.
 *
 * Two host modes share this module:
 *  - STANDALONE (default): the stereoframe CLI drives `window.__stereoframe`
 *    — our own protocol: { ready, duration, width, height, seek }. We also
 *    drive `.clip` element visibility ourselves.
 *  - HYPERFRAMES EMBED: detected via a `[data-composition-id]` root. We
 *    listen to `hf-seek`, gate `window.__hf` until assets are ready, and
 *    leave DOM clips to the HyperFrames runtime. That contract is
 *    v0/experimental upstream, so all of it stays isolated in this file.
 */
import { Vector3 } from "three";
import { canvasFingerprint, collectDiagnostics, type SceneDiagnostics } from "./diagnostics";
import type { CompiledScene } from "./scene";
import { parseSeconds } from "./parse";
import { shotState } from "./shots";

const _tmp = new Vector3();

export interface StereoframeProtocol {
  version: string;
  ready: boolean;
  duration: number;
  width: number;
  height: number;
  scenes: CompiledScene[];
  seek: (t: number) => void;
  /** Seeks to t, then returns per-scene inspection facts (for validate). */
  diagnostics: (t: number) => SceneDiagnostics[];
  /** Seeks to t, then returns an exact fingerprint of the frame (idempotency probe). */
  fingerprint: (t: number) => string;
}

declare global {
  interface Window {
    __hfThreeTime?: number;
    __stereoframe?: StereoframeProtocol;
  }
}

/** True when no HyperFrames composition root exists on the page. */
export function isStandalone(): boolean {
  return document.querySelector("[data-composition-id]") === null;
}

/**
 * HYPERFRAMES EMBED ONLY — hides `window.__hf` until assets are ready.
 *
 * `window.__hf = { duration, seek }` is the protocol object the HyperFrames
 * render engine polls before capturing frames. DOMContentLoaded does NOT
 * wait for module top-level await (measured), so without this trap the
 * engine's first seek of every capture session can arrive before our
 * GLB/HDRI/shader preload finishes and capture a blank canvas.
 */
export function installHfGate(): { open: () => void } {
  let open = false;
  const win = window as unknown as Record<string, unknown>;
  let real: unknown = win.__hf;
  try {
    Object.defineProperty(window, "__hf", {
      configurable: true,
      enumerable: true,
      get: () => (open ? real : undefined),
      set: (v) => {
        real = v;
      },
    });
  } catch {
    open = true; // non-configurable property: fall back to no gating
  }
  return {
    open: () => {
      open = true;
    },
  };
}

export function applySeek(compiled: CompiledScene, t: number): void {
  const time = Math.max(0, Number(t) || 0);

  // 1. Animation verbs (analytic writers, document order)
  for (const fn of compiled.seekFns) fn(time);

  // 2. Late writers — camera follow must observe subjects already moved.
  for (const fn of compiled.lateSeekFns) fn(time);

  // 3. GLTF clip mixers — setTime is an absolute, idempotent seek as long as
  //    actions stay play()'d with explicit weights (configured at compile).
  for (const mixer of compiled.mixers) mixer.setTime(time);

  // 4. Shader time uniforms (particles etc.) are pure functions of t.
  for (const u of compiled.timeUniforms) u.value = time;

  // 5. Camera framing happens after any camera-position writers above.
  const lookAt = compiled.lookAt;
  if (lookAt) {
    if ("object" in lookAt) {
      lookAt.object.getWorldPosition(_tmp);
      _tmp.x += lookAt.offset[0];
      _tmp.y += lookAt.offset[1];
      _tmp.z += lookAt.offset[2];
      compiled.camera.lookAt(_tmp);
    } else {
      compiled.camera.lookAt(lookAt.point[0], lookAt.point[1], lookAt.point[2]);
    }
  }

  if (compiled.post) compiled.post.render(time);
  else compiled.renderer.render(compiled.scene, compiled.camera);
}

/**
 * STANDALONE ONLY — `.clip` elements with data-start/data-duration (seconds)
 * become visible only inside their window, as a pure function of t.
 */
function buildDomClipWriter(): (t: number) => void {
  const clips = Array.from(document.querySelectorAll<HTMLElement>(".clip[data-start]")).map(
    (el) => ({
      el,
      start: parseSeconds(el.dataset.start ?? null, 0),
      duration: parseSeconds(el.dataset.duration ?? null, Number.POSITIVE_INFINITY),
    }),
  );
  return (t) => {
    for (const c of clips) {
      const visible = t >= c.start && t < c.start + c.duration;
      c.el.style.visibility = visible ? "visible" : "hidden";
    }
  };
}

export interface SeekController {
  /** Called by boot once assets are ready; replays the last pending time. */
  markReady: () => void;
}

export function installSeekListener(
  scenes: CompiledScene[],
  opts: { duration: number; standalone: boolean },
): SeekController {
  let ready = false;
  let pendingT = typeof window.__hfThreeTime === "number" ? window.__hfThreeTime : 0;
  const domClips = opts.standalone ? buildDomClipWriter() : null;

  const seekAll = (t: number) => {
    pendingT = t;
    if (!ready) return; // replayed via markReady; never render half-loaded scenes
    domClips?.(t);
    for (const s of scenes) {
      // Shot windowing: each scene renders only inside its window, in
      // shot-local time. Skipping hidden shots is safe — all state is a
      // pure function of localT and is recomputed when the shot returns.
      const state = shotState(t, s.shot);
      s.canvas.style.display = state.visible ? "" : "none";
      s.canvas.style.opacity = state.opacity >= 1 ? "" : String(state.opacity);
      if (state.visible) applySeek(s, state.localT);
    }
  };

  if (!opts.standalone) {
    window.addEventListener("hf-seek", (e: Event) => {
      const detail = (e as CustomEvent<{ time?: number }>).detail;
      const t =
        detail && typeof detail.time === "number"
          ? detail.time
          : typeof window.__hfThreeTime === "number"
            ? window.__hfThreeTime
            : 0;
      seekAll(t);
    });
  }

  const first = scenes[0];
  const protocol: StereoframeProtocol = {
    version: "0.2.0",
    ready: false,
    duration: opts.duration,
    width: first?.width ?? 1920,
    height: first?.height ?? 1080,
    scenes,
    seek: seekAll,
    diagnostics: (t) => {
      seekAll(t); // same task as the canvas reads below — no preserveDrawingBuffer needed
      return collectDiagnostics(scenes, t);
    },
    fingerprint: (t) => {
      seekAll(t);
      return canvasFingerprint(scenes);
    },
  };
  window.__stereoframe = protocol;

  return {
    markReady: () => {
      ready = true;
      protocol.ready = true;
      seekAll(typeof window.__hfThreeTime === "number" ? window.__hfThreeTime : pendingT);
    },
  };
}

/**
 * STANDALONE preview mode (`?sf-preview` in the URL): loops playback on the
 * wall clock. Preview only — renders always go through explicit seeks.
 */
export function startPreviewLoop(duration: number): void {
  const t0 = performance.now();
  const tick = () => {
    const t = ((performance.now() - t0) / 1000) % Math.max(0.001, duration);
    window.__stereoframe?.seek(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
