import { describe, expect, test } from "bun:test";
import { buildEvaluationHtml, buildEvaluationMarkdown, qualityScore, type EvaluationAsset, type EvaluationSummary } from "../src/evaluate";
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
});
