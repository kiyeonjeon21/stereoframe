/**
 * `stereoframe evaluate` — a deterministic evidence bundle for generated or
 * production GLBs. It does not try to hide model defects with a cinematic preset:
 * it inspects, scores, compares, and stages assets under one standardized rig.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { inspectModel, type ModelManifest, type PartManifest } from "./inspect";
import { buildQualityReport, type QualityReport, type QualityWarning } from "./quality";
import { resolveRuntimeBundle } from "./scaffold";
import { captureFrame, type FrameResult } from "./frame";
import { renderProject } from "./render";

export interface EvaluationAsset {
  label: string;
  source: string;
  asset: string;
  report: string;
  score: number;
  manifest: ModelManifest;
  quality: QualityReport;
}

export interface EvaluationSummary {
  generatedBy: "stereoframe evaluate";
  title: string;
  createdAt: string;
  assets: Array<{
    label: string;
    source: string;
    asset: string;
    report: string;
    score: number;
    warnings: string[];
    metrics: QualityReport["metrics"];
  }>;
}

export interface EvaluateOptions {
  models: string[];
  outDir: string;
  title?: string;
  frames?: number[];
  render?: boolean;
  draft?: boolean;
}

export interface EvaluateResult {
  dir: string;
  index: string;
  report: string;
  summary: string;
  frames: FrameResult[];
  render?: string;
  assets: EvaluationAsset[];
}

export interface AuditPart {
  index: number;
  name: string;
  label: string;
  kind: PartManifest["kind"];
  material: PartManifest["character"];
  triangles: number;
  spatial: string[];
  sizeRank: number | null;
  boundsSize: number[] | null;
  boundsCenter: number[] | null;
  evidenceTime: number | null;
  selected: boolean;
}

export interface AuditSummary {
  generatedBy: "stereoframe evaluate --audit";
  title: string;
  createdAt: string;
  asset: {
    label: string;
    source: string;
    asset: string;
    qualityReport: string;
    score: number;
    warnings: string[];
    metrics: QualityReport["metrics"];
    separable: boolean;
    selectedPartCount: number;
  };
  outputs: {
    reportHtml: string;
    markdown: string;
    summary: string;
    parts: string;
    frames: string[];
    render?: string;
  };
  parts: AuditPart[];
}

export interface AuditResult {
  dir: string;
  index: string;
  reportHtml: string;
  report: string;
  summary: string;
  parts: string;
  frames: FrameResult[];
  render?: string;
  asset: EvaluationAsset;
  audit: AuditSummary;
}

export interface AuditOptions {
  model: string;
  outDir: string;
  title?: string;
  frames?: number[] | "default";
  render?: boolean;
  draft?: boolean;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.(glb|gltf)$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "model"
  );
}

function uniqueAssetName(path: string, seen: Map<string, number>): string {
  const ext = extname(path).toLowerCase() || ".glb";
  const base = slugify(basename(path));
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return `${base}${count ? `-${count + 1}` : ""}${ext}`;
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

const AUDIT_TIMING = {
  overviewDur: 4.2,
  structureStart: 3.7,
  multiStructureDur: 4.8,
  singleStructureDur: 4.5,
  partDur: 2.7,
  partTransition: 0.45,
  partEvidenceOffset: 0.9,
} as const;

const auditPartStep = (): number => AUDIT_TIMING.partDur - AUDIT_TIMING.partTransition;
const auditPartStart = (index: number): number =>
  AUDIT_TIMING.structureStart + AUDIT_TIMING.multiStructureDur - AUDIT_TIMING.partTransition + index * auditPartStep();

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/'/g, "&#39;");
}

function volume(part: PartManifest): number {
  return part.bounds ? part.bounds.size.reduce((acc, n) => acc * Math.max(0, n), 1) : 0;
}

function humanizeName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return "";
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function isGenericName(name: string): boolean {
  const s = (name ?? "").trim();
  return (
    !s ||
    s.length <= 1 ||
    /^(mesh|node|object|primitive|group|polysurface|geometry|default|material)[\s._-]*\d*$/i.test(s) ||
    /^\d+$/.test(s)
  );
}

function partLabel(part: PartManifest): string {
  if (!isGenericName(part.name)) return humanizeName(part.name);
  if (part.sizeRank === 0) return "Main body";
  const place = part.spatial.filter((s) => s !== "core").map((s) => s[0]!.toUpperCase() + s.slice(1)).join(" ");
  if (part.character !== "—") return `${part.character[0]!.toUpperCase()}${part.character.slice(1)}${place ? ` ${place}` : ""}`;
  if (place) return `${place} component`;
  return `Part ${part.index + 1}`;
}

function partText(part: PartManifest): string {
  const material = part.character === "—" ? "component" : part.character;
  const tris = part.triangles > 0 ? `${part.triangles.toLocaleString()} tris` : "no mesh";
  return `${material} / ${tris}`;
}

export function selectAuditParts(manifest: ModelManifest, max = 4): PartManifest[] {
  const meshParts = manifest.parts.filter((p) => p.kind === "mesh" && p.bounds);
  if (meshParts.length < 2) return [];
  return [...meshParts]
    .sort((a, b) => b.triangles - a.triangles || volume(b) - volume(a) || a.index - b.index)
    .slice(0, max);
}

export function buildAuditParts(manifest: ModelManifest, selected = selectAuditParts(manifest)): AuditPart[] {
  const selectedIds = new Set(selected.map((p) => p.index));
  const evidenceTimes = new Map(
    selected.map((part, i) => [part.index, Number((auditPartStart(i) + AUDIT_TIMING.partEvidenceOffset).toFixed(3))]),
  );
  return manifest.parts.map((part) => ({
    index: part.index,
    name: part.name || "",
    label: partLabel(part),
    kind: part.kind,
    material: part.character,
    triangles: part.triangles,
    spatial: part.spatial,
    sizeRank: part.sizeRank,
    boundsSize: part.bounds ? part.bounds.size.map((n) => Number(n.toFixed(4))) : null,
    boundsCenter: part.bounds ? part.bounds.center.map((n) => Number(n.toFixed(4))) : null,
    evidenceTime: evidenceTimes.get(part.index) ?? null,
    selected: selectedIds.has(part.index),
  }));
}

export function auditDefaultFrameTimes(manifest: ModelManifest): number[] {
  const selected = selectAuditParts(manifest);
  const structureEvidence = AUDIT_TIMING.structureStart + 1.1;
  if (selected.length === 0) {
    return [
      0,
      Number(structureEvidence.toFixed(3)),
      Number((AUDIT_TIMING.structureStart + AUDIT_TIMING.singleStructureDur - 0.35).toFixed(3)),
    ];
  }
  return [
    0,
    Number(structureEvidence.toFixed(3)),
    ...selected.map((_, i) => Number((auditPartStart(i) + AUDIT_TIMING.partEvidenceOffset).toFixed(3))),
  ];
}

export function qualityScore(warnings: QualityWarning[]): number {
  const weights: Record<QualityWarning["code"], number> = {
    thin_flat: 18,
    extreme_aspect: 12,
    single_mesh: 15,
    high_poly: 10,
    low_geometry: 30,
    off_origin: 12,
  };
  const penalty = warnings.reduce((sum, w) => sum + weights[w.code], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function labelForModel(path: string): string {
  return basename(path).replace(/\.(glb|gltf)$/i, "");
}

function buildSummary(title: string, assets: EvaluationAsset[]): EvaluationSummary {
  return {
    generatedBy: "stereoframe evaluate",
    title,
    createdAt: new Date().toISOString(),
    assets: assets.map((asset) => ({
      label: asset.label,
      source: asset.source,
      asset: asset.asset,
      report: asset.report,
      score: asset.score,
      warnings: asset.quality.warnings.map((w) => w.code),
      metrics: asset.quality.metrics,
    })),
  };
}

export function buildEvaluationMarkdown(summary: EvaluationSummary): string {
  const lines = [
    `# ${summary.title}`,
    "",
    "Deterministic GLB evaluation bundle generated by `stereoframe evaluate`.",
    "",
    "| Asset | Score | Warnings | Triangles | Parts | Bounds | Material |",
    "|---|---:|---|---:|---:|---|---|",
  ];
  for (const asset of summary.assets) {
    const metrics = asset.metrics;
    const bounds = metrics.boundsSize.map((n) => Number(n).toFixed(2)).join(" x ");
    lines.push(
      `| ${asset.label} | ${asset.score} | ${asset.warnings.join(", ") || "none"} | ${metrics.totalTriangles} | ${metrics.partCount} | ${bounds} | ${metrics.dominantMaterial} |`,
    );
  }
  lines.push(
    "",
    "## Outputs",
    "",
    "- `index.html` — standardized side-by-side preview composition.",
    "- `reports/summary.json` — machine-readable metrics, warnings, and scores.",
    "- `reports/*.quality.json` — per-asset quality reports.",
    "- `frames/` — optional standardized frame captures when `--frames` is used.",
    "- `renders/evaluation.mp4` — optional preview render when `--render` is used.",
    "",
    "Scores are heuristic evidence, not a claim of visual quality. Inspect the frames/video before accepting an asset.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function metricRows(asset: EvaluationAsset): string {
  const m = asset.quality.metrics;
  const rows = [
    ["score", String(asset.score)],
    ["warnings", asset.quality.warnings.map((w) => w.code).join(", ") || "none"],
    ["triangles", m.totalTriangles.toLocaleString()],
    ["parts", String(m.partCount)],
    ["mesh parts", String(m.meshParts)],
    ["bounds", m.boundsSize.map((n) => Number(n).toFixed(2)).join(" x ")],
    ["material", m.dominantMaterial],
  ];
  return rows.map(([k, v]) => `<div><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join("\n");
}

function auditCallouts(targetId: string, parts: PartManifest[], start = 1.2): string {
  return parts
    .map((part, i) => {
      const anchor = part.spatial.includes("left") ? "left" : i % 2 === 0 ? "right" : "left";
      const leadY = -82 - i * 42;
      return `      <sf-callout target="#${targetId}" part="${part.index}" value="${escapeAttr(partLabel(part))}" text="${escapeAttr(partText(part))}" anchor="${anchor}" lead-y="${leadY}" start="${fmt(start + i * 0.32)}" duration="0.7"></sf-callout>`;
    })
    .join("\n");
}

function partRows(parts: AuditPart[]): string {
  return parts
    .filter((part) => part.kind === "mesh")
    .map(
      (part) => `<tr>
        <td>${part.index}</td>
        <td>${escapeHtml(part.label)}</td>
        <td>${escapeHtml(part.material)}</td>
        <td>${part.triangles.toLocaleString()}</td>
        <td>${escapeHtml(part.spatial.join(" / ") || "core")}</td>
      </tr>`,
    )
    .join("\n");
}

export function buildAuditMarkdown(summary: AuditSummary): string {
  const lines = [
    `# ${summary.title}`,
    "",
    "Animated GLB audit report generated by `stereoframe evaluate --audit`.",
    "",
    `- Asset: ${summary.asset.label}`,
    `- Score: ${summary.asset.score}`,
    `- Warnings: ${summary.asset.warnings.join(", ") || "none"}`,
    `- Separable mesh parts: ${summary.asset.separable ? "yes" : "no"}`,
    "",
    "| Part | Label | Material | Triangles | Spatial | Evidence time | Selected |",
    "|---:|---|---|---:|---|---:|---|",
  ];
  for (const part of summary.parts.filter((p) => p.kind === "mesh")) {
    lines.push(
      `| ${part.index} | ${part.label} | ${part.material} | ${part.triangles} | ${part.spatial.join(" / ") || "core"} | ${part.evidenceTime === null ? "—" : `${fmt(part.evidenceTime)}s`} | ${part.selected ? "yes" : "no"} |`,
    );
  }
  if (!summary.asset.separable) {
    lines.push(
      "",
      "## Limitation",
      "",
      "This GLB is a single welded mesh. Per-part teardown, isolation, and tracked callouts are limited until the asset is split into separable components.",
    );
  }
  lines.push(
    "",
    "## Outputs",
    "",
    "- `report.html` / `index.html` - animated audit composition.",
    "- `reports/summary.json` - machine-readable score, metrics, warnings, and output paths.",
    "- `reports/parts.json` - inspect-derived part table used by the audit.",
    "- `reports/*.quality.json` - deterministic geometry/material quality report.",
    "- `frames/` - optional evidence frame captures when `--frames` is used; audit defaults include overview, structure, and selected-part thumbnail times.",
    "- `renders/report.mp4` - optional animated report when `--render` is used.",
    "",
    "Scores and warnings come from GLB geometry/material metadata. Captured frames are evidence for review, not the source of truth for scoring.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function buildAuditHtml(title: string, asset: EvaluationAsset, parts: AuditPart[]): string {
  const selected = selectAuditParts(asset.manifest);
  const separable = selected.length > 0;
  const structureStart = AUDIT_TIMING.structureStart;
  const structureDur = separable ? AUDIT_TIMING.multiStructureDur : AUDIT_TIMING.singleStructureDur;
  const partDur = AUDIT_TIMING.partDur;
  const partTransition = AUDIT_TIMING.partTransition;
  const partStep = auditPartStep();
  const partStart = auditPartStart(0);
  const overviewCardDur = structureStart;
  const structureCardDur = separable ? partStart - structureStart : structureDur;
  const partCardDur = partStep;
  const total = separable ? partStart + Math.max(0, selected.length - 1) * partStep + partDur : structureStart + structureDur;
  const qualityWarnings = asset.quality.warnings.map((w) => w.code).join(", ") || "none";
  const assetName = escapeHtml(asset.label);
  const partScenes = selected
    .map((part, i) => {
      const start = partStart + i * partStep;
      const id = `mPart${i + 1}`;
      const side = i % 2 === 0 ? "right" : "left";
      return `    <sf-scene start="${fmt(start)}" duration="${fmt(partDur)}" transition="crossfade" transition-duration="${fmt(partTransition)}"
              width="1920" height="1080" background="#020305" environment="room" exposure="0.94"
              samples="2" bloom="0.08" bloom-threshold="0.9" vignette="0.38"
              grain="0.012" contrast="1.08" saturation="1.04" ground="contact-shadow"
              ground-y="0" ground-size="6" light-sweep="0.035">
      <sf-camera fov="32" position="${side === "right" ? "2.8" : "-2.8"} 1.05 4.7" look-at="0 0.9 0"></sf-camera>
      <sf-light type="hemisphere" color="#263041" intensity="0.45"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="1.9" position="4 5 5"></sf-light>
      <sf-light type="directional" color="#8fc8ff" intensity="1.35" position="-5 3 -4"></sf-light>
      <sf-model id="${id}" src="${asset.asset}" fit="2.55" fit-ground></sf-model>
      <sf-animate target="#${id}" verb="isolate" part="${part.index}" dim="0.86" start="0.25" duration="0.8"></sf-animate>
      <sf-animate target="camera" verb="dolly" toward="0 0.9 0" distance="0.42" start="0" duration="${fmt(partDur)}" ease="sine.inOut"></sf-animate>
      <sf-callout target="#${id}" part="${part.index}" value="${escapeAttr(partLabel(part))}" text="${escapeAttr(partText(part))}" anchor="${side}" start="0.9" duration="0.7"></sf-callout>
      <sf-animate target="#part-card-${i}" verb="fade-in" start="0.35" duration="0.6" rise="20"></sf-animate>
    </sf-scene>`;
    })
    .join("\n\n");
  const partCards = selected
    .map((part, i) => {
      const start = partStart + i * partStep;
      const bounds = part.bounds ? part.bounds.size.map((n) => n.toFixed(2)).join(" x ") : "unknown";
      return `    <div id="part-card-${i}" class="audit-card clip ${i % 2 === 0 ? "right" : "left"}" data-start="${fmt(start)}" data-duration="${fmt(partCardDur)}">
      <div class="eyebrow">isolated part</div>
      <h2>${escapeHtml(partLabel(part))}</h2>
      <div class="metric-grid">
        <div><span>index</span><strong>${part.index}</strong></div>
        <div><span>material</span><strong>${escapeHtml(part.character)}</strong></div>
        <div><span>triangles</span><strong>${part.triangles.toLocaleString()}</strong></div>
        <div><span>bounds</span><strong>${escapeHtml(bounds)}</strong></div>
      </div>
    </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #020305; }
      body { font-family: "Helvetica Neue", Arial, sans-serif; color: #f7f7f2; }
      sf-scene { position: absolute; inset: 0; }
      .topbar { position: absolute; left: 64px; right: 64px; top: 44px; display: flex; align-items: baseline; justify-content: space-between; pointer-events: none; z-index: 20; }
      .title { font-size: 28px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
      .stamp { font-size: 13px; letter-spacing: 0.24em; text-transform: uppercase; color: #91abc3; }
      .audit-card { position: absolute; z-index: 18; width: 500px; top: 168px; padding: 22px 24px 24px; border-top: 1px solid rgba(255,255,255,0.26); background: linear-gradient(180deg, rgba(10,13,18,0.82), rgba(10,13,18,0.36)); pointer-events: none; }
      .audit-card.left { left: 64px; }
      .audit-card.right { right: 64px; }
      .audit-card.bottom { top: auto; bottom: 64px; width: 650px; }
      .eyebrow { font-size: 12px; letter-spacing: 0.22em; text-transform: uppercase; color: #8fd0ff; margin-bottom: 12px; }
      h1, h2 { font-size: 34px; line-height: 1.05; font-weight: 800; letter-spacing: 0; margin-bottom: 16px; }
      p { font-size: 17px; line-height: 1.45; color: #c8d2dc; max-width: 590px; }
      .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; margin-top: 16px; }
      .metric-grid div { border-top: 1px solid rgba(255,255,255,0.14); padding-top: 10px; min-width: 0; }
      .metric-grid span { display: block; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #8494a3; margin-bottom: 5px; }
      .metric-grid strong { display: block; font-size: 20px; line-height: 1.12; font-weight: 750; overflow-wrap: anywhere; }
      .warning { color: #ffcf8a; }
      .part-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 14px; color: #d9e3ec; }
      .part-table th, .part-table td { text-align: left; border-top: 1px solid rgba(255,255,255,0.12); padding: 7px 8px 7px 0; white-space: nowrap; }
      .part-table th { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #8ea6bd; }
    </style>
  </head>
  <body>
    <sf-scene start="0" duration="4.2" width="1920" height="1080" background="#020305"
              environment="room" exposure="0.92" samples="2" bloom="0.08" bloom-threshold="0.9"
              vignette="0.34" contrast="1.08" saturation="1.04" grain="0.012"
              chromatic-aberration="0.035" ground="contact-shadow" ground-y="0" ground-size="7" light-sweep="0.05">
      <sf-camera fov="35" position="0 1.15 5.7" look-at="0 0.9 0"></sf-camera>
      <sf-light type="hemisphere" color="#263041" intensity="0.45"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="1.8" position="4 5 5"></sf-light>
      <sf-light type="directional" color="#8fc8ff" intensity="1.5" position="-5 3 -4"></sf-light>
      <sf-model id="mOverview" src="${asset.asset}" fit="2.55" fit-ground></sf-model>
      <sf-animate target="#mOverview" verb="turntable" rpm="2.2"></sf-animate>
      <sf-animate target="#overview-card" verb="fade-in" start="0.25" duration="0.7" rise="22"></sf-animate>
      <sf-animate target="camera" verb="dolly" toward="0 0.9 0" distance="0.32" start="0" duration="4.2" ease="sine.inOut"></sf-animate>
    </sf-scene>

    <sf-scene start="${fmt(structureStart)}" duration="${fmt(structureDur)}" transition="crossfade" transition-duration="0.5"
              width="1920" height="1080" background="#020305" environment="room" exposure="0.9"
              samples="2" bloom="0.08" bloom-threshold="0.9" vignette="0.36"
              contrast="1.08" saturation="1.04" grain="0.012" ground="contact-shadow"
              ground-y="0" ground-size="7" light-sweep="0.04">
      <sf-camera fov="37" position="0 0.85 6.2" look-at="0 0.75 0"></sf-camera>
      <sf-light type="hemisphere" color="#263041" intensity="0.45"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="1.8" position="4 5 5"></sf-light>
      <sf-light type="directional" color="#8fc8ff" intensity="1.45" position="-5 3 -4"></sf-light>
      <sf-model id="mStructure" src="${asset.asset}" fit="2.45" fit-ground></sf-model>
      ${
        separable
          ? `<sf-animate target="#mStructure" verb="explode" distance="0.72" start="0.55" duration="1.8" ease="power2.inOut"></sf-animate>
      ${auditCallouts("mStructure", selected, 2.2)}`
          : `<sf-animate target="#mStructure" verb="turntable" rpm="1.8"></sf-animate>`
      }
      <sf-animate target="camera" verb="orbit" around="0 0.75 0" radius="6.2" from="-18deg" to="18deg" height="0.75" start="0" duration="${fmt(structureDur)}" ease="sine.inOut"></sf-animate>
      <sf-animate target="#structure-card" verb="fade-in" start="0.35" duration="0.7" rise="22"></sf-animate>
    </sf-scene>

${partScenes}

    <div class="topbar">
      <div class="title">${escapeHtml(title)}</div>
      <div class="stamp">animated GLB audit / ${fmt(total)}s deterministic evidence</div>
    </div>

    <div id="overview-card" class="audit-card right clip" data-start="0" data-duration="${fmt(overviewCardDur)}">
      <div class="eyebrow">asset overview</div>
      <h1>${assetName}</h1>
      <div class="metric-grid">
${metricRows(asset)}
      </div>
    </div>

    <div id="structure-card" class="audit-card left bottom clip" data-start="${fmt(structureStart)}" data-duration="${fmt(structureCardDur)}">
      <div class="eyebrow">${separable ? "part structure" : "single-mesh limitation"}</div>
      <h2>${separable ? `${selected.length} selected parts` : "No separable parts"}</h2>
      <p>${separable ? "Exploded motion and tracked callouts prove which components can be isolated, labelled, and directed." : "This asset loads and can be previewed, but per-part teardown, isolation, and callouts are limited because the GLB appears to be one welded mesh."}</p>
      <div class="metric-grid">
        <div><span>mesh parts</span><strong>${asset.manifest.meshParts}</strong></div>
        <div><span>selected</span><strong>${selected.length}</strong></div>
        <div><span>status</span><strong class="${separable ? "" : "warning"}">${separable ? "separable" : "single mesh"}</strong></div>
        <div><span>warnings</span><strong>${escapeHtml(qualityWarnings)}</strong></div>
      </div>
      ${
        separable
          ? `<table class="part-table">
        <thead><tr><th>#</th><th>label</th><th>mat</th><th>tris</th><th>where</th></tr></thead>
        <tbody>
${partRows(parts.filter((p) => p.selected))}
        </tbody>
      </table>`
          : ""
      }
    </div>

${partCards}

    <script type="module">
      import "./assets/stereoframe.js";
    </script>
  </body>
</html>
`;
}

export function buildAuditSummary(
  title: string,
  asset: EvaluationAsset,
  parts: AuditPart[],
  outputs: AuditSummary["outputs"],
): AuditSummary {
  const selectedPartCount = parts.filter((p) => p.selected).length;
  return {
    generatedBy: "stereoframe evaluate --audit",
    title,
    createdAt: new Date().toISOString(),
    asset: {
      label: asset.label,
      source: asset.source,
      asset: asset.asset,
      qualityReport: asset.report,
      score: asset.score,
      warnings: asset.quality.warnings.map((w) => w.code),
      metrics: asset.quality.metrics,
      separable: selectedPartCount > 0,
      selectedPartCount,
    },
    outputs,
    parts,
  };
}

export function buildEvaluationHtml(title: string, assets: EvaluationAsset[]): string {
  const count = assets.length;
  const spacing = count <= 1 ? 0 : count === 2 ? 3.1 : count === 3 ? 2.45 : 2.0;
  const fit = count <= 1 ? 2.6 : count === 2 ? 2.15 : count === 3 ? 1.75 : 1.45;
  const x0 = -((count - 1) * spacing) / 2;
  const models = assets
    .map((asset, i) => {
      const x = x0 + i * spacing;
      return `      <sf-model id="m${i + 1}" src="${asset.asset}" fit="${fit}" fit-ground position="${x.toFixed(2)} 0 0"></sf-model>
      <sf-animate target="#m${i + 1}" verb="turntable" rpm="3"></sf-animate>
      <sf-animate target="#m${i + 1}" verb="sway" amount="0.25" period="7"></sf-animate>`;
    })
    .join("\n");
  const labels = assets
    .map((asset) => {
      const warnings = asset.quality.warnings.map((w) => w.code).join(", ") || "no warnings";
      return `      <div class="asset">
        <div class="name">${escapeHtml(asset.label)}</div>
        <div class="score">${asset.score}</div>
        <div class="meta">${escapeHtml(warnings)}</div>
      </div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #08090c; }
      body { font-family: "Helvetica Neue", Arial, sans-serif; color: #f7f7f2; }
      sf-scene { position: absolute; inset: 0; }
      .hud { position: absolute; left: 70px; right: 70px; top: 48px; display: flex; align-items: baseline; justify-content: space-between; pointer-events: none; }
      .title { font-size: 30px; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
      .stamp { font-size: 14px; letter-spacing: 0.26em; text-transform: uppercase; color: #8ea6bd; }
      .labels { position: absolute; left: 70px; right: 70px; bottom: 48px; display: grid; grid-template-columns: repeat(${count}, minmax(0, 1fr)); gap: 16px; pointer-events: none; }
      .asset { min-height: 112px; border-top: 1px solid rgba(255,255,255,0.22); padding-top: 14px; background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0)); }
      .name { font-size: 18px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .score { margin-top: 9px; font-size: 42px; font-weight: 800; line-height: 1; color: #f4f7fb; }
      .meta { margin-top: 8px; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #8fd0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    </style>
  </head>
  <body>
    <sf-scene duration="8" width="1920" height="1080" background="#08090c"
              environment="room" exposure="0.92" samples="2" bloom="0.08"
              bloom-threshold="0.9" vignette="0.24" contrast="1.07" saturation="1.02"
              grain="0.01" chromatic-aberration="0.035" ground="contact-shadow"
              ground-y="0" ground-size="7" light-sweep="0.05">
      <sf-camera fov="36" position="0 1.18 6.2" look-at="0 0.9 0"></sf-camera>
      <sf-light type="hemisphere" color="#263041" intensity="0.45"></sf-light>
      <sf-light type="directional" color="#ffffff" intensity="1.8" position="4 5 5"></sf-light>
      <sf-light type="directional" color="#8fc8ff" intensity="1.5" position="-5 3 -4"></sf-light>
      <sf-mesh geometry="plane" args="64 64" rotation="-90 0 0" position="0 -0.01 0"
               color="#111318" metalness="0.25" roughness="0.55"></sf-mesh>
${models}
      <sf-animate target="camera" verb="orbit" around="0 0.9 0" radius="6.2"
                  from="-10deg" to="10deg" height="1.18" start="0" duration="8"
                  ease="sine.inOut"></sf-animate>
    </sf-scene>

    <div class="hud">
      <div class="title">${escapeHtml(title)}</div>
      <div class="stamp">standard rig / comparable evidence</div>
    </div>
    <div class="labels">
${labels}
    </div>

    <script type="module">
      import "./assets/stereoframe.js";
    </script>
  </body>
</html>
`;
}

export async function evaluateModels(opts: EvaluateOptions): Promise<EvaluateResult> {
  if (opts.models.length === 0) throw new Error("evaluate needs at least one GLB");
  if (opts.models.length > 4) throw new Error("evaluate supports 1-4 GLBs per comparison suite");

  const dir = resolve(opts.outDir);
  const assetsDir = join(dir, "assets");
  const reportsDir = join(dir, "reports");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  copyFileSync(resolveRuntimeBundle(), join(assetsDir, "stereoframe.js"));

  const seen = new Map<string, number>();
  const assets: EvaluationAsset[] = [];
  for (const model of opts.models) {
    const source = resolve(model);
    if (!existsSync(source)) throw new Error(`model not found: ${source}`);
    const assetName = uniqueAssetName(source, seen);
    const assetRel = `assets/${assetName}`;
    copyFileSync(source, join(dir, assetRel));

    const manifest = await inspectModel({ model: source, silent: true, write: false });
    const quality = buildQualityReport(manifest);
    quality.generatedBy = "stereoframe evaluate";
    const reportRel = `reports/${assetName.replace(/\.(glb|gltf)$/i, ".quality.json")}`;
    writeFileSync(join(dir, reportRel), JSON.stringify(quality, null, 2) + "\n");
    assets.push({
      label: labelForModel(source),
      source,
      asset: assetRel,
      report: reportRel,
      score: qualityScore(quality.warnings),
      manifest,
      quality,
    });
  }

  const title = opts.title ?? "GLB Evaluation";
  const summary = buildSummary(title, assets);
  const summaryPath = join(reportsDir, "summary.json");
  const reportPath = join(dir, "REPORT.md");
  const indexPath = join(dir, "index.html");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(reportPath, buildEvaluationMarkdown(summary));
  writeFileSync(indexPath, buildEvaluationHtml(title, assets));
  writeFileSync(join(dir, ".gitignore"), "renders/\nframes/\n");

  const frames: FrameResult[] = [];
  for (const t of opts.frames ?? []) {
    const safe = String(t).replace(/[^0-9.]+/g, "_");
    frames.push(await captureFrame({ projectDir: dir, t, out: `frames/eval_${safe}s.png` }));
  }
  const render = opts.render
    ? await renderProject({ projectDir: dir, out: "renders/evaluation.mp4", draft: opts.draft })
    : undefined;

  return { dir, index: indexPath, report: reportPath, summary: summaryPath, frames, render, assets };
}

export async function auditModel(opts: AuditOptions): Promise<AuditResult> {
  const source = resolve(opts.model);
  if (!existsSync(source)) throw new Error(`model not found: ${source}`);

  const dir = resolve(opts.outDir);
  const assetsDir = join(dir, "assets");
  const reportsDir = join(dir, "reports");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  copyFileSync(resolveRuntimeBundle(), join(assetsDir, "stereoframe.js"));

  const assetName = uniqueAssetName(source, new Map());
  const assetRel = `assets/${assetName}`;
  copyFileSync(source, join(dir, assetRel));

  const manifest = await inspectModel({ model: source, silent: true, write: false });
  const quality = buildQualityReport(manifest);
  quality.generatedBy = "stereoframe evaluate";
  const reportRel = `reports/${assetName.replace(/\.(glb|gltf)$/i, ".quality.json")}`;
  writeFileSync(join(dir, reportRel), JSON.stringify(quality, null, 2) + "\n");

  const asset: EvaluationAsset = {
    label: labelForModel(source),
    source,
    asset: assetRel,
    report: reportRel,
    score: qualityScore(quality.warnings),
    manifest,
    quality,
  };
  const title = opts.title ?? `${asset.label} Audit`;
  const parts = buildAuditParts(manifest);
  const reportHtml = join(dir, "report.html");
  const indexPath = join(dir, "index.html");
  const html = buildAuditHtml(title, asset, parts);
  writeFileSync(reportHtml, html);
  writeFileSync(indexPath, html);
  writeFileSync(join(reportsDir, "parts.json"), JSON.stringify(parts, null, 2) + "\n");
  writeFileSync(join(dir, ".gitignore"), "renders/\nframes/\n");

  const frames: FrameResult[] = [];
  const frameTimes = opts.frames === "default" ? auditDefaultFrameTimes(manifest) : opts.frames ?? [];
  for (const t of frameTimes) {
    const safe = String(t).replace(/[^0-9.]+/g, "_");
    frames.push(await captureFrame({ projectDir: dir, t, out: `frames/audit_${safe}s.png` }));
  }
  const render = opts.render
    ? await renderProject({ projectDir: dir, out: "renders/report.mp4", draft: opts.draft })
    : undefined;

  const summaryPath = join(reportsDir, "summary.json");
  const partsPath = join(reportsDir, "parts.json");
  const markdownPath = join(dir, "REPORT.md");
  const summary = buildAuditSummary(title, asset, parts, {
    reportHtml: "report.html",
    markdown: "REPORT.md",
    summary: "reports/summary.json",
    parts: "reports/parts.json",
    frames: frames.map((frame) => frame.out.replace(`${dir}/`, "")),
    ...(render ? { render: render.replace(`${dir}/`, "") } : {}),
  });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(markdownPath, buildAuditMarkdown(summary));

  return {
    dir,
    index: indexPath,
    reportHtml,
    report: markdownPath,
    summary: summaryPath,
    parts: partsPath,
    frames,
    render,
    asset,
    audit: summary,
  };
}
