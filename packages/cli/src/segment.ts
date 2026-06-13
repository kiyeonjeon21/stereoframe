/**
 * `stereoframe segment <model.glb>` — split a single-mesh GLB into multiple parts by
 * connected geometry islands, so per-part direction (spin a wheel, isolate/explode a
 * feature) works. AI text/image-to-3D output is one welded mesh; this recovers parts
 * WHERE the geometry is actually disjoint. `--dry-run` reports the component breakdown
 * (the feasibility check) without writing anything.
 *
 * Runs in the headless session (three.js in-page), mirroring inspect.ts.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openSession } from "./session";
import { resolveRuntimeBundle } from "./scaffold";

export interface ComponentInfo {
  tris: number;
  center: number[];
  size: number[];
}
export interface SegmentReport {
  error?: string;
  meshTris: number;
  weldedVerts: number;
  components: ComponentInfo[]; // sorted by tris desc, after dropping specks
  dropped: number; // tiny components merged away
}

/** In-browser: weld the largest mesh's vertices by position, union-find triangles into
 *  connected components, report each component's triangle count + AABB. */
function componentProbe(minFaces: number): SegmentReport {
  const sf = (window as unknown as { __stereoframe?: any }).__stereoframe;
  const empty: SegmentReport = { meshTris: 0, weldedVerts: 0, components: [], dropped: 0 };
  if (!sf || !sf.scenes[0]) return { ...empty, error: "no scene" };
  const s = sf.scenes[0];
  sf.seek(0);
  s.scene.updateMatrixWorld(true);
  const root = s.objectsById.get("m");
  if (!root) return { ...empty, error: "no #m model" };

  let mesh: any = null;
  let maxTris = -1;
  root.traverse((o: any) => {
    if (o.isMesh && o.geometry?.attributes?.position) {
      const g = o.geometry;
      const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (t > maxTris) {
        maxTris = t;
        mesh = o;
      }
    }
  });
  if (!mesh) return { ...empty, error: "no mesh geometry" };

  const g = mesh.geometry;
  const pos = g.attributes.position;
  const idx: { length: number; [i: number]: number } | null = g.index ? g.index.array : null;
  const triCount = (idx ? idx.length : pos.count) / 3;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
  const q = diag * 1e-4; // weld tolerance: ~0.01% of the model diagonal

  // weld vertices by quantized position → contiguous welded ids
  const weld = new Map<string, number>();
  const vid = new Int32Array(pos.count);
  let next = 0;
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
    let w = weld.get(k);
    if (w === undefined) {
      w = next++;
      weld.set(k, w);
    }
    vid[i] = w;
  }

  // union-find over welded verts, joined by shared triangles
  const parent = new Int32Array(next);
  for (let i = 0; i < next; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const tv = (t: number, k: number) => (idx ? idx[t * 3 + k]! : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    const a = vid[tv(t, 0)]!;
    const b = vid[tv(t, 1)]!;
    const c = vid[tv(t, 2)]!;
    const ra = find(a);
    parent[ra] = find(b);
    parent[find(b)] = find(c);
  }

  // tally per component: triangle count + AABB over its vertices
  type Acc = { tris: number; min: number[]; max: number[] };
  const comps = new Map<number, Acc>();
  for (let t = 0; t < triCount; t++) {
    const r = find(vid[tv(t, 0)]!);
    let acc = comps.get(r);
    if (!acc) {
      acc = { tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      comps.set(r, acc);
    }
    acc.tris++;
    for (let k = 0; k < 3; k++) {
      const vi = tv(t, k);
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
      acc.min[0] = Math.min(acc.min[0]!, x); acc.min[1] = Math.min(acc.min[1]!, y); acc.min[2] = Math.min(acc.min[2]!, z);
      acc.max[0] = Math.max(acc.max[0]!, x); acc.max[1] = Math.max(acc.max[1]!, y); acc.max[2] = Math.max(acc.max[2]!, z);
    }
  }

  const all = [...comps.values()].sort((a, b) => b.tris - a.tris);
  const kept = all.filter((c) => c.tris >= minFaces);
  return {
    meshTris: triCount,
    weldedVerts: next,
    dropped: all.length - kept.length,
    components: kept.map((c) => ({
      tris: c.tris,
      center: [(c.min[0]! + c.max[0]!) / 2, (c.min[1]! + c.max[1]!) / 2, (c.min[2]! + c.max[2]!) / 2],
      size: [c.max[0]! - c.min[0]!, c.max[1]! - c.min[1]!, c.max[2]! - c.min[2]!],
    })),
  };
}

export async function segmentModel(opts: { model: string; minFaces?: number; dryRun?: boolean }): Promise<SegmentReport> {
  const modelPath = resolve(opts.model);
  if (!/\.(glb|gltf)$/i.test(modelPath)) throw new Error("segment expects a .glb or .gltf model");
  const minFaces = opts.minFaces ?? 50;
  const modelFile = basename(modelPath);
  const dir = mkdtempSync(join(tmpdir(), "sf-segment-"));
  try {
    mkdirSync(join(dir, "assets"), { recursive: true });
    copyFileSync(modelPath, join(dir, "assets", modelFile));
    copyFileSync(resolveRuntimeBundle(), join(dir, "assets", "stereoframe.js"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8"></head><body>
<sf-scene duration="1" width="640" height="360">
  <sf-camera position="0 0 5"></sf-camera>
  <sf-model id="m" src="assets/${modelFile}"></sf-model>
</sf-scene>
<script type="module">import "./assets/stereoframe.js";</script>
</body></html>`,
    );
    const session = await openSession(dir);
    try {
      const report = (await session.page.evaluate(componentProbe, minFaces)) as SegmentReport;
      if (report.error) throw new Error(`segment failed: ${report.error}`);
      return report;
    } finally {
      await session.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
