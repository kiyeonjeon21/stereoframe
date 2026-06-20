/**
 * evaluate(CompiledIR, t) → FrameState.
 *
 * Pure, three.js-free, DOM-free — the determinism boundary. The frame is a
 * function of `t` alone: each call starts from the rest poses, so seeking any `t`
 * twice (or out of order) is identical.
 *
 * Per channel ("<node>.<group>") we hold the segment active at `t` — actually the
 * last segment that has started; before the first, the channel keeps its rest
 * value. (This fixes a legacy quirk where a not-yet-started driver could clobber
 * an active one — see design doc / plan, HYBRID parity.)
 *
 * Two passes: (1) independent drivers + additive behaviors resolve every node's
 * pose; (2) reference drivers (orbit/dolly/follow) read those evaluated poses, so
 * the camera can orbit/track a moving subject (dynamic centers).
 */
import { getEase } from "../ease";
import { eulerToQuat, quatToEuler, slerp } from "./quat";
import {
  isEntranceDriver,
  isReferenceDriver,
  type Behavior,
  type Channel,
  type CompiledIR,
  type Driver,
  type FrameState,
  type LightFrame,
  type MaterialFrame,
  type NodeBase,
  type NodeTransform,
  type Segment,
  type Vec3,
} from "./types";

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

function transformFrom(n: NodeBase): NodeTransform {
  return { position: [...n.position] as Vec3, rotation: [...n.rotation] as Vec3, scale: [...n.scale] as Vec3 };
}

/** Eased progress within a window, clamped to [0,1]. duration<=0 → step at start. */
function progress(t: number, seg: Segment): number {
  if (seg.duration <= 0) return t < seg.start ? 0 : 1;
  const p = (t - seg.start) / seg.duration;
  return getEase(seg.ease)(Math.min(1, Math.max(0, p)));
}

/** The last segment that has started by `t` (rest pose before the first). */
function held(list: Segment[], t: number): Segment | null {
  let found: Segment | null = null;
  for (const seg of list) {
    if (seg.start <= t) found = seg;
    else break; // sorted by start
  }
  return found;
}

/** Held segment, or — before the first starts — the earliest segment if it's an
 *  entrance (so it holds its `from`-state, e.g. scale 0 / opacity 0). */
function heldOrEntrance(list: Segment[], t: number): Segment | null {
  const h = held(list, t);
  if (h) return h;
  const first = list[0];
  return first && isEntranceDriver(first.driver) ? first : null;
}

interface EvalCtx {
  nodes: Map<string, NodeBase>;
  transforms: Map<string, NodeTransform>;
  materials: Map<string, MaterialFrame>;
  lights: Map<string, LightFrame>;
  cameraFov: number | undefined;
}

function materialOf(ctx: EvalCtx, id: string): MaterialFrame {
  let m = ctx.materials.get(id);
  if (!m) ctx.materials.set(id, (m = {}));
  return m;
}

function lightOf(ctx: EvalCtx, id: string): LightFrame {
  let l = ctx.lights.get(id);
  if (!l) ctx.lights.set(id, (l = {}));
  return l;
}

/** Resolve an `around`/`toward`/`subject` reference to a point: a literal, or a
 *  node's evaluated (pass-1) position so centers track moving subjects. */
function resolveRef(ref: string | Vec3, ctx: EvalCtx): Vec3 {
  if (Array.isArray(ref)) return ref;
  const tr = ctx.transforms.get(ref);
  if (tr) return tr.position;
  return ctx.nodes.get(ref)?.position ?? [0, 0, 0];
}

function applyDriver(driver: Driver, channel: Channel, t: number, seg: Segment, ctx: EvalCtx): void {
  const tr = ctx.transforms.get(driver.target);
  const p = progress(t, seg);

  switch (driver.kind) {
    case "orbit": {
      if (!tr || channel !== "position") return;
      const c = resolveRef(driver.around, ctx);
      const az = driver.fromDeg * DEG + (driver.toDeg - driver.fromDeg) * DEG * p;
      tr.position[0] = c[0] + driver.radius * Math.sin(az);
      tr.position[1] = c[1] + driver.height;
      tr.position[2] = c[2] + driver.radius * Math.cos(az);
      return;
    }
    case "move": {
      if (!tr || channel !== "position") return;
      const base = ctx.nodes.get(driver.target)?.position ?? [0, 0, 0];
      const from = driver.from ?? base;
      tr.position[0] = from[0] + (driver.to[0] - from[0]) * p;
      tr.position[1] = from[1] + (driver.to[1] - from[1]) * p;
      tr.position[2] = from[2] + (driver.to[2] - from[2]) * p;
      return;
    }
    case "dolly": {
      if (!tr || channel !== "position") return;
      const base = ctx.nodes.get(driver.target)?.position ?? [0, 0, 0];
      const c = resolveRef(driver.toward, ctx);
      const dx = c[0] - base[0];
      const dy = c[1] - base[1];
      const dz = c[2] - base[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const d = driver.distance * p;
      tr.position[0] = base[0] + (dx / len) * d;
      tr.position[1] = base[1] + (dy / len) * d;
      tr.position[2] = base[2] + (dz / len) * d;
      return;
    }
    case "zoom": {
      if (channel === "fov") ctx.cameraFov = driver.from + (driver.to - driver.from) * p;
      return;
    }
    case "follow": {
      if (!tr || channel !== "position") return;
      const s = resolveRef(driver.subject, ctx);
      tr.position[0] = s[0] + driver.offset[0];
      tr.position[1] = s[1] + driver.offset[1];
      tr.position[2] = s[2] + driver.offset[2];
      return;
    }
    case "bounce-in": {
      // Scale-in entrance: rest × eased progress (p clamps to 0 before the window).
      if (!tr || channel !== "scale") return;
      const base = ctx.nodes.get(driver.target)?.scale ?? [1, 1, 1];
      tr.scale[0] = base[0] * p;
      tr.scale[1] = base[1] * p;
      tr.scale[2] = base[2] * p;
      return;
    }
    case "fade-in": {
      // Opacity factor 0→1 (entrance). Backend multiplies each base opacity by it.
      if (channel !== "opacity") return;
      materialOf(ctx, driver.target).opacity = p;
      return;
    }
    case "variant": {
      // Material colorway link: scalars pre-lerped here; color left as from/to/mix
      // for the backend to lerp with THREE.Color (byte-identical to legacy).
      if (channel !== "material") return;
      const m = materialOf(ctx, driver.target);
      if (driver.materialName != null) m.materialName = driver.materialName;
      if (driver.to.color != null && driver.from.color != null) {
        m.color = { from: driver.from.color, to: driver.to.color, mix: p };
      }
      if (driver.to.roughness != null && driver.from.roughness != null) {
        m.roughness = driver.from.roughness + (driver.to.roughness - driver.from.roughness) * p;
      }
      if (driver.to.metalness != null && driver.from.metalness != null) {
        m.metalness = driver.from.metalness + (driver.to.metalness - driver.from.metalness) * p;
      }
      return;
    }
    case "light-tween": {
      // Light state link (day↔night): intensity pre-lerped; color left as
      // from/to/mix for the backend to lerp with THREE.Color.
      if (channel !== "light") return;
      const l = lightOf(ctx, driver.target);
      if (driver.to.intensity != null && driver.from.intensity != null) {
        l.intensity = driver.from.intensity + (driver.to.intensity - driver.from.intensity) * p;
      }
      if (driver.to.color != null && driver.from.color != null) {
        l.color = { from: driver.from.color, to: driver.to.color, mix: p };
      }
      return;
    }
    case "tween": {
      // Generic transform tween (named-state transitions). Rotation slerps on the
      // shortest arc (Euler→quat→slerp→Euler, no gimbal flips); position/scale lerp
      // componentwise.
      if (!tr) return;
      if (driver.channel === "rotation") {
        tr.rotation = quatToEuler(slerp(eulerToQuat(driver.from), eulerToQuat(driver.to), p));
        return;
      }
      const v = tr[driver.channel];
      v[0] = driver.from[0] + (driver.to[0] - driver.from[0]) * p;
      v[1] = driver.from[1] + (driver.to[1] - driver.from[1]) * p;
      v[2] = driver.from[2] + (driver.to[2] - driver.from[2]) * p;
      return;
    }
    default:
      return; // path lowers in a later phase
  }
}

/** Window envelope ∈[0,1] at `t` (linear trapezoid: 0 outside [from,until], ramping
 *  0→1 over `ramp`s after `from` and 1→0 over `ramp`s before `until`). For amplitude
 *  behaviors (float/sway). Defaults (from 0, until ∞, ramp 0) ⇒ 1 for t>0. */
function behaviorEnv(t: number, from: number, until: number, ramp: number): number {
  if (t <= from || t >= until) return 0;
  const span = until - from;
  const r = Math.min(ramp, span / 2);
  if (r <= 0) return 1;
  if (t < from + r) return (t - from) / r;
  if (t > until - r) return (until - t) / r;
  return 1;
}

/** ∫ of the window envelope from `from` to min(t,until) — the "effective active
 *  seconds" for the accumulating turntable angle (so a ramped/windowed spin stays a
 *  closed-form pure f(t); after `until` it caps → the spin holds its final angle).
 *  Defaults (from 0, until ∞, ramp 0) ⇒ max(0,t), matching the legacy activeTime. */
function behaviorIntegral(t: number, from: number, until: number, ramp: number): number {
  const te = Math.min(t, until);
  if (te <= from) return 0;
  const x = te - from;
  const span = until - from;
  const r = Math.min(ramp, span / 2);
  if (r <= 0) return x;
  if (x <= r) return (x * x) / (2 * r);
  if (x <= span - r) return r / 2 + (x - r);
  return span - r - ((span - x) * (span - x)) / (2 * r);
}

function applyBehavior(b: Behavior, t: number, ctx: EvalCtx): void {
  const tr = ctx.transforms.get(b.target);
  if (!tr) return;
  const from = b.from ?? 0;
  const until = b.until ?? Infinity;
  const ramp = b.ramp ?? 0;

  switch (b.kind) {
    case "turntable": {
      const i = AXIS_INDEX[b.axis];
      // Angle integrates velocity × envelope (closed-form); holds after `until`.
      const ang = (b.rpm / 60) * TWO_PI * behaviorIntegral(t, from, until, ramp);
      tr.rotation[i] += ang;
      if (b.pivot) {
        const c = b.pivot;
        const dx = tr.position[0] - c[0];
        const dy = tr.position[1] - c[1];
        const dz = tr.position[2] - c[2];
        const s = Math.sin(ang);
        const co = Math.cos(ang);
        if (b.axis === "x") {
          tr.position[1] = c[1] + dy * co - dz * s;
          tr.position[2] = c[2] + dy * s + dz * co;
        } else if (b.axis === "y") {
          tr.position[0] = c[0] + dx * co + dz * s;
          tr.position[2] = c[2] - dx * s + dz * co;
        } else {
          tr.position[0] = c[0] + dx * co - dy * s;
          tr.position[1] = c[1] + dx * s + dy * co;
        }
      }
      return;
    }
    case "float": {
      const env = behaviorEnv(t, from, until, ramp);
      if (env === 0) return;
      const at = t - from; // phase elapsed within the window (frozen at edges by env)
      tr.position[1] += env * b.amplitude * Math.sin((TWO_PI / Math.max(1e-4, b.period)) * at);
      return;
    }
    case "sway": {
      const env = behaviorEnv(t, from, until, ramp);
      if (env === 0) return;
      const at = t - from;
      const w = TWO_PI / Math.max(1e-4, b.period);
      const a = b.amount * env;
      tr.rotation[2] += a * Math.sin(w * at);
      tr.rotation[0] += a * 0.6 * Math.sin(w * 0.73 * at + 1.7);
      tr.rotation[1] += a * 0.4 * Math.sin(w * 0.51 * at + 0.4);
      tr.position[0] += a * 0.25 * Math.sin(w * 0.62 * at + 2.1);
      tr.position[1] += a * 0.2 * Math.sin(w * 0.83 * at);
      return;
    }
  }
}

function channelOf(key: string): Channel {
  return key.slice(key.lastIndexOf(".") + 1) as Channel;
}

export function evaluate(compiled: CompiledIR, t: number): FrameState {
  const time = Math.max(0, Number(t) || 0);

  const transforms = new Map<string, NodeTransform>();
  const materials = new Map<string, MaterialFrame>();
  const lights = new Map<string, LightFrame>();
  let cameraFov: number | undefined;
  for (const [id, n] of compiled.nodes) {
    transforms.set(id, transformFrom(n));
    if (n.kind === "camera") cameraFov = n.fov;
  }
  const ctx: EvalCtx = { nodes: compiled.nodes, transforms, materials, lights, cameraFov };

  // Pass 1: independent drivers (held/entrance per channel) then additive behaviors.
  for (const [key, list] of compiled.segments) {
    const seg = heldOrEntrance(list, time);
    if (!seg || isReferenceDriver(seg.driver)) continue;
    applyDriver(seg.driver, channelOf(key), time, seg, ctx);
  }
  for (const b of compiled.behaviors) applyBehavior(b, time, ctx);

  // Pass 2: reference drivers read pass-1 poses (dynamic centers).
  for (const [key, list] of compiled.segments) {
    const seg = held(list, time);
    if (!seg || !isReferenceDriver(seg.driver)) continue;
    applyDriver(seg.driver, channelOf(key), time, seg, ctx);
  }

  const cam = transforms.get("camera");
  return {
    nodes: transforms,
    camera: { position: cam ? cam.position : undefined, fov: ctx.cameraFov },
    materials,
    lights,
  };
}
