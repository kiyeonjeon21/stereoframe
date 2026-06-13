/**
 * <sf-swarm> — instanced paper scraps that gather into typography.
 *
 * Target points are sampled from text rasterized on an offscreen 2D canvas;
 * every per-instance quantity (scatter position, rotations, scale, color,
 * stagger delay) comes from mulberry32(seed). The writer recomputes every
 * instance matrix from `t` alone — lerp(scatter, target, ease(stagger(p)))
 * — so any frame can be seeked in any order and is bit-stable per seed.
 *
 *   <sf-swarm text="EVERYTHING FALLS|INTO PLACE" font="900 120px sans-serif"
 *             count="2000" seed="7" size="0.13" width="14"
 *             palette="#fafafa,#d4d4d4,#ef4444,#18181b"
 *             scatter="24 12 14" start="0.5" duration="3.5"
 *             stagger="0.5" ease="power3.inOut"></sf-swarm>
 *
 * `|` in `text` breaks lines. `mode="disperse"` plays the reverse.
 */
import {
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { parseNumber, parseSeconds, parseVec3 } from "../parse";
import { mulberry32 } from "../rng";
import { getEase } from "../ease";
import { staggeredProgress } from "../verbs";

interface Point2 {
  x: number; // 0..1 within text bbox
  y: number; // 0..1 within text bbox
}

function sampleTextPoints(
  text: string,
  font: string,
  desired: number,
  rand: () => number,
): { points: Point2[]; aspect: number } {
  const lines = text.split("|").map((l) => l.trim());
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = font;
  const metrics = lines.map((l) => ctx.measureText(l));
  const lineHeight =
    (metrics[0]!.fontBoundingBoxAscent ?? 90) + (metrics[0]!.fontBoundingBoxDescent ?? 30);
  const textW = Math.max(...metrics.map((m) => m.width));
  const pad = lineHeight * 0.25;
  canvas.width = Math.min(2048, Math.ceil(textW + pad * 2));
  canvas.height = Math.ceil(lineHeight * lines.length + pad * 2);

  // Canvas reset clears font state — set everything after sizing.
  ctx.font = font;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, canvas.width / 2, pad + lineHeight * (i + 0.5), canvas.width - pad);
  }

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  // Sample on a grid sized so candidate count ≈ 2× desired, then thin with
  // the seeded RNG. Iteration order is fixed → deterministic.
  const filledRatioGuess = 0.18;
  const step = Math.max(
    1,
    Math.floor(Math.sqrt((canvas.width * canvas.height * filledRatioGuess) / (desired * 2))),
  );
  const candidates: Point2[] = [];
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const alpha = data[(y * canvas.width + x) * 4 + 3]!;
      if (alpha > 128) {
        candidates.push({ x: x / canvas.width, y: y / canvas.height });
      }
    }
  }
  const points: Point2[] = [];
  if (candidates.length === 0) return { points, aspect: 1 };
  for (let i = 0; i < desired; i++) {
    const base = candidates[Math.floor(rand() * candidates.length)]!;
    const jitter = step / canvas.width;
    points.push({
      x: base.x + (rand() - 0.5) * jitter,
      y: base.y + (rand() - 0.5) * jitter,
    });
  }
  return { points, aspect: canvas.height / canvas.width };
}

export interface SwarmBuild {
  mesh: InstancedMesh;
  writer: (t: number) => void;
}

const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _mat = new Matrix4();

export function buildSwarm(el: Element): SwarmBuild {
  const count = Math.max(1, Math.floor(parseNumber(el.getAttribute("count"), 1500)));
  const seed = Math.floor(parseNumber(el.getAttribute("seed"), 1));
  const size = parseNumber(el.getAttribute("size"), 0.12);
  const worldWidth = parseNumber(el.getAttribute("width"), 12);
  const start = parseSeconds(el.getAttribute("start"), 0.5);
  const duration = parseSeconds(el.getAttribute("duration"), 3.5);
  const stagger = Math.min(0.95, Math.max(0, parseNumber(el.getAttribute("stagger"), 0.5)));
  const ease = getEase(el.getAttribute("ease"), "power3.inOut");
  const disperse = (el.getAttribute("mode") ?? "gather").toLowerCase() === "disperse";
  const center = parseVec3(el.getAttribute("position"), [0, 0, 0]);
  const scatterSize = parseVec3(el.getAttribute("scatter"), [
    worldWidth * 1.6,
    worldWidth * 0.8,
    worldWidth,
  ]);
  const palette = (el.getAttribute("palette") ?? "#fafafa,#e4e4e7,#ef4444,#18181b")
    .split(",")
    .map((c) => new Color(c.trim()));

  const rand = mulberry32(seed);
  const { points, aspect } = sampleTextPoints(
    el.getAttribute("text") ?? "STEREOFRAME",
    el.getAttribute("font") ?? "900 140px sans-serif",
    count,
    rand,
  );

  const geometry = new PlaneGeometry(1, 0.72);
  const material = new MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    side: DoubleSide,
  });
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.position.set(center[0], center[1], center[2]);
  mesh.frustumCulled = false;

  const scatterPos = new Float32Array(count * 3);
  const targetPos = new Float32Array(count * 3);
  const quatStart: Quaternion[] = [];
  const quatEnd: Quaternion[] = [];
  const scales = new Float32Array(count * 2);
  const delays = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const p = points[i % Math.max(1, points.length)] ?? { x: 0.5, y: 0.5 };
    scatterPos[i * 3] = (rand() - 0.5) * scatterSize[0];
    scatterPos[i * 3 + 1] = (rand() - 0.5) * scatterSize[1];
    scatterPos[i * 3 + 2] = (rand() - 0.5) * scatterSize[2];
    targetPos[i * 3] = (p.x - 0.5) * worldWidth;
    targetPos[i * 3 + 1] = (0.5 - p.y) * worldWidth * aspect;
    targetPos[i * 3 + 2] = (rand() - 0.5) * 0.05;
    quatStart.push(
      new Quaternion().setFromAxisAngle(
        new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
        rand() * Math.PI * 2,
      ),
    );
    quatEnd.push(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (rand() - 0.5) * 0.35));
    scales[i * 2] = size * (0.7 + rand() * 0.7);
    scales[i * 2 + 1] = size * (0.7 + rand() * 0.7);
    delays[i] = rand() * stagger;
    mesh.setColorAt(i, palette[Math.floor(rand() * palette.length)]!);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const writer = (t: number): void => {
    let raw = duration > 0 ? (t - start) / duration : t < start ? 0 : 1;
    raw = Math.min(1, Math.max(0, raw));
    if (disperse) raw = 1 - raw;
    for (let i = 0; i < count; i++) {
      const p = ease(staggeredProgress(raw, delays[i]!, stagger));
      _pos.set(
        scatterPos[i * 3]! + (targetPos[i * 3]! - scatterPos[i * 3]!) * p,
        scatterPos[i * 3 + 1]! + (targetPos[i * 3 + 1]! - scatterPos[i * 3 + 1]!) * p,
        scatterPos[i * 3 + 2]! + (targetPos[i * 3 + 2]! - scatterPos[i * 3 + 2]!) * p,
      );
      _quat.slerpQuaternions(quatStart[i]!, quatEnd[i]!, p);
      _scale.set(scales[i * 2]!, scales[i * 2 + 1]!, 1);
      _mat.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  writer(0);

  return { mesh, writer };
}
