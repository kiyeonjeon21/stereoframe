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

/** The transform channel a driver writes. One driver may own more than one
 *  (a path with orient writes both position and rotation). */
export type Channel = "position" | "rotation" | "scale" | "fov";

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
  | { kind: "follow"; target: string; subject: string; offset: Vec3 }
  | { kind: "path"; target: string; points: Vec3[]; closed: boolean; orient: "ahead" | "none" };

/** Continuous, additive motions (no window) — composed on top of the rest pose
 *  and any timeline drivers. `pivot` (a point in the target's parent space) spins
 *  the geometry about that point so an off-center part (a wheel) turns in place. */
export type Behavior =
  | { kind: "turntable"; target: string; rpm: number; axis: "x" | "y" | "z"; pivot?: Vec3 }
  | { kind: "float"; target: string; amplitude: number; period: number }
  | { kind: "sway"; target: string; amount: number; period: number };

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

/** The transform channels a driver writes (registered under each at compile). */
export function driverChannels(driver: Driver): Channel[] {
  switch (driver.kind) {
    case "zoom":
      return ["fov"];
    case "bounce-in":
      return ["scale"];
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

// ── evaluated form ───────────────────────────────────────────────────────────

export interface NodeTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/** The frame at time `t` — a pure function of `t`. The backend applies this to
 *  three.js objects (`nodes` by id) + the camera, then composes world matrices. */
export interface FrameState {
  nodes: Map<string, NodeTransform>;
  camera: { position?: Vec3; fov?: number };
}
