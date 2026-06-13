/**
 * Shot windowing — pure math mapping global seek time to a scene's
 * visibility, local time, and crossfade opacity. Every sf-scene is a shot:
 * a single scene with start=0 behaves exactly like the pre-multishot
 * runtime (always visible, opacity 1, localT = t clamped to duration).
 */

export interface ShotSpec {
  /** Global start time in seconds. */
  start: number;
  /** Shot length in seconds. */
  duration: number;
  transition: "cut" | "crossfade";
  /** Crossfade ramp length in seconds (ignored for cut). */
  transitionDuration: number;
}

export interface ShotState {
  /** Whether this shot's canvas should be displayed (and rendered). */
  visible: boolean;
  /** Shot-local time: clamp(t - start, 0, duration). */
  localT: number;
  /** Canvas opacity (crossfade ramp at the shot's head; 1 otherwise). */
  opacity: number;
}

export function shotState(t: number, spec: ShotSpec): ShotState {
  const end = spec.start + spec.duration;
  const visible = t >= spec.start && t < end;
  const localT = Math.min(Math.max(t - spec.start, 0), spec.duration);
  let opacity = 1;
  if (visible && spec.transition === "crossfade" && spec.transitionDuration > 0) {
    opacity = Math.min(1, (t - spec.start) / spec.transitionDuration);
  }
  return { visible, localT, opacity };
}
