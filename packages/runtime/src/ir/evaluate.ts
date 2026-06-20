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
import {
  isReferenceDriver,
  type Behavior,
  type Channel,
  type CompiledIR,
  type Driver,
  type FrameState,
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

interface EvalCtx {
  nodes: Map<string, NodeBase>;
  transforms: Map<string, NodeTransform>;
  cameraFov: number | undefined;
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
    default:
      return; // bounce-in / path lower in Phase 2b
  }
}

function applyBehavior(b: Behavior, t: number, ctx: EvalCtx): void {
  const tr = ctx.transforms.get(b.target);
  if (!tr) return;
  const at = Math.max(0, t);

  switch (b.kind) {
    case "turntable": {
      const i = AXIS_INDEX[b.axis];
      const ang = (b.rpm / 60) * TWO_PI * at;
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
      tr.position[1] += b.amplitude * Math.sin((TWO_PI / Math.max(1e-4, b.period)) * at);
      return;
    }
    case "sway": {
      const w = TWO_PI / Math.max(1e-4, b.period);
      const a = b.amount;
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
  let cameraFov: number | undefined;
  for (const [id, n] of compiled.nodes) {
    transforms.set(id, transformFrom(n));
    if (n.kind === "camera") cameraFov = n.fov;
  }
  const ctx: EvalCtx = { nodes: compiled.nodes, transforms, cameraFov };

  // Pass 1: independent drivers (held per channel) then additive behaviors.
  for (const [key, list] of compiled.segments) {
    const seg = held(list, time);
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
  return { nodes: transforms, camera: { position: cam ? cam.position : undefined, fov: ctx.cameraFov } };
}
