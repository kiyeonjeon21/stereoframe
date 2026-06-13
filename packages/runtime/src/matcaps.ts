/**
 * Procedural matcap textures — a material capture (the lit look of a sphere)
 * baked into one image, so a MeshMatcapMaterial reads as that material with
 * zero lighting setup. These are drawn on an offscreen 2D canvas (no asset),
 * giving instant distinctive, designer-grade looks.
 *
 * A matcap is sampled by view-space normal: the center of the image is the
 * surface facing the camera, the rim is grazing angle. So radial gradients
 * map to "core → rim" shading.
 */
import { CanvasTexture, SRGBColorSpace, type Texture } from "three";

const SIZE = 256;
const cache = new Map<string, Texture>();

function make(draw: (ctx: CanvasRenderingContext2D, r: number) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, SIZE, SIZE);
  // clip to the sphere disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  draw(ctx, SIZE / 2);
  ctx.restore();
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function radial(ctx: CanvasRenderingContext2D, r: number, stops: Array<[number, string]>): void {
  // off-center highlight (top-left) like a key light
  const g = ctx.createRadialGradient(r * 0.7, r * 0.6, r * 0.05, r, r, r * 1.25);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

const BUILDERS: Record<string, (ctx: CanvasRenderingContext2D, r: number) => void> = {
  pearl: (ctx, r) =>
    radial(ctx, r, [
      [0, "#ffffff"],
      [0.45, "#e9ecf5"],
      [0.8, "#aab0c8"],
      [1, "#6b7090"],
    ]),
  chrome: (ctx, r) => {
    // vertical studio gradient + bright streak = polished metal
    const g = ctx.createLinearGradient(0, 0, 0, SIZE);
    g.addColorStop(0, "#dfe6ef");
    g.addColorStop(0.45, "#566074");
    g.addColorStop(0.5, "#aeb8c8");
    g.addColorStop(0.55, "#3a4254");
    g.addColorStop(1, "#10141c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
    radial(ctx, r, [
      [0, "rgba(255,255,255,0.9)"],
      [0.2, "rgba(255,255,255,0.0)"],
      [1, "rgba(0,0,0,0)"],
    ]);
  },
  clay: (ctx, r) =>
    radial(ctx, r, [
      [0, "#f6d9c6"],
      [0.5, "#d99a7e"],
      [0.85, "#9c5b48"],
      [1, "#5e3328"],
    ]),
  iridescent: (ctx, r) => {
    // dark core, rainbow rim — oil-slick
    ctx.fillStyle = "#08060c";
    ctx.fillRect(0, 0, SIZE, SIZE);
    const ring = ctx.createRadialGradient(r, r, r * 0.45, r, r, r);
    ring.addColorStop(0.0, "rgba(8,6,12,1)");
    ring.addColorStop(0.55, "#1a1030");
    ring.addColorStop(0.7, "#2b6ccf");
    ring.addColorStop(0.8, "#28c6a8");
    ring.addColorStop(0.88, "#e8d24a");
    ring.addColorStop(0.95, "#e8568f");
    ring.addColorStop(1.0, "#7a3df0");
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, SIZE, SIZE);
  },
  holo: (ctx, r) => {
    const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, "#ff6ec7");
    g.addColorStop(0.35, "#7a5cff");
    g.addColorStop(0.6, "#2bd4ff");
    g.addColorStop(0.85, "#74ffd1");
    g.addColorStop(1, "#fff1a8");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
    radial(ctx, r, [
      [0, "rgba(255,255,255,0.7)"],
      [0.3, "rgba(255,255,255,0)"],
      [1, "rgba(0,0,0,0.35)"],
    ]);
  },
};

export const MATCAP_NAMES = Object.keys(BUILDERS);

/** Returns a cached procedural matcap texture by name (default: pearl). */
export function getMatcap(name: string | null): Texture {
  const key = name && BUILDERS[name] ? name : "pearl";
  let tex = cache.get(key);
  if (!tex) {
    tex = make(BUILDERS[key]!);
    cache.set(key, tex);
  }
  return tex;
}
