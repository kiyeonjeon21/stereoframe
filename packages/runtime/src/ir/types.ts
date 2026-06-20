/**
 * Stereoframe IR — the intermediate representation between the <sf-*> surface
 * and the three.js backend.
 *
 * INVARIANT: every value here is plain JSON data. No functions, ever. The IR is
 * fully serializable (`JSON.stringify(scene)`), so it can be inspected, linted,
 * diffed, and round-tripped. All motion math lives in `evaluate.ts`; the IR only
 * names *what* moves, *how*, and *when* — never *the computation*.
 *
 * Spatial half = `nodes` (rest poses + identity). Temporal half = `timeline`
 * (windowed parametric drivers, composed) + `behaviors` (continuous, additive).
 * `compile()` flattens the timeline to per-channel segments; `evaluate(t)` is a
 * pure function that, per channel, holds the segment active at `t`.
 */

export type Vec3 = [number, number, number];

/** The channel a driver writes. Transform channels (position/rotation/scale/fov)
 *  feed node transforms; opacity/material feed FrameState.materials. One driver
 *  may own more than one (a path with orient writes position + rotation). */
export type Channel = "position" | "rotation" | "scale" | "fov" | "opacity" | "material" | "light";

/** A variant's material endpoint — only the props it changes are set. */
export interface MaterialState {
  color?: string;
  roughness?: number;
  metalness?: number;
}

/** A light state endpoint (day↔night) — only the props it changes are set. */
export interface LightState {
  intensity?: number;
  color?: string;
}

/** A named state's sparse per-node override (transform + material + light). */
export interface StateOverride {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  color?: string;
  roughness?: number;
  metalness?: number;
  intensity?: number;
}

/** A node's rest pose + identity in the spatial graph.
 *  rotation is Euler radians; orientation tweens (path aim) are converted to a
 *  quaternion internally then back to a compatible Euler for the backend. */
export interface NodeBase {
  id: string;
  kind: "group" | "model" | "mesh" | "camera" | "light";
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** Camera only — vertical FOV in degrees. */
  fov?: number;
}

/** Windowed parametric motions. Driver params only — start/duration/ease are
 *  assigned by the timeline that *places* the driver. A `target`/`around`/
 *  `toward`/`subject` of "camera" addresses the camera node. */
export type Driver =
  | { kind: "orbit"; target: string; around: string | Vec3; radius: number; fromDeg: number; toDeg: number; height: number }
  | { kind: "move"; target: string; from?: Vec3; to: Vec3 }
  | { kind: "dolly"; target: string; toward: string | Vec3; distance: number }
  | { kind: "zoom"; target: string; from: number; to: number }
  | { kind: "bounce-in"; target: string }
  | { kind: "fade-in"; target: string; rise?: number }
  /** Generic transform tween (used by named-state transitions). */
  | { kind: "tween"; target: string; channel: "position" | "rotation" | "scale"; from: Vec3; to: Vec3 }
  /** One link of a variant chain (sorted by start; from = previous link's to). */
  | { kind: "variant"; target: string; materialName?: string; from: MaterialState; to: MaterialState }
  /** Light state transition (intensity/color), chained like variant. */
  | { kind: "light-tween"; target: string; from: LightState; to: LightState }
  | { kind: "follow"; target: string; subject: string; offset: Vec3 }
  | { kind: "path"; target: string; points: Vec3[]; closed: boolean; orient: "ahead" | "none" };

/** Continuous, additive motions — composed on top of the rest pose and any timeline
 *  drivers. `pivot` (a point in the target's parent space) spins the geometry about
 *  that point so an off-center part (a wheel) turns in place. Optional window:
 *  `from`/`until` (seconds; default 0/∞) gate the behavior; `ramp` (seconds; default
 *  0) eases its contribution in/out at the window edges (linear trapezoid). Defaults
 *  reproduce the always-on math exactly. */
export interface BehaviorWindow {
  from?: number;
  until?: number;
  ramp?: number;
}
export type Behavior =
  | ({ kind: "turntable"; target: string; rpm: number; axis: "x" | "y" | "z"; pivot?: Vec3 } & BehaviorWindow)
  | ({ kind: "float"; target: string; amplitude: number; period: number } & BehaviorWindow)
  | ({ kind: "sway"; target: string; amount: number; period: number } & BehaviorWindow);

/** Composable timeline. Leaves (`clip`/`wait`) carry duration; combinators
 *  (`seq`/`par`/`stagger`/`beat`) place them in time. Durations are inferred
 *  bottom-up at compile, so authors never hand-compute absolute `start`s. */
export type TimelineIR =
  | { kind: "seq"; children: TimelineIR[] }
  | { kind: "par"; children: TimelineIR[] }
  | { kind: "stagger"; interval: number; children: TimelineIR[] }
  | { kind: "beat"; name: string; at?: number; gap?: number; scale?: number; children: TimelineIR[] }
  | { kind: "wait"; duration: number; label?: string }
  | { kind: "clip"; driver: Driver; duration: number; ease?: string; label?: string };

export interface SceneIR {
  nodes: NodeBase[];
  timeline?: TimelineIR;
  behaviors: Behavior[];
  /** Explicit total duration (seconds); compile uses max(this, timeline end). */
  duration?: number;
}

// ── compiled form ───────────────────────────────────────────────────────────

/** A driver with resolved absolute timing. */
export interface Segment {
  driver: Driver;
  start: number;
  duration: number;
  ease: string;
  label?: string;
}

export interface Span {
  t0: number;
  t1: number;
}

export interface CompiledIR {
  nodes: Map<string, NodeBase>;
  /** Per-channel segments, key = `"<nodeId>.<channel>"`, sorted by start. At any
   *  `t` the channel holds the last segment that has started (rest pose before
   *  the first) — so sequential moves don't clobber each other. */
  segments: Map<string, Segment[]>;
  behaviors: Behavior[];
  duration: number;
  labelTimes: Map<string, Span>;
  beatTimes: Map<string, Span>;
}

/** The channels a driver writes (registered under each at compile). */
export function driverChannels(driver: Driver): Channel[] {
  switch (driver.kind) {
    case "zoom":
      return ["fov"];
    case "bounce-in":
      return ["scale"];
    case "fade-in":
      return ["opacity"];
    case "variant":
      return ["material"];
    case "light-tween":
      return ["light"];
    case "tween":
      return [driver.channel];
    case "path":
      return driver.orient === "ahead" ? ["position", "rotation"] : ["position"];
    default:
      return ["position"];
  }
}

/** Reference drivers read other nodes' evaluated poses → resolved in pass 2. */
export function isReferenceDriver(driver: Driver): boolean {
  return driver.kind === "orbit" || driver.kind === "dolly" || driver.kind === "follow";
}

/** Entrance drivers hold their `from`-state before their window (scale 0 / opacity
 *  0), unlike a mid-timeline tween which rests until it starts. */
export function isEntranceDriver(driver: Driver): boolean {
  return driver.kind === "bounce-in" || driver.kind === "fade-in";
}

// ── evaluated form ───────────────────────────────────────────────────────────

export interface NodeTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** Per-node material state at `t`. Color is left as from/to/mix so the backend
 *  lerps with THREE.Color (byte-identical to legacy); scalars are pre-lerped. */
export interface MaterialFrame {
  /** Fade factor 0..1 (fade-in) applied to every material's opacity under the node. */
  opacity?: number;
  /** Restrict variant writes to this material name (else all). */
  materialName?: string;
  roughness?: number;
  metalness?: number;
  color?: { from: string; to: string; mix: number };
}

/** Per-light state at `t`. Intensity is pre-lerped; color is left as from/to/mix
 *  so the backend lerps with THREE.Color (matches the material path). */
export interface LightFrame {
  intensity?: number;
  color?: { from: string; to: string; mix: number };
}

/** The frame at time `t` — a pure function of `t`. The backend applies this to
 *  three.js objects (`nodes` by id) + the camera, then composes world matrices. */
export interface FrameState {
  nodes: Map<string, NodeTransform>;
  camera: { position?: Vec3; fov?: number };
  materials: Map<string, MaterialFrame>;
  lights: Map<string, LightFrame>;
}
