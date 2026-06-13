/**
 * Attribute parsing helpers. All parsing is pure so it can be unit-tested
 * without a DOM or a renderer.
 */

export function parseNumber(value: string | null, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Parses "x y z" (whitespace-separated). Missing components fall back per-axis. */
export function parseVec3(
  value: string | null,
  fallback: [number, number, number],
): [number, number, number] {
  if (value == null || value.trim() === "") return [...fallback];
  const parts = value.trim().split(/\s+/).map(Number);
  return [
    Number.isFinite(parts[0]) ? parts[0]! : fallback[0],
    Number.isFinite(parts[1]) ? parts[1]! : fallback[1],
    Number.isFinite(parts[2]) ? parts[2]! : fallback[2],
  ];
}

/** Parses "1.5" into [1.5, 1.5, 1.5], or "1 2 3" into [1, 2, 3]. */
export function parseScale(value: string | null): [number, number, number] {
  if (value == null || value.trim() === "") return [1, 1, 1];
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length === 1 && Number.isFinite(parts[0])) {
    return [parts[0]!, parts[0]!, parts[0]!];
  }
  return parseVec3(value, [1, 1, 1]);
}

/** Degrees in markup, radians in three.js. Accepts "45" or "45deg". */
export function parseAngleDeg(value: string | null, fallbackDeg: number): number {
  if (value == null || value.trim() === "") return fallbackDeg;
  const n = Number(value.trim().replace(/deg$/i, ""));
  return Number.isFinite(n) ? n : fallbackDeg;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Parses rotation attribute "x y z" in degrees to radians. */
export function parseRotationRad(value: string | null): [number, number, number] {
  const deg = parseVec3(value, [0, 0, 0]);
  return [degToRad(deg[0]), degToRad(deg[1]), degToRad(deg[2])];
}

/** "#0f172a" | "0x0f172a" | named colors pass through to THREE.Color. */
export function parseColorString(value: string | null, fallback: string): string {
  if (value == null || value.trim() === "") return fallback;
  return value.trim();
}

/** data-start / data-duration are seconds in hyperframes; keep the same unit. */
export function parseSeconds(value: string | null, fallback: number): number {
  return parseNumber(value, fallback);
}
