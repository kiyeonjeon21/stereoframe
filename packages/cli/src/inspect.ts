/**
 * `stereoframe inspect <model.glb>` — the segment/tag pipeline.
 *
 * Loads a GLB through the actual runtime headlessly and reads its part graph
 * from the live three.js scene, so the reported part indices/names match
 * EXACTLY what `isolate`/`explode`/`sf-callout` target at render time (they all
 * share `collectParts`). For each part it reports: name, kind, triangle count,
 * dominant material character (glass/metal/fabric/emissive/matte), bounding
 * box, where it sits (top/base/left/right/front/back/core), and size rank.
 *
 * This is what turns "drop any GLB → direct it" from guesswork into something
 * an agent (or a person) can actually reason about: run inspect, learn the
 * parts, then author `part="Glass"` by name. Writes `<model>.segments.json`.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { openSession } from "./session";
import { resolveRuntimeBundle } from "./scaffold";

export type Character = "glass" | "metal" | "fabric" | "emissive" | "matte" | "—";

export interface PartManifest {
  index: number;
  name: string;
  kind: "mesh" | "empty";
  skinned: boolean;
  triangles: number;
  character: Character;
  color: string | null;
  spatial: string[];
  sizeRank: number | null;
  bounds: { center: number[]; size: number[]; min: number[]; max: number[] } | null;
  material: RawMaterial | null;
}

export interface ModelManifest {
  model: string;
  generatedBy: string;
  partCount: number;
  meshParts: number;
  isSingleMesh: boolean;
  hasRig: boolean;
  recommendedFit: number;
  /** The most-detailed mesh part's material — the model's "dominant" look,
   *  used to auto-adapt lighting (e.g. a fully-metal model needs a tamed rig). */
  dominant: { character: Character; metalness: number | null };
  bounds: { center: number[]; size: number[]; min: number[]; max: number[] };
  parts: PartManifest[];
}

interface RawMaterial {
  type: string;
  color: string | null;
  metalness: number | null;
  roughness: number | null;
  transmission: number;
  sheen: number;
  emissive: string | null;
  emissiveIntensity: number;
}

interface RawPart {
  index: number;
  name: string;
  kind: "mesh" | "empty";
  skinned: boolean;
  triangles: number;
  bounds: { center: number[]; size: number[]; min: number[]; max: number[] } | null;
  material: RawMaterial | null;
}

interface RawResult {
  ok?: boolean;
  error?: string;
  hasRig: boolean;
  bounds: { center: number[]; size: number[]; min: number[]; max: number[] };
  parts: RawPart[];
}

/** Runs in the browser against the live runtime scene. Mirrors collectParts. */
function probe(): RawResult {
  const sf = (window as unknown as { __stereoframe?: any }).__stereoframe;
  if (!sf || !sf.scenes[0]) return { error: "no scene", hasRig: false, bounds: null as any, parts: [] };
  const s = sf.scenes[0];
  sf.seek(0);
  s.scene.updateMatrixWorld(true);
  const root = s.objectsById.get("m");
  if (!root) return { error: "no #m model", hasRig: false, bounds: null as any, parts: [] };

  let Box3: any = null;
  root.traverse((o: any) => {
    if (!Box3 && o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.geometry.boundingBox) Box3 = o.geometry.boundingBox.constructor;
    }
  });
  if (!Box3) return { error: "model has no geometry", hasRig: false, bounds: null as any, parts: [] };
  const Vec3 = new Box3().min.constructor;
  const triple = (v: any) => [v.x, v.y, v.z];
  const boxOf = (obj: any) => {
    const b = new Box3().setFromObject(obj);
    if (b.isEmpty()) return null;
    return { center: triple(b.getCenter(new Vec3())), size: triple(b.getSize(new Vec3())), min: triple(b.min), max: triple(b.max) };
  };

  const collect = (r: any) => {
    let n = r;
    while (n.children.length === 1) n = n.children[0];
    return n.children.length > 1 ? [...n.children] : [n];
  };

  let hasRig = false;
  const parts: RawPart[] = collect(root).map((p: any, index: number) => {
    let tris = 0;
    let meshCount = 0;
    let skinned = false;
    const matTris = new Map<any, number>();
    p.traverse((o: any) => {
      if (o.isSkinnedMesh) { skinned = true; hasRig = true; }
      if (o.isMesh && o.geometry) {
        meshCount++;
        const g = o.geometry;
        const t = g.index ? g.index.count / 3 : g.attributes.position ? g.attributes.position.count / 3 : 0;
        tris += t;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) matTris.set(m, (matTris.get(m) ?? 0) + t / mats.length);
      }
    });
    let dom: any = null;
    let domT = -1;
    matTris.forEach((t, m) => { if (t > domT) { domT = t; dom = m; } });
    const material: RawMaterial | null = dom
      ? {
          type: dom.type,
          color: dom.color?.getHexString ? dom.color.getHexString() : null,
          metalness: dom.metalness ?? null,
          roughness: dom.roughness ?? null,
          transmission: dom.transmission ?? 0,
          sheen: dom.sheen ?? 0,
          emissive: dom.emissive?.getHexString ? dom.emissive.getHexString() : null,
          emissiveIntensity: dom.emissiveIntensity ?? 0,
        }
      : null;
    return { index, name: p.name ?? "", kind: meshCount > 0 ? "mesh" : "empty", skinned, triangles: Math.round(tris), bounds: boxOf(p), material };
  });

  return { ok: true, hasRig, bounds: boxOf(root)!, parts };
}

function character(m: RawMaterial | null): Character {
  if (!m) return "—";
  if (m.transmission > 0.1) return "glass";
  if (m.sheen > 0.1) return "fabric";
  // Metal before emissive: a flat emissive color is often texture-gated (badges,
  // headlights) on an otherwise metallic body, so high metalness wins. A true
  // emitter (screen/sign) is rarely metallic, so it still reads as emissive.
  if ((m.metalness ?? 0) > 0.5) return "metal";
  if (m.emissiveIntensity > 0 && m.emissive && m.emissive !== "000000") return "emissive";
  return "matte";
}

function spatialTags(center: number[], model: ModelManifest["bounds"]): string[] {
  const tags: string[] = [];
  const th = 0.33;
  const axis = (i: number) => {
    const half = model.size[i]! / 2;
    return half < 1e-6 ? 0 : (center[i]! - model.center[i]!) / half;
  };
  const ny = axis(1);
  if (ny > th) tags.push("top");
  else if (ny < -th) tags.push("base");
  const nx = axis(0);
  if (nx > th) tags.push("right");
  else if (nx < -th) tags.push("left");
  const nz = axis(2);
  if (nz > th) tags.push("front");
  else if (nz < -th) tags.push("back");
  return tags.length ? tags : ["core"];
}

/** Inspect a model and return its manifest (also writes <model>.segments.json). */
export async function inspectModel(opts: {
  model: string;
  json?: boolean;
  /** false = don't write <model>.segments.json (used by `stage --preset spec`). */
  write?: boolean;
  /** true = return the manifest without printing (used internally). */
  silent?: boolean;
}): Promise<ModelManifest> {
  const modelPath = resolve(opts.model);
  if (!/\.(glb|gltf)$/i.test(modelPath)) throw new Error("inspect expects a .glb or .gltf model");
  const modelFile = basename(modelPath);

  const dir = mkdtempSync(join(tmpdir(), "sf-inspect-"));
  let raw: RawResult;
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
      raw = (await session.page.evaluate(probe)) as RawResult;
    } finally {
      await session.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (raw.error) throw new Error(`inspect failed: ${raw.error}`);

  const bounds = raw.bounds;
  const longest = Math.max(...bounds.size);
  const meshParts = raw.parts.filter((p) => p.kind === "mesh");
  // Size rank by AABB volume, mesh parts only.
  const ranked = [...meshParts]
    .filter((p) => p.bounds)
    .sort((a, b) => b.bounds!.size.reduce((x, y) => x * y, 1) - a.bounds!.size.reduce((x, y) => x * y, 1));
  const rankOf = new Map(ranked.map((p, i) => [p.index, i]));

  const parts: PartManifest[] = raw.parts.map((p) => ({
    index: p.index,
    name: p.name,
    kind: p.kind,
    skinned: p.skinned,
    triangles: p.triangles,
    character: character(p.material),
    color: p.material?.color ? `#${p.material.color}` : null,
    spatial: p.bounds ? spatialTags(p.bounds.center, bounds) : [],
    sizeRank: rankOf.has(p.index) ? rankOf.get(p.index)! : null,
    bounds: p.bounds,
    material: p.material,
  }));

  // Dominant look = the most-detailed mesh part's material (parts carry the
  // derived `character`; meshParts are the raw pre-tagged parts).
  const heroPart = parts
    .filter((p) => p.kind === "mesh")
    .sort((a, b) => b.triangles - a.triangles)[0];
  const dominant: { character: Character; metalness: number | null } = heroPart
    ? { character: heroPart.character, metalness: heroPart.material?.metalness ?? null }
    : { character: "—", metalness: null };

  const manifest: ModelManifest = {
    model: modelFile,
    generatedBy: "stereoframe inspect",
    partCount: parts.length,
    meshParts: meshParts.length,
    isSingleMesh: meshParts.length <= 1,
    hasRig: raw.hasRig,
    recommendedFit: 2.6,
    dominant,
    bounds,
    parts,
  };

  const outPath = modelPath.replace(/\.(glb|gltf)$/i, ".segments.json");
  if (opts.write !== false) writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

  if (!opts.silent) {
    if (opts.json) console.log(JSON.stringify(manifest, null, 2));
    else printReport(manifest, longest, outPath);
  }
  return manifest;
}

function printReport(m: ModelManifest, longest: number, outPath: string): void {
  const n = (x: number) => (Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x)));
  const sz = m.bounds.size.map((v) => v.toFixed(2)).join(" × ");
  const off = m.bounds.center.map((v) => Math.abs(v) > longest * 0.05);
  console.log(
    `\n${m.model} — ${m.meshParts} mesh part${m.meshParts === 1 ? "" : "s"}` +
      `${m.partCount > m.meshParts ? ` (+${m.partCount - m.meshParts} empty)` : ""}` +
      `${m.hasRig ? ", rigged" : ""}${m.isSingleMesh ? "  ⚠ single-mesh: explode/isolate/per-part callouts won't separate" : ""}`,
  );
  console.log(`bounds ${sz}  ·  longest dim ${longest.toFixed(3)}  ·  off-origin ${off.some(Boolean) ? "yes" : "no"}  ·  recommendedFit ${m.recommendedFit}\n`);

  const rows = m.parts.map((p) => [
    String(p.index),
    p.name || "(unnamed)",
    p.kind,
    p.kind === "mesh" ? n(p.triangles) : "—",
    p.character,
    p.color ?? "—",
    p.spatial.join("+") || "—",
    p.sizeRank === 0 ? "largest" : p.sizeRank != null ? `#${p.sizeRank + 1}` : "—",
  ]);
  const head = ["#", "name", "kind", "tris", "material", "color", "where", "size"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log(fmt(head));
  console.log(w.map((x) => "─".repeat(x)).join("  "));
  for (const r of rows) console.log(fmt(r));

  // Hero = the most-detailed mesh part (triangle count), a better proxy for
  // "the subject" than bounding-box volume (which favors spread-out parts).
  const hero = m.parts
    .filter((p) => p.kind === "mesh")
    .sort((a, b) => b.triangles - a.triangles)[0];
  if (hero) {
    console.log(`\nTry: isolate + callout the hero part by name —`);
    console.log(`  <sf-animate target="#m" verb="isolate" part="${hero.name || hero.index}" start="1"></sf-animate>`);
    console.log(`  <sf-callout target="#m" part="${hero.name || hero.index}" value="…" text="…" start="1.2"></sf-callout>`);
  }
  console.log(`\nwrote ${outPath}`);
}
