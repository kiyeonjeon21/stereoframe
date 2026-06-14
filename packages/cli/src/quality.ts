import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ModelManifest } from "./inspect";

export interface QualityWarning {
  code: "thin_flat" | "extreme_aspect" | "single_mesh" | "high_poly" | "low_geometry" | "off_origin";
  message: string;
}

export interface QualityReport {
  generatedBy: "stereoframe gen --quality-report";
  model: string;
  metrics: {
    boundsSize: number[];
    longestDimension: number;
    aspectRatio: number;
    flatness: number;
    meshParts: number;
    partCount: number;
    totalTriangles: number;
    isSingleMesh: boolean;
    offOrigin: boolean;
    dominantMaterial: string;
  };
  warnings: QualityWarning[];
}

function round(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

export function buildQualityReport(manifest: ModelManifest): QualityReport {
  const size = manifest.bounds.size;
  const longest = Math.max(...size);
  const shortest = Math.min(...size.filter((n) => n > 0));
  const aspectRatio = shortest > 0 ? longest / shortest : 0;
  const flatness = longest > 0 ? Math.min(...size) / longest : 0;
  const totalTriangles = manifest.parts.reduce((sum, part) => sum + (part.kind === "mesh" ? part.triangles : 0), 0);
  const offOrigin = manifest.bounds.center.some((v) => Math.abs(v) > longest * 0.05);
  const warnings: QualityWarning[] = [];

  if (flatness > 0 && flatness < 0.12) {
    warnings.push({ code: "thin_flat", message: "model is very thin/flat; check orientation before staging" });
  }
  if (aspectRatio > 8) {
    warnings.push({ code: "extreme_aspect", message: "model has an extreme bounding-box aspect ratio" });
  }
  if (manifest.isSingleMesh) {
    warnings.push({ code: "single_mesh", message: "single welded mesh; explode/isolate/per-part callouts will not separate" });
  }
  if (totalTriangles > 250_000) {
    warnings.push({ code: "high_poly", message: "high triangle count; renders may be slower" });
  }
  if (totalTriangles > 0 && totalTriangles < 100) {
    warnings.push({ code: "low_geometry", message: "very low triangle count; generated asset may be placeholder-like" });
  }
  if (offOrigin) {
    warnings.push({ code: "off_origin", message: "model center is noticeably off origin" });
  }

  return {
    generatedBy: "stereoframe gen --quality-report",
    model: basename(manifest.model),
    metrics: {
      boundsSize: size.map(round),
      longestDimension: round(longest),
      aspectRatio: round(aspectRatio),
      flatness: round(flatness),
      meshParts: manifest.meshParts,
      partCount: manifest.partCount,
      totalTriangles,
      isSingleMesh: manifest.isSingleMesh,
      offOrigin,
      dominantMaterial: manifest.dominant.character,
    },
    warnings,
  };
}

export function writeQualityReport(modelPath: string, manifest: ModelManifest): { path: string; report: QualityReport } {
  const path = /\.(glb|gltf)$/i.test(modelPath)
    ? modelPath.replace(/\.(glb|gltf)$/i, ".quality.json")
    : `${modelPath}.quality.json`;
  const report = buildQualityReport(manifest);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return { path, report };
}
