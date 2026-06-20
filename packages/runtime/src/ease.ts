/**
 * Easing functions with GSAP-compatible names so the markup vocabulary
 * matches what LLMs already know from GSAP ("power2.inOut", "back.out", …).
 * All are pure p∈[0,1] → value functions (Penner equations).
 */

export type EaseFn = (p: number) => number;

function powerIn(n: number): EaseFn {
  return (p) => Math.pow(p, n);
}
function powerOut(n: number): EaseFn {
  return (p) => 1 - Math.pow(1 - p, n);
}
function powerInOut(n: number): EaseFn {
  return (p) => (p < 0.5 ? Math.pow(2 * p, n) / 2 : 1 - Math.pow(2 * (1 - p), n) / 2);
}

const BACK_OVERSHOOT = 1.70158;

const EASES: Record<string, EaseFn> = {
  "linear": (p) => p,
  "none": (p) => p,

  "power1.in": powerIn(2),
  "power1.out": powerOut(2),
  "power1.inOut": powerInOut(2),
  "power2.in": powerIn(3),
  "power2.out": powerOut(3),
  "power2.inOut": powerInOut(3),
  "power3.in": powerIn(4),
  "power3.out": powerOut(4),
  "power3.inOut": powerInOut(4),
  "power4.in": powerIn(5),
  "power4.out": powerOut(5),
  "power4.inOut": powerInOut(5),

  "sine.in": (p) => 1 - Math.cos((p * Math.PI) / 2),
  "sine.out": (p) => Math.sin((p * Math.PI) / 2),
  "sine.inOut": (p) => -(Math.cos(Math.PI * p) - 1) / 2,

  "expo.in": (p) => (p === 0 ? 0 : Math.pow(2, 10 * p - 10)),
  "expo.out": (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  "expo.inOut": (p) =>
    p === 0
      ? 0
      : p === 1
        ? 1
        : p < 0.5
          ? Math.pow(2, 20 * p - 10) / 2
          : (2 - Math.pow(2, -20 * p + 10)) / 2,

  "circ.in": (p) => 1 - Math.sqrt(1 - p * p),
  "circ.out": (p) => Math.sqrt(1 - (p - 1) * (p - 1)),
  "circ.inOut": (p) =>
    p < 0.5
      ? (1 - Math.sqrt(1 - 4 * p * p)) / 2
      : (Math.sqrt(1 - Math.pow(-2 * p + 2, 2)) + 1) / 2,

  "back.in": (p) => p * p * ((BACK_OVERSHOOT + 1) * p - BACK_OVERSHOOT),
  "back.out": (p) => {
    const q = p - 1;
    return q * q * ((BACK_OVERSHOOT + 1) * q + BACK_OVERSHOOT) + 1;
  },
  "back.inOut": (p) => {
    const s = BACK_OVERSHOOT * 1.525;
    return p < 0.5
      ? (Math.pow(2 * p, 2) * ((s + 1) * 2 * p - s)) / 2
      : (Math.pow(2 * p - 2, 2) * ((s + 1) * (2 * p - 2) + s) + 2) / 2;
  },

  "elastic.out": (p) =>
    p === 0
      ? 0
      : p === 1
        ? 1
        : Math.pow(2, -10 * p) * Math.sin(((p * 10 - 0.75) * (2 * Math.PI)) / 3) + 1,

  "bounce.out": (p) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (p < 1 / d1) return n1 * p * p;
    if (p < 2 / d1) {
      const q = p - 1.5 / d1;
      return n1 * q * q + 0.75;
    }
    if (p < 2.5 / d1) {
      const q = p - 2.25 / d1;
      return n1 * q * q + 0.9375;
    }
    const q = p - 2.625 / d1;
    return n1 * q * q + 0.984375;
  },
};

// ── Easing-as-data: function-form eases (still pure p→value, serializable strings) ──

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** CSS/GSAP-style `cubic-bezier(x1,y1,x2,y2)`. Endpoints are fixed at (0,0)/(1,1), so
 *  e(0)=0 and e(1)=1 exactly. Solves Bx(t)=p by Newton-Raphson (bisection fallback),
 *  then returns By(t). Control x's are clamped to [0,1]; y may overshoot. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  x1 = clamp01(x1);
  x2 = clamp01(x2);
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-7) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 32; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : sampleY(solveX(p)));
}

/** `spring(stiffness?, damping?)` — closed-form damped oscillator (deterministic, pure
 *  f(p)): overshoots past 1 then settles. The raw oscillator only approaches 1 at p=1
 *  (like elastic), so the endpoint is LOCKED — `e'(p)=raw(p)+p*(1-raw(1))` — giving
 *  e(0)=0 and e(1)=1 exactly so a windowed tween settles precisely on `to`. */
function springEase(stiffness = 4, damping = 0.5): EaseFn {
  const k = Math.max(0.1, stiffness);
  const z = clamp01(damping);
  const omega = Math.sqrt(k) * 2 * Math.PI;
  const decay = 2 + z * 6;
  const raw = (p: number) => 1 - Math.exp(-decay * p) * Math.cos(omega * (1 - z) * p);
  const e1 = raw(1);
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : raw(p) + p * (1 - e1));
}

const EASE_FN = /^([a-z-]+)\(([^)]*)\)$/i;

function parseArgs(raw: string): number[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map(Number);
}

/** Parse a function-form ease string → EaseFn, or null if not a (valid) function form. */
function parseEaseFn(s: string): EaseFn | null {
  if (s === "spring") return springEase();
  const m = EASE_FN.exec(s);
  if (!m) return null;
  const fn = m[1]!.toLowerCase();
  const args = parseArgs(m[2]!);
  if (args.some(Number.isNaN)) return null;
  if (fn === "cubic-bezier") return args.length === 4 ? cubicBezier(args[0]!, args[1]!, args[2]!, args[3]!) : null;
  if (fn === "spring") return args.length <= 2 ? springEase(args[0], args[1]) : null;
  return null;
}

/** Resolves an ease string (named OR `cubic-bezier(...)`/`spring(...)`); unknown or
 *  malformed → the given default. */
export function getEase(name: string | null, fallback = "power1.out"): EaseFn {
  if (name) {
    const s = name.trim();
    const named = EASES[s];
    if (named) return named;
    const fn = parseEaseFn(s);
    if (fn) return fn;
  }
  return EASES[fallback] ?? EASES["linear"]!;
}

export const EASE_NAMES = Object.keys(EASES);

/** True if `s` is a known ease name or a well-formed `cubic-bezier(...)`/`spring(...)`
 *  function form. Used by lint (single source of truth with `getEase`). */
export function isValidEase(s: string): boolean {
  const t = s.trim();
  return t in EASES || parseEaseFn(t) !== null;
}
