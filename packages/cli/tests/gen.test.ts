import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGenDryRunPlan,
  findGlbUrl,
  imageToDataUri,
  resolveEnvKey,
  sourceImageMetadata,
  validateImageInputs,
  FAL_MODEL_PRESETS,
} from "../src/gen";
import {
  buildOpenAIImageRequest,
  getImageProvider,
  isolationPrompt,
  openaiImageProvider,
  validateOpenAIImageOptions,
} from "../src/imagegen";
import { buildQualityReport, writeQualityReport } from "../src/quality";
import type { ModelManifest } from "../src/inspect";

const tmp = mkdtempSync(join(tmpdir(), "sf-gen-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const originalFetch = globalThis.fetch;
const savedEnv = {
  MESHY_API_KEY: process.env.MESHY_API_KEY,
  FAL_KEY: process.env.FAL_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("imageToDataUri", () => {
  test("encodes a png into a base64 data URI", () => {
    const p = join(tmp, "shot.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uri = imageToDataUri(p);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri.endsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"))).toBe(true);
  });
  test("maps jpg/jpeg to image/jpeg", () => {
    const p = join(tmp, "shot.jpeg");
    writeFileSync(p, Buffer.from([1, 2, 3]));
    expect(imageToDataUri(p).startsWith("data:image/jpeg;base64,")).toBe(true);
  });
  test("rejects unsupported extensions", () => {
    const p = join(tmp, "shot.gif");
    writeFileSync(p, Buffer.from([1]));
    expect(() => imageToDataUri(p)).toThrow(/unsupported image/);
  });
  test("throws on a missing file", () => {
    expect(() => imageToDataUri(join(tmp, "nope.png"))).toThrow(/not found/);
  });
});

describe("resolveEnvKey", () => {
  test("explicit value wins", () => {
    expect(resolveEnvKey("SF_TEST_KEY_XYZ", tmp, "explicit-123")).toBe("explicit-123");
  });
  test("reads from a .env walking up from a subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-env-"));
    writeFileSync(join(root, ".env"), "FOO=bar\nSF_TEST_KEY_XYZ=from-dotenv\n");
    const sub = join(root, "a", "b");
    require("node:fs").mkdirSync(sub, { recursive: true });
    expect(resolveEnvKey("SF_TEST_KEY_XYZ", sub)).toBe("from-dotenv");
    rmSync(root, { recursive: true, force: true });
  });
  test("returns undefined when unset", () => {
    expect(resolveEnvKey("SF_DEFINITELY_UNSET_KEY_999", tmp)).toBeUndefined();
  });
});

describe("imagegen", () => {
  test("isolationPrompt appends the clean-shot guidance", () => {
    const p = isolationPrompt("a red sneaker");
    expect(p).toMatch(/a red sneaker/);
    expect(p).toMatch(/isolated/i);
    expect(p).toMatch(/background/i);
  });
  test("getImageProvider returns openai by default; rejects unknown", () => {
    expect(getImageProvider().name).toBe("openai");
    expect(getImageProvider("openai")).toBe(openaiImageProvider);
    expect(() => getImageProvider("midjourney")).toThrow(/unknown image provider/);
  });
  test("buildOpenAIImageRequest includes optional output controls", () => {
    const req = buildOpenAIImageRequest("a red sneaker", {
      projectDir: tmp,
      model: "gpt-image-2",
      size: "1024x1024",
      quality: "low",
      format: "jpeg",
      compression: 70,
      background: "opaque",
      moderation: "low",
    });
    expect(req.model).toBe("gpt-image-2");
    expect(req.prompt).toMatch(/a red sneaker/);
    expect(req.quality).toBe("low");
    expect(req.output_format).toBe("jpeg");
    expect(req.output_compression).toBe(70);
    expect(req.background).toBe("opaque");
    expect(req.moderation).toBe("low");
  });
  test("validateOpenAIImageOptions rejects invalid compression/format combos", () => {
    expect(validateOpenAIImageOptions({ compression: 50 })).toContain("--image-compression requires --image-format jpeg or webp");
    expect(validateOpenAIImageOptions({ format: "jpeg", compression: 101 })).toContain("--image-compression must be an integer from 0 to 100");
  });
  test("openai provider sends image options and returns metadata without network", async () => {
    process.env.OPENAI_API_KEY = "test-openai";
    let body: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          created: 123,
          data: [{ b64_json: Buffer.from("img").toString("base64"), revised_prompt: "revised" }],
          usage: { total_tokens: 10 },
        }),
        { status: 200, headers: { "x-request-id": "req_123" } },
      );
    }) as typeof fetch;
    const res = await openaiImageProvider.generate("a red sneaker", {
      projectDir: tmp,
      quality: "high",
      format: "webp",
      compression: 42,
    });
    expect(body.output_format).toBe("webp");
    expect(body.output_compression).toBe(42);
    expect(body.quality).toBe("high");
    expect(res.mime).toBe("image/webp");
    expect(res.metadata?.response).toEqual({ requestId: "req_123", created: 123, usage: { total_tokens: 10 }, revisedPrompt: "revised" });
  });
});

describe("gen dry-run helpers", () => {
  test("validates local image inputs and image count", () => {
    const p = join(tmp, "front.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(validateImageInputs({ projectDir: tmp, images: ["front.png"] })).toEqual([]);
    expect(validateImageInputs({ projectDir: tmp, images: ["missing.png"] }).join("; ")).toMatch(/image not found/);
    expect(validateImageInputs({ projectDir: tmp, images: ["a.png", "b.png", "c.png", "d.png", "e.png"] }).join("; ")).toMatch(/1-4/);
    expect(validateImageInputs({ projectDir: tmp, images: ["https://example.com/front.png"] }).join("; ")).toMatch(/remote image URLs/);
    expect(validateImageInputs({ projectDir: tmp, images: ["https://example.com/front.png"], provider: "fal" })).toEqual([]);
  });
  test("buildGenDryRunPlan errors before paid image/via-image calls", () => {
    delete process.env.MESHY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const plan = buildGenDryRunPlan({
      prompt: "a red sneaker",
      projectDir: tmp,
      texture: true,
      viaImage: true,
      imageOptions: { format: "png" },
      qualityReport: true,
    });
    expect(plan.errors).toContain("image-to-3D needs a real MESHY_API_KEY");
    expect(plan.errors).toContain("--via-image needs OPENAI_API_KEY");
    expect(plan.qualityReport).toBe(true);
  });
  test("buildGenDryRunPlan resolves via-image outputs and options when keys are present", () => {
    const plan = buildGenDryRunPlan({
      prompt: "a red sneaker",
      projectDir: tmp,
      out: "assets/shoe.glb",
      texture: true,
      key: "meshy",
      imageKey: "openai",
      viaImage: true,
      imageOptions: { quality: "low", format: "jpeg", compression: 65 },
      imageSize: "1024x1024",
    });
    expect(plan.errors).toEqual([]);
    expect(plan.mode).toBe("via-image");
    expect(plan.output.endsWith("assets/shoe.glb")).toBe(true);
    expect(plan.sourceImageOutput?.endsWith("assets/shoe.source.jpg")).toBe(true);
    expect(plan.imageOptions).toMatchObject({ quality: "low", format: "jpeg", compression: 65, size: "1024x1024" });
  });
  test("sourceImageMetadata records size and hash without storing bytes", () => {
    const p = join(tmp, "hash.png");
    writeFileSync(p, Buffer.from("abc"));
    const meta = sourceImageMetadata(tmp, "hash.png");
    expect(meta.file).toBe("hash.png");
    expect(meta.bytes).toBe(3);
    expect(meta.sha256).toHaveLength(64);
  });
  test("fal presets and GLB finder prefer known output keys", () => {
    expect(FAL_MODEL_PRESETS["tripo3d/tripo/v2.5/image-to-3d"].imageField).toBe("image_url");
    expect(FAL_MODEL_PRESETS["fal-ai/hyper3d/rodin/v2"].imageField).toBe("input_image_urls");
    expect(FAL_MODEL_PRESETS["fal-ai/hyper3d/rodin/v2"].imageFieldMode).toBe("array");
    expect(findGlbUrl({ model_glb_pbr: { url: "https://cdn.example/model.glb" } })).toBe("https://cdn.example/model.glb");
    expect(findGlbUrl({ nested: { file: "https://cdn.example/scan.glb?x=1" } })).toBe("https://cdn.example/scan.glb?x=1");
  });
});

describe("quality report", () => {
  const manifest = (p: Partial<ModelManifest> = {}): ModelManifest => ({
    model: "asset.glb",
    generatedBy: "test",
    partCount: 1,
    meshParts: 1,
    isSingleMesh: true,
    hasRig: false,
    recommendedFit: 2.6,
    dominant: { character: "matte", metalness: 0 },
    bounds: { center: [0.2, 0, 0], size: [10, 1, 0.5], min: [0, 0, 0], max: [10, 1, 0.5] },
    parts: [
      {
        index: 0,
        name: "Body",
        kind: "mesh",
        skinned: false,
        triangles: 300_001,
        character: "matte",
        color: null,
        spatial: ["core"],
        sizeRank: 0,
        bounds: null,
        material: null,
      },
    ],
    ...p,
  });
  test("flags flat, extreme, single-mesh, and high-poly assets", () => {
    const report = buildQualityReport(manifest());
    expect(report.metrics.flatness).toBe(0.05);
    expect(report.metrics.aspectRatio).toBe(20);
    expect(report.warnings.map((w) => w.code)).toEqual(["thin_flat", "extreme_aspect", "single_mesh", "high_poly"]);
  });
  test("writeQualityReport never overwrites extensionless model outputs", () => {
    const out = join(tmp, "extensionless-model");
    const written = writeQualityReport(out, manifest());
    expect(written.path).toBe(`${out}.quality.json`);
    expect(existsSync(written.path)).toBe(true);
  });
});
