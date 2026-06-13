/**
 * Semantic animation verbs, compiled to pure per-seek writers.
 *
 * Pure module: no three.js, no DOM. Targets are structural ({position,
 * rotation, scale} with plain x/y/z), so every verb is unit-testable as a
 * plain function of `t`. Writers must stay pure functions of `t` — no
 * accumulated state, no wall clock, no RNG.
 */
import { getEase, type EaseFn } from "./ease";

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface TransformLike {
  position: XYZ;
  rotation: XYZ;
  scale: XYZ;
}

export type Writer = (t: number) => void;

export interface VerbTiming {
  /** Seconds; verb is inert before this. */
  start: number;
  /** Seconds; undefined = continuous (turntable, float). */
  duration?: number;
  ease: EaseFn;
}

/** Eased progress within the verb window, clamped to [0, 1]. */
function progress(t: number, timing: VerbTiming): number {
  const duration = timing.duration ?? 0;
  if (duration <= 0) return t < timing.start ? 0 : 1;
  const p = (t - timing.start) / duration;
  return timing.ease(Math.min(1, Math.max(0, p)));
}

/** Public progress helper for verbs implemented outside this module
 * (e.g. camera-path, which needs three.js curve math). */
export function easedProgress(t: number, timing: VerbTiming): number {
  return progress(t, timing);
}

/**
 * Per-instance stagger: a global raw progress [0,1] maps to an instance's
 * own [0,1] window. `delay` ∈ [0, span], `span` ∈ [0,1) is the fraction of
 * the global window consumed by staggering — instance i animates during
 * [delay, delay + (1 - span)]. Pure; apply easing to the result.
 */
export function staggeredProgress(raw: number, delay: number, span: number): number {
  const window = Math.max(1e-6, 1 - span);
  return Math.min(1, Math.max(0, (raw - delay) / window));
}

/** Active time for continuous verbs: seconds since start, never negative. */
function activeTime(t: number, timing: VerbTiming): number {
  return Math.max(0, t - timing.start);
}

export function makeTiming(opts: {
  start?: number | null;
  duration?: number | null;
  ease?: string | null;
  defaultEase?: string;
}): VerbTiming {
  return {
    start: opts.start ?? 0,
    duration: opts.duration ?? undefined,
    ease: getEase(opts.ease ?? null, opts.defaultEase ?? "power1.out"),
  };
}

/** Continuous spin around one local axis. rpm > 0 spins counter-clockwise.
 *  With `pivot` (a point in the target's parent space), the spin is *about that
 *  point* — the target's origin is counter-translated each frame so the geometry
 *  rotates in place. This makes per-part spin (e.g. a wheel) work even when the
 *  part's pivot isn't at its center (geometry authored in body space). */
export function turntable(
  target: TransformLike,
  timing: VerbTiming,
  opts: { rpm: number; axis: "x" | "y" | "z"; pivot?: XYZ },
): Writer {
  const base = target.rotation[opts.axis];
  const radPerSecond = (opts.rpm / 60) * Math.PI * 2;
  if (!opts.pivot) {
    return (t) => {
      target.rotation[opts.axis] = base + radPerSecond * activeTime(t, timing);
    };
  }
  // Rotate the origin→center offset by the same angle so the center stays fixed:
  // O_new = C + R·(O − C). R matches the Euler spin about `axis` (right-handed).
  const c = opts.pivot;
  const dx0 = target.position.x - c.x;
  const dy0 = target.position.y - c.y;
  const dz0 = target.position.z - c.z;
  const axis = opts.axis;
  return (t) => {
    const ang = radPerSecond * activeTime(t, timing);
    target.rotation[axis] = base + ang;
    const s = Math.sin(ang);
    const co = Math.cos(ang);
    if (axis === "x") {
      target.position.x = c.x + dx0;
      target.position.y = c.y + dy0 * co - dz0 * s;
      target.position.z = c.z + dy0 * s + dz0 * co;
    } else if (axis === "y") {
      target.position.x = c.x + dx0 * co + dz0 * s;
      target.position.y = c.y + dy0;
      target.position.z = c.z - dx0 * s + dz0 * co;
    } else {
      target.position.x = c.x + dx0 * co - dy0 * s;
      target.position.y = c.y + dx0 * s + dy0 * co;
      target.position.z = c.z + dz0;
    }
  };
}

/**
 * Moves a camera/object along a circular arc around a center point.
 * Azimuth 0° looks down +Z toward the center; angles increase
 * counter-clockwise when viewed from above.
 */
export function orbit(
  target: TransformLike,
  timing: VerbTiming,
  opts: {
    center: () => XYZ;
    radius: number;
    fromDeg: number;
    toDeg: number;
    height: number;
  },
): Writer {
  const fromRad = (opts.fromDeg * Math.PI) / 180;
  const toRad = (opts.toDeg * Math.PI) / 180;
  return (t) => {
    const az = fromRad + (toRad - fromRad) * progress(t, timing);
    const c = opts.center();
    target.position.x = c.x + opts.radius * Math.sin(az);
    target.position.z = c.z + opts.radius * Math.cos(az);
    target.position.y = c.y + opts.height;
  };
}

/** Moves the target toward (positive distance) a point along the line to it. */
export function dolly(
  target: TransformLike,
  timing: VerbTiming,
  opts: { toward: () => XYZ; distance: number },
): Writer {
  const start = { x: target.position.x, y: target.position.y, z: target.position.z };
  return (t) => {
    const c = opts.toward();
    const dx = c.x - start.x;
    const dy = c.y - start.y;
    const dz = c.z - start.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const d = opts.distance * progress(t, timing);
    target.position.x = start.x + (dx / len) * d;
    target.position.y = start.y + (dy / len) * d;
    target.position.z = start.z + (dz / len) * d;
  };
}

/** Scale-in entrance with an overshooting ease (default back.out). */
export function bounceIn(target: TransformLike, timing: VerbTiming): Writer {
  const base = { x: target.scale.x, y: target.scale.y, z: target.scale.z };
  return (t) => {
    const s = t < timing.start ? 0 : progress(t, timing);
    target.scale.x = base.x * s;
    target.scale.y = base.y * s;
    target.scale.z = base.z * s;
  };
}

/** Opacity ramp; the caller supplies the setter since materials are renderer-specific. */
export function fadeIn(
  setOpacity: (factor: number) => void,
  timing: VerbTiming,
): Writer {
  return (t) => {
    setOpacity(t < timing.start ? 0 : progress(t, timing));
  };
}

/** Linear-in-space translation from→to over the window (eased in time). */
export function move(
  target: TransformLike,
  timing: VerbTiming,
  opts: { from?: XYZ; to: XYZ },
): Writer {
  const from = opts.from ?? {
    x: target.position.x,
    y: target.position.y,
    z: target.position.z,
  };
  return (t) => {
    const p = progress(t, timing);
    target.position.x = from.x + (opts.to.x - from.x) * p;
    target.position.y = from.y + (opts.to.y - from.y) * p;
    target.position.z = from.z + (opts.to.z - from.z) * p;
  };
}

/**
 * Rigidly tracks a (moving) subject at a fixed world-space offset.
 * Continuous. Must run AFTER the subject's own writers — the binding layer
 * schedules follow in the late pass.
 */
export function follow(
  target: TransformLike,
  opts: { subject: () => XYZ; offset: XYZ },
): Writer {
  return () => {
    const s = opts.subject();
    target.position.x = s.x + opts.offset.x;
    target.position.y = s.y + opts.offset.y;
    target.position.z = s.z + opts.offset.z;
  };
}

/**
 * Crossfades between two animation-clip weights over the window.
 * The caller owns the actual weight assignment (renderer-specific);
 * before the window: from=1/to=0, after: from=0/to=1.
 */
export function crossfadeClips(
  setWeights: (fromWeight: number, toWeight: number) => void,
  timing: VerbTiming,
): Writer {
  return (t) => {
    const p = t < timing.start ? 0 : progress(t, timing);
    setWeights(1 - p, p);
  };
}

/** Gentle sinusoidal bob on Y. Continuous; pure function of t. */
export function float(
  target: TransformLike,
  timing: VerbTiming,
  opts: { amplitude: number; period: number },
): Writer {
  const baseY = target.position.y;
  const omega = (Math.PI * 2) / Math.max(0.0001, opts.period);
  return (t) => {
    target.position.y = baseY + opts.amplitude * Math.sin(omega * activeTime(t, timing));
  };
}

/**
 * Continuous secondary motion — a gentle multi-axis rotational sway (+ a
 * touch of positional drift) that makes a form feel alive rather than rigid.
 * Layered sines at incommensurate periods so it never looks like a loop.
 * Pure function of t.
 */
export function sway(
  target: TransformLike,
  timing: VerbTiming,
  opts: { amount: number; period: number },
): Writer {
  const base = {
    rx: target.rotation.x,
    ry: target.rotation.y,
    rz: target.rotation.z,
    px: target.position.x,
    py: target.position.y,
  };
  const w = (Math.PI * 2) / Math.max(0.0001, opts.period);
  const a = opts.amount;
  return (t) => {
    const s = activeTime(t, timing);
    target.rotation.z = base.rz + a * Math.sin(w * s);
    target.rotation.x = base.rx + a * 0.6 * Math.sin(w * 0.73 * s + 1.7);
    target.rotation.y = base.ry + a * 0.4 * Math.sin(w * 0.51 * s + 0.4);
    target.position.x = base.px + a * 0.25 * Math.sin(w * 0.62 * s + 2.1);
    target.position.y = base.py + a * 0.2 * Math.sin(w * 0.83 * s);
  };
}
