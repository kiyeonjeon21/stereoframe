/**
 * <sf-baked> — replay a baked simulation as a pure function of t.
 *
 * `stereoframe bake` records a forward/live sim's per-frame InstancedMesh
 * transforms into `<id>.bake.bin` (+ a `.json` manifest). This element plays
 * that cache back by sampling the nearest frame for `t` — a pure lookup, so the
 * scene is fully SEEKABLE again (random-access, multi-shot, crossfade, preview
 * all work). That's the recapture path: author a sim with mode="forward", bake
 * it, ship the seekable baked playback.
 *
 *   <sf-baked src="assets/flock.bake.json" geometry="icosahedron" args="0.3 0"
 *             material="standard" color="#9db8ff"></sf-baked>
 */
import { Group, InstancedMesh, Matrix4 } from "three";
import type { BufferGeometry, Material } from "three";

export interface BakedBuild {
  group: Group;
  pending: Promise<void>;
  writer: (t: number) => void;
}

interface BakeManifest {
  count: number;
  frames: number;
  fps: number;
  stride: number;
  bin: string;
}

/** Nearest baked frame for a seek time (step sampling), clamped to the cache. */
export function bakedFrameIndex(t: number, fps: number, frames: number): number {
  return Math.min(frames - 1, Math.max(0, Math.round(t * fps)));
}

export function buildBaked(el: Element, geometry: BufferGeometry, material: Material): BakedBuild {
  const group = new Group();
  group.frustumCulled = false;
  const src = el.getAttribute("src") ?? "";

  let mesh: InstancedMesh | null = null;
  let bin: Float32Array | null = null;
  let count = 0;
  let frames = 0;
  let fps = 30;
  const _mat = new Matrix4();

  const writer = (t: number): void => {
    if (!mesh || !bin) return; // not loaded yet (guarded; ready-gate awaits pending)
    const base = bakedFrameIndex(t, fps, frames) * count * 16;
    for (let i = 0; i < count; i++) {
      _mat.fromArray(bin, base + i * 16);
      mesh.setMatrixAt(i, _mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };

  const pending = (async () => {
    if (!src) throw new Error("sf-baked: missing src");
    const manifest = (await (await fetch(src)).json()) as BakeManifest;
    count = manifest.count;
    frames = manifest.frames;
    fps = manifest.fps;
    const binUrl = src.replace(/[^/]+$/, manifest.bin); // bin path is relative to the manifest
    bin = new Float32Array(await (await fetch(binUrl)).arrayBuffer());
    mesh = new InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    group.add(mesh);
    writer(0); // initial pose so frame 0 is never blank
  })();

  return { group, pending, writer };
}
