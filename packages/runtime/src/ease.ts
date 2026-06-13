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

/** Resolves an ease name; unknown names fall back to the given default. */
export function getEase(name: string | null, fallback = "power1.out"): EaseFn {
  if (name) {
    const fn = EASES[name.trim()];
    if (fn) return fn;
  }
  return EASES[fallback] ?? EASES["linear"]!;
}

export const EASE_NAMES = Object.keys(EASES);
