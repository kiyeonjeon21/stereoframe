/**
 * three.js backend for the IR path.
 *
 * `installIR` replaces the legacy animation layer (compileAnimations): it lowers
 * the scene to SceneIR, compiles it, and registers ONE seek writer that runs
 * `evaluate(t)` and applies the resulting local transforms + material state to the
 * three.js objects. World matrices, camera look-at, post-fx, fingerprint,
 * diagnostics and the whole `window.__stereoframe` protocol are reused unchanged.
 */
import { Color, Light, type Material, Mesh, MeshStandardMaterial } from "three";
import { compileAnimations } from "../animate";
import type { CompiledScene } from "../scene";
import { compile } from "./compile";
import { evaluate } from "./evaluate";
import { lowerScene } from "./from-html";
import type { LightFrame, MaterialFrame } from "./types";

/** Verbs the IR models for ANY target — legacy never builds them. */
export const IR_VERBS = new Set(["turntable", "float", "sway", "orbit", "move", "dolly", "zoom", "follow", "variant", "to"]);
/** Verbs the IR models only for 3D targets — DOM-target instances stay legacy. */
export const IR_VERBS_3D = new Set(["bounce-in", "fade-in"]);

interface MatState {
  mat: Material;
  baseOpacity: number;
  baseTransparent: boolean;
  std: MeshStandardMaterial | null;
  baseColor: Color | null;
  baseRoughness: number;
  baseMetalness: number;
  name: string;
}

/** Build per-node material appliers for nodes touched by an opacity/material
 *  channel. Each applier captures the base state once and, every seek, resets to
 *  base then applies the frame's material state — so nothing goes stale. */
function buildMaterialAppliers(
  ir: ReturnType<typeof compile>,
  objectMap: Map<string, import("three").Object3D>,
): Map<string, (m: MaterialFrame | undefined) => void> {
  const ids = new Set<string>();
  for (const key of ir.segments.keys()) {
    const ch = key.slice(key.lastIndexOf(".") + 1);
    if (ch === "opacity" || ch === "material") ids.add(key.slice(0, key.lastIndexOf(".")));
  }

  const appliers = new Map<string, (m: MaterialFrame | undefined) => void>();
  const c1 = new Color();
  const c2 = new Color();
  for (const id of ids) {
    const obj = objectMap.get(id);
    if (!obj) continue;
    const states: MatState[] = [];
    const seen = new Set<Material>();
    obj.traverse((child) => {
      const m = (child as Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        const std = mat instanceof MeshStandardMaterial ? mat : null;
        states.push({
          mat,
          baseOpacity: mat.opacity,
          baseTransparent: mat.transparent,
          std,
          baseColor: std ? std.color.clone() : null,
          baseRoughness: std ? std.roughness : 0,
          baseMetalness: std ? std.metalness : 0,
          name: mat.name ?? "",
        });
      }
    });
    appliers.set(id, (f) => {
      for (const s of states) {
        // opacity (every material under the node)
        if (f?.opacity != null) {
          s.mat.opacity = s.baseOpacity * f.opacity;
          s.mat.transparent = f.opacity < 1 ? true : s.baseTransparent;
        } else {
          s.mat.opacity = s.baseOpacity;
          s.mat.transparent = s.baseTransparent;
        }
        // variant color/roughness/metalness (name-filtered, standard materials)
        if (s.std && s.baseColor) {
          const matches = !f?.materialName || s.name === f.materialName;
          if (matches && f?.color) s.std.color.copy(c1.set(f.color.from)).lerp(c2.set(f.color.to), f.color.mix);
          else s.std.color.copy(s.baseColor);
          s.std.roughness = matches && f?.roughness != null ? f.roughness : s.baseRoughness;
          s.std.metalness = matches && f?.metalness != null ? f.metalness : s.baseMetalness;
        }
      }
    });
  }
  return appliers;
}

/** Build per-light appliers for nodes touched by a `light` channel. Captures base
 *  intensity + color once and, every seek, resets to base then applies the frame's
 *  light state — color lerped with THREE.Color (matches the material path). */
function buildLightAppliers(
  ir: ReturnType<typeof compile>,
  objectMap: Map<string, import("three").Object3D>,
): Map<string, (l: LightFrame | undefined) => void> {
  const ids = new Set<string>();
  for (const key of ir.segments.keys()) {
    const ch = key.slice(key.lastIndexOf(".") + 1);
    if (ch === "light") ids.add(key.slice(0, key.lastIndexOf(".")));
  }

  const appliers = new Map<string, (l: LightFrame | undefined) => void>();
  const c1 = new Color();
  const c2 = new Color();
  for (const id of ids) {
    const obj = objectMap.get(id);
    if (!(obj instanceof Light)) continue;
    const light = obj;
    const baseIntensity = light.intensity;
    const baseColor = light.color.clone();
    appliers.set(id, (f) => {
      light.intensity = f?.intensity != null ? f.intensity : baseIntensity;
      if (f?.color) light.color.copy(c1.set(f.color.from)).lerp(c2.set(f.color.to), f.color.mix);
      else light.color.copy(baseColor);
    });
  }
  return appliers;
}

export function installIR(compiled: CompiledScene): void {
  const { scene, objectMap } = lowerScene(compiled);
  const ir = compile(scene);
  const materialAppliers = buildMaterialAppliers(ir, objectMap);
  const lightAppliers = buildLightAppliers(ir, objectMap);

  // IR writer runs first (seekFns[0]); legacy long-tail writers are appended
  // after, so where they share a node/channel (e.g. DOM fades) legacy wins.
  compiled.seekFns.push((t: number) => {
    const fs = evaluate(ir, t);
    for (const [id, tr] of fs.nodes) {
      if (id === "camera") continue; // camera applied via fs.camera below
      const obj = objectMap.get(id);
      if (!obj) continue;
      obj.position.set(tr.position[0], tr.position[1], tr.position[2]);
      obj.rotation.set(tr.rotation[0], tr.rotation[1], tr.rotation[2]);
      obj.scale.set(tr.scale[0], tr.scale[1], tr.scale[2]);
    }
    if (fs.camera.position) {
      compiled.camera.position.set(fs.camera.position[0], fs.camera.position[1], fs.camera.position[2]);
    }
    if (fs.camera.fov != null && fs.camera.fov !== compiled.camera.fov) {
      compiled.camera.fov = fs.camera.fov;
      compiled.camera.updateProjectionMatrix();
    }
    for (const [id, applier] of materialAppliers) applier(fs.materials.get(id));
    for (const [id, applier] of lightAppliers) applier(fs.lights.get(id));
  });

  // Long-tail verbs the IR doesn't model yet (path/camera-path/explode/isolate/
  // morph/deform/crossfade-clip + DOM-target bounce-in/fade-in): legacy, byte-identical.
  compileAnimations(compiled, { skip: IR_VERBS, skip3d: IR_VERBS_3D });
}
