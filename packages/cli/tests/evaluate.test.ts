import { describe, expect, test } from "bun:test";
import {
  auditDefaultFrameTimes,
  buildAuditHtml,
  buildAuditMarkdown,
  buildAuditParts,
  buildAuditSummary,
  buildEvaluationHtml,
  buildEvaluationMarkdown,
  qualityScore,
  selectAuditParts,
  type AuditSummary,
  type EvaluationAsset,
  type EvaluationSummary,
} from "../src/evaluate";
import type { ModelManifest, PartManifest } from "../src/inspect";
import type { QualityReport } from "../src/quality";

const quality = (warnings: QualityReport["warnings"] = []): QualityReport => ({
  generatedBy: "stereoframe evaluate",
  model: "asset.glb",
  metrics: {
    boundsSize: [1, 2, 3],
    longestDimension: 3,
    aspectRatio: 3,
    flatness: 0.33,
    meshParts: 2,
    partCount: 2,
    totalTriangles: 1234,
    isSingleMesh: false,
    offOrigin: false,
    dominantMaterial: "metal",
  },
  warnings,
});

const asset = (label: string, q = quality()): EvaluationAsset =>
  ({
    label,
    source: `/tmp/${label}.glb`,
    asset: `assets/${label}.glb`,
    report: `reports/${label}.quality.json`,
    score: qualityScore(q.warnings),
    quality: q,
    manifest: {},
  }) as EvaluationAsset;

const part = (index: number, name: string, triangles: number, size: number[], spatial: string[] = ["core"]): PartManifest =>
  ({
    index,
    name,
    kind: "mesh",
    skinned: false,
    triangles,
    character: index % 2 === 0 ? "metal" : "matte",
    color: null,
    spatial,
    sizeRank: index,
    bounds: { center: [0, 0, 0], size, min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    material: null,
  }) as PartManifest;

const manifest = (parts: PartManifest[]): ModelManifest =>
  ({
    model: "asset.glb",
    generatedBy: "stereoframe inspect",
    partCount: parts.length,
    meshParts: parts.filter((p) => p.kind === "mesh").length,
    isSingleMesh: parts.filter((p) => p.kind === "mesh").length <= 1,
    hasRig: false,
    recommendedFit: 2.6,
    dominant: { character: "metal", metalness: 0.8 },
    bounds: { center: [0, 0, 0], size: [1, 2, 3], min: [-0.5, -1, -1.5], max: [0.5, 1, 1.5] },
    parts,
  }) as ModelManifest;

const auditAsset = (parts: PartManifest[]): EvaluationAsset =>
  ({
    ...asset("audit-target"),
    manifest: manifest(parts),
  }) as EvaluationAsset;

describe("evaluate", () => {
  test("qualityScore penalizes generated-asset warning patterns", () => {
    expect(qualityScore([])).toBe(100);
    expect(qualityScore([{ code: "single_mesh", message: "single" }])).toBe(85);
    expect(
      qualityScore([
        { code: "thin_flat", message: "flat" },
        { code: "extreme_aspect", message: "aspect" },
        { code: "single_mesh", message: "single" },
      ]),
    ).toBe(55);
  });

  test("buildEvaluationHtml produces a standardized comparison composition", () => {
    const html = buildEvaluationHtml("CI for GLBs", [
      asset("meshy", quality([{ code: "single_mesh", message: "single" }])),
      asset("rodin"),
    ]);
    expect(html).toContain("<sf-scene duration=\"8\"");
    expect(html).toContain('src="assets/meshy.glb"');
    expect(html).toContain('src="assets/rodin.glb"');
    expect(html).toContain("standard rig / comparable evidence");
    expect(html).toContain("single_mesh");
  });

  test("buildEvaluationMarkdown summarizes scores and report outputs", () => {
    const summary: EvaluationSummary = {
      generatedBy: "stereoframe evaluate",
      title: "Evaluation",
      createdAt: "2026-06-14T00:00:00.000Z",
      assets: [
        {
          label: "rodin",
          source: "/tmp/rodin.glb",
          asset: "assets/rodin.glb",
          report: "reports/rodin.quality.json",
          score: 55,
          warnings: ["thin_flat", "single_mesh"],
          metrics: quality().metrics,
        },
      ],
    };
    const md = buildEvaluationMarkdown(summary);
    expect(md).toContain("# Evaluation");
    expect(md).toContain("| rodin | 55 | thin_flat, single_mesh |");
    expect(md).toContain("reports/*.quality.json");
  });

  test("selectAuditParts picks the most detailed separable mesh parts", () => {
    const m = manifest([
      part(0, "Body", 1000, [2, 1, 1]),
      part(1, "Glass", 2400, [0.6, 0.4, 0.2]),
      part(2, "Trim", 150, [0.5, 0.1, 0.1]),
    ]);
    expect(selectAuditParts(m, 2).map((p) => p.name)).toEqual(["Glass", "Body"]);
    expect(buildAuditParts(m).filter((p) => p.selected).map((p) => p.label)).toContain("Glass");
    expect(selectAuditParts(manifest([part(0, "Mesh", 1000, [1, 1, 1])]))).toEqual([]);
  });

  test("auditDefaultFrameTimes covers overview, structure, and selected part evidence", () => {
    const multi = manifest([
      part(0, "Body", 1000, [2, 1, 1]),
      part(1, "Glass", 2400, [0.6, 0.4, 0.2]),
      part(2, "Trim", 150, [0.5, 0.1, 0.1]),
    ]);
    expect(auditDefaultFrameTimes(multi)).toEqual([0, 4.8, 8.95, 11.2, 13.45]);
    expect(buildAuditParts(multi).filter((p) => p.selected).map((p) => p.evidenceTime)).toEqual([11.2, 8.95, 13.45]);

    const single = manifest([part(0, "Mesh", 1000, [1, 1, 1])]);
    expect(auditDefaultFrameTimes(single)).toEqual([0, 4.8, 7.85]);
    expect(buildAuditParts(single)[0]?.evidenceTime).toBeNull();
  });

  test("buildAuditHtml exposes multi-part assets with explode, isolate, and callouts", () => {
    const html = buildAuditHtml("Asset Audit", auditAsset([
      part(0, "Body", 2000, [1, 1, 1], ["core"]),
      part(1, "Lens", 1500, [0.2, 0.2, 0.1], ["front"]),
    ]), buildAuditParts(manifest([
      part(0, "Body", 2000, [1, 1, 1], ["core"]),
      part(1, "Lens", 1500, [0.2, 0.2, 0.1], ["front"]),
    ])));
    expect(html).toContain("animated GLB audit /");
    expect(html).toContain("deterministic evidence");
    expect(html).toContain('verb="explode"');
    expect(html).toContain('verb="isolate"');
    expect(html).toContain("<sf-callout");
    expect(html).toContain("selected parts");
  });

  test("buildAuditHtml is honest for single-mesh assets", () => {
    const m = manifest([part(0, "Mesh 0", 2000, [1, 1, 1])]);
    const html = buildAuditHtml("Single Audit", { ...auditAsset(m.parts), manifest: m }, buildAuditParts(m));
    expect(html).toContain("single-mesh limitation");
    expect(html).toContain("No separable parts");
    expect(html).not.toContain('verb="explode"');
    expect(html).not.toContain('verb="isolate"');
  });

  test("buildAuditMarkdown lists report artifacts and single-mesh limitation", () => {
    const summary: AuditSummary = {
      generatedBy: "stereoframe evaluate --audit",
      title: "Audit",
      createdAt: "2026-06-14T00:00:00.000Z",
      asset: {
        label: "single",
        source: "/tmp/single.glb",
        asset: "assets/single.glb",
        qualityReport: "reports/single.quality.json",
        score: 85,
        warnings: ["single_mesh"],
        metrics: quality([{ code: "single_mesh", message: "single" }]).metrics,
        separable: false,
        selectedPartCount: 0,
      },
      outputs: {
        reportHtml: "report.html",
        markdown: "REPORT.md",
        summary: "reports/summary.json",
        parts: "reports/parts.json",
        frames: [],
      },
      parts: buildAuditParts(manifest([part(0, "Mesh 0", 1000, [1, 1, 1])])),
    };
    const md = buildAuditMarkdown(summary);
    expect(md).toContain("single welded mesh");
    expect(md).toContain("reports/parts.json");
    expect(md).toContain("| 0 | Main body |");
  });

  test("buildAuditSummary records selected parts and output paths", () => {
    const m = manifest([
      part(0, "Body", 2000, [1, 1, 1]),
      part(1, "Lens", 1200, [0.2, 0.2, 0.1]),
    ]);
    const parts = buildAuditParts(m);
    const summary = buildAuditSummary("Audit", { ...auditAsset(m.parts), manifest: m }, parts, {
      reportHtml: "report.html",
      markdown: "REPORT.md",
      summary: "reports/summary.json",
      parts: "reports/parts.json",
      frames: ["frames/audit_0s.png", "frames/audit_8.95s.png"],
      render: "renders/report.mp4",
    });

    expect(summary.generatedBy).toBe("stereoframe evaluate --audit");
    expect(summary.asset.separable).toBe(true);
    expect(summary.asset.selectedPartCount).toBe(2);
    expect(summary.outputs.summary).toBe("reports/summary.json");
    expect(summary.outputs.render).toBe("renders/report.mp4");
    expect(summary.parts.map((p) => p.evidenceTime)).toEqual([8.95, 11.2]);
  });
});
