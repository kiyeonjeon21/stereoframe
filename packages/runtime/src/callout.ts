/**
 * <sf-callout> — spec-callout labels that track a 3D point.
 *
 * The signature product-film beat: a thin leader line from a feature to a
 * floating typographic label ("48MP · Main camera"). This is stereoframe's
 * DOM+3D hybrid at work — we `Vector3.project()` the tracked point against the
 * final camera each seek and position a real DOM label + an SVG leader over
 * the canvas. Orbit-only viewers can't render legible typography; AI video
 * can't keep it stable or deterministic. We can, and it stays a pure function
 * of `t` (so it never touches the seekability contract — the validator
 * fingerprints the WebGL canvas, not the overlay).
 *
 *   <sf-callout target="#m" part="2" value="48MP" text="Main camera"
 *               anchor="right" start="1.2" duration="0.8"></sf-callout>
 *
 * `target`/`part` reuse the same component boundary as explode/isolate, so a
 * callout points at the same thing you isolate. `point="x y z"` anchors a
 * fixed world point instead. Runs in `overlayFns` (after camera lookAt).
 */
import { Box3, Vector3 } from "three";
import { collectParts, resolvePartIndex } from "./animate";
import { getEase, type EaseFn } from "./ease";
import { parseSeconds, parseVec3 } from "./parse";
import type { CompiledScene } from "./scene";

const SVG_NS = "http://www.w3.org/2000/svg";

const STYLE_ID = "__stereoframe-callout-styles";
const CSS = `
.sf-callout-svg { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 49; }
.sf-callout-line { stroke: #f4f1e8; stroke-width: 1.5; stroke-linecap: round; }
.sf-callout-dot { fill: #f4f1e8; }
.sf-callout-label { position: fixed; color: #f4f1e8; white-space: nowrap; pointer-events: none; z-index: 50;
  text-shadow: 0 2px 16px rgba(0,0,0,0.65); font-family: inherit; }
.sf-callout-label .v { font-size: 30px; font-weight: 650; letter-spacing: 0.01em; line-height: 1.05; }
.sf-callout-label .t { font-size: 15px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.82; margin-top: 5px; }
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface Callout {
  worldPoint: (out: Vector3) => Vector3;
  dot: SVGCircleElement;
  line: SVGLineElement;
  label: HTMLDivElement;
  side: number; // -1 = label to the left, +1 = to the right
  start: number;
  dur: number;
  ease: EaseFn;
}

/** Resolve a callout's anchor: a tracked part/object center, or a fixed point. */
function resolveAnchor(
  compiled: CompiledScene,
  el: Element,
): ((out: Vector3) => Vector3) | null {
  const pointAttr = el.getAttribute("point");
  if (pointAttr) {
    const [x, y, z] = parseVec3(pointAttr, [0, 0, 0]);
    return (out) => out.set(x, y, z);
  }
  const targetSel = el.getAttribute("target");
  if (!targetSel || !targetSel.startsWith("#")) return null;
  const obj = compiled.objectsById.get(targetSel.slice(1));
  if (!obj) return null;

  let node = obj;
  const partAttr = el.getAttribute("part");
  if (partAttr !== null) {
    const parts = collectParts(obj);
    node = parts[resolvePartIndex(parts, partAttr, 0)]!;
  }
  const box = new Box3();
  // World AABB center, recomputed each seek so it tracks turntable/orbit motion.
  return (out) => box.setFromObject(node).getCenter(out);
}

export function compileCallouts(compiled: CompiledScene): void {
  const els = Array.from(compiled.host.querySelectorAll("sf-callout"));
  if (els.length === 0) return;
  injectStyles();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sf-callout-svg");
  document.body.appendChild(svg);

  const callouts: Callout[] = [];
  for (const el of els) {
    const worldPoint = resolveAnchor(compiled, el);
    if (!worldPoint) {
      console.warn("[stereoframe] sf-callout: target/part/point did not resolve; skipped");
      continue;
    }
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "sf-callout-line");
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "sf-callout-dot");
    dot.setAttribute("r", "4");
    svg.append(line, dot);

    const side = (el.getAttribute("anchor") ?? "right").toLowerCase() === "left" ? -1 : 1;
    const label = document.createElement("div");
    label.className = "sf-callout-label";
    label.style.textAlign = side < 0 ? "right" : "left";
    const value = el.getAttribute("value");
    if (value) {
      const v = document.createElement("div");
      v.className = "v";
      v.textContent = value;
      label.appendChild(v);
    }
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = el.getAttribute("text") ?? "";
    label.appendChild(t);
    document.body.appendChild(label);

    callouts.push({
      worldPoint,
      dot,
      line,
      label,
      side,
      start: parseSeconds(el.getAttribute("start"), 0),
      dur: Math.max(0.001, parseSeconds(el.getAttribute("duration"), 0.7)),
      ease: getEase(el.getAttribute("ease"), "power2.out"),
    });
  }
  if (callouts.length === 0) return;

  const _w = new Vector3();
  const _c = new Vector3();
  // Lead-out vector from the anchor to the label (px), before the side flip.
  const LEAD_X = 150;
  const LEAD_Y = -92;

  compiled.overlayFns.push((time) => {
    // Read the canvas rect each seek — robust to layout/font settling after
    // compile, and the canvas is exactly the surface the 3D projects onto.
    const r = compiled.canvas.getBoundingClientRect();
    const frame =
      r.width > 0 && r.height > 0
        ? { left: r.left, top: r.top, width: r.width, height: r.height }
        : { left: 0, top: 0, width: compiled.width, height: compiled.height };
    for (const c of callouts) {
      c.worldPoint(_w);
      // Behind the camera? camera-space z is negative in front, so > 0 = behind.
      _c.copy(_w).applyMatrix4(compiled.camera.matrixWorldInverse);
      const behind = _c.z > -0.05;
      _w.project(compiled.camera);
      const onScreen = !behind && Math.abs(_w.x) < 1.3 && Math.abs(_w.y) < 1.3;

      const sx = frame.left + (_w.x * 0.5 + 0.5) * frame.width;
      const sy = frame.top + (-_w.y * 0.5 + 0.5) * frame.height;
      const dx = c.side * LEAD_X;
      const lx = sx + dx;
      const ly = sy + LEAD_Y;

      const draw = c.ease(Math.min(1, Math.max(0, (time - c.start) / c.dur)));
      const pre = time < c.start ? 0 : 1;
      const vis = onScreen ? pre : 0;

      // Leader grows from the anchor toward the label.
      c.line.setAttribute("x1", String(sx));
      c.line.setAttribute("y1", String(sy));
      c.line.setAttribute("x2", String(sx + dx * draw));
      c.line.setAttribute("y2", String(sy + LEAD_Y * draw));
      c.line.style.opacity = String(vis * Math.min(1, draw * 4));
      c.dot.setAttribute("cx", String(sx));
      c.dot.setAttribute("cy", String(sy));
      c.dot.style.opacity = String(vis * Math.min(1, draw * 6));

      // Label fades/settles in after the leader is mostly drawn.
      const labelP = Math.min(1, Math.max(0, (draw - 0.5) / 0.5));
      c.label.style.left = `${lx}px`;
      c.label.style.top = `${ly}px`;
      c.label.style.transform = `translate(${c.side < 0 ? "-100%" : "0"}, calc(-50% + ${(1 - labelP) * 8}px))`;
      c.label.style.opacity = String(vis * labelP);
    }
  });
}
