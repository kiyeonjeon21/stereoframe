/**
 * Runtime self-inspection for `stereoframe validate`.
 *
 * Runs inside the page (where three.js lives) and returns JSON-serializable
 * facts the CLI turns into findings: object/light counts, NaN transforms,
 * frustum coverage ("is anything actually in shot?"), and mean canvas
 * luminance (black-frame suspicion). The caller must seek to the probe time
 * in the same task before reading — `protocol.diagnostics(t)` does both.
 */
import { Box3, Frustum, Light, Matrix4, Mesh, Points, Vector3 } from "three";
import type { CompiledScene } from "./scene";
import { shotState, type ShotSpec } from "./shots";

export interface SceneDiagnostics {
  shot: ShotSpec;
  visible: boolean;
  meshCount: number;
  /** Meshes with light-dependent materials (Standard/Physical). */
  litMeshCount: number;
  lightCount: number;
  hasEnvironment: boolean;
  hasNaN: boolean;
  /** Fraction of geometry-bearing top-level objects intersecting the camera frustum. */
  frustumCoverage: number | null;
  /** Mean luminance 0..1 of the rendered canvas (visible scenes only). */
  meanLuminance: number | null;
}

const _box = new Box3();
const _frustum = new Frustum();
const _proj = new Matrix4();
const _vec = new Vector3();

let _probe: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

function meanLuminance(source: HTMLCanvasElement): number {
  if (!_probe) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    _probe = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
  }
  const { canvas, ctx } = _probe;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
  }
  return sum / (data.length / 4) / 255;
}

function isFiniteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function collectDiagnostics(scenes: CompiledScene[], t: number): SceneDiagnostics[] {
  return scenes.map((s) => {
    const state = shotState(t, s.shot);
    let meshCount = 0;
    let litMeshCount = 0;
    let lightCount = 0;
    let hasNaN = !isFiniteVec(s.camera.position);

    s.scene.traverse((obj) => {
      if (!isFiniteVec(obj.position) || !isFiniteVec(obj.scale)) hasNaN = true;
      if (obj instanceof Light) lightCount++;
      if (obj instanceof Mesh || obj instanceof Points) {
        meshCount++;
        const material = (obj as Mesh).material;
        const type = Array.isArray(material) ? material[0]?.type : material?.type;
        if (type === "MeshStandardMaterial" || type === "MeshPhysicalMaterial") {
          litMeshCount++;
        }
      }
    });

    // Frustum coverage over top-level geometry-bearing objects. Box3 walk is
    // costly but this only runs under `stereoframe validate`.
    s.camera.updateMatrixWorld();
    _proj.multiplyMatrices(s.camera.projectionMatrix, s.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_proj);
    let geomObjects = 0;
    let inFrustum = 0;
    for (const child of s.scene.children) {
      let hasGeometry = false;
      child.traverse((o) => {
        if (o instanceof Mesh || o instanceof Points) hasGeometry = true;
      });
      if (!hasGeometry) continue;
      geomObjects++;
      _box.setFromObject(child);
      if (_box.isEmpty()) continue;
      if (_frustum.intersectsBox(_box)) inFrustum++;
      else if (_box.getCenter(_vec).length() > 1e7) inFrustum++; // degenerate huge bounds
    }

    return {
      shot: s.shot,
      visible: state.visible,
      meshCount,
      litMeshCount,
      lightCount,
      hasEnvironment: s.scene.environment !== null,
      hasNaN,
      frustumCoverage: geomObjects > 0 ? inFrustum / geomObjects : null,
      meanLuminance: state.visible ? meanLuminance(s.canvas) : null,
    };
  });
}

/** djb2 over the canvas dataURL — cheap in-page fingerprint for idempotency probes. */
export function canvasFingerprint(scenes: CompiledScene[]): string {
  let hash = 5381;
  for (const s of scenes) {
    if (s.canvas.style.display === "none") continue;
    const url = s.canvas.toDataURL("image/png");
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) + hash + url.charCodeAt(i)) | 0;
    }
  }
  return String(hash >>> 0);
}
