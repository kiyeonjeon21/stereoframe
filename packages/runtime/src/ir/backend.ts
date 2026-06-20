/**
 * three.js backend for the IR path.
 *
 * `installIR` replaces the legacy animation layer (compileAnimations): it lowers
 * the scene to SceneIR, compiles it, and registers ONE seek writer that runs
 * `evaluate(t)` and applies the resulting local transforms to the three.js
 * objects. World matrices, camera look-at, post-fx, fingerprint, diagnostics and
 * the whole `window.__stereoframe` protocol are reused unchanged via applySeek.
 */
import { compileAnimations } from "../animate";
import type { CompiledScene } from "../scene";
import { compile } from "./compile";
import { evaluate } from "./evaluate";
import { lowerScene } from "./from-html";

/** Verbs the IR core models in `evaluate` (per-channel + behaviors). Everything
 *  else falls through to the legacy writers (the `core="ir"` hybrid). */
export const IR_VERBS = new Set(["turntable", "float", "sway", "orbit", "move", "dolly", "zoom", "follow"]);

export function installIR(compiled: CompiledScene): void {
  const { scene, objectMap } = lowerScene(compiled);
  const ir = compile(scene);

  // IR writer runs first (seekFns[0]); legacy long-tail writers are appended
  // after, so where they share a node/channel (e.g. bounce-in scale) legacy wins.
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
  });

  // Long-tail verbs (path/camera-path/explode/isolate/variant/crossfade-clip/
  // morph/deform/bounce-in/fade-in) the IR doesn't model yet: legacy, byte-identical.
  compileAnimations(compiled, { skip: IR_VERBS });
}
