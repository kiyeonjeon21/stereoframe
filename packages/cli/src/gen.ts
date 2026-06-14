/**
 * `stereoframe gen "<prompt>"` — generate a 3D model and download it as a
 * self-contained GLB into the project's assets/. Default backend is Meshy;
 * `--provider fal` routes through fal.ai (premium, pay-as-you-go) instead.
 *
 * Flow (Meshy async REST): submit a preview task → poll → (optionally) submit
 * a refine task for PBR textures → poll → download `model_urls.glb`.
 * fal flow (queue REST): submit → poll status → fetch result → download the GLB.
 * All backends output a single welded mesh (no separable parts).
 *
 * Key resolution: --key flag, then MESHY_API_KEY (env or project .env), then
 * Meshy's public test-mode key — which returns a sample model for free, so
 * the whole pipeline runs end-to-end with zero setup (the result ignores the
 * prompt; set a real key for actual generations).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  extensionForImageMime,
  getImageProvider,
  mimeForImageFormat,
  validateOpenAIImageOptions,
  type OpenAIImageOptions,
} from "./imagegen";

const MESHY_BASE = "https://api.meshy.ai";
const TEST_KEY = "msy_dummy_api_key_for_test_mode_12345678";

/** Resolve an API key from --flag, the env var, or a `.env` found by walking up
 *  from projectDir (so it works run from any subdirectory). Returns undefined if
 *  unset — callers decide whether that's fatal or has a fallback. Shared by gen
 *  (MESHY_API_KEY), brief + image gen (OPENAI_API_KEY). */
export function resolveEnvKey(varName: string, projectDir: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env[varName]) return process.env[varName];
  let dir = resolve(projectDir);
  for (let i = 0; i < 6; i++) {
    const envPath = join(dir, ".env");
    if (existsSync(envPath)) {
      const line = readFileSync(envPath, "utf8")
        .split("\n")
        .find((l) => l.startsWith(`${varName}=`));
      const v = line?.slice(varName.length + 1).trim();
      if (v) return v;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface GenOptions {
  prompt: string;
  projectDir: string;
  out?: string;
  texture: boolean;
  polycount?: number;
  key?: string;
  /** "fal" routes generation through fal.ai (premium, PAYG) instead of Meshy. */
  provider?: "meshy" | "fal";
  falModel?: string;
  falInput?: Record<string, unknown>;
}

function resolveKey(projectDir: string, explicit?: string): { key: string; isTest: boolean } {
  const key = resolveEnvKey("MESHY_API_KEY", projectDir, explicit);
  return key ? { key, isTest: false } : { key: TEST_KEY, isTest: true };
}

export function slug(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "model"
  );
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export interface SourceImageMetadata {
  source: string;
  file: string;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  inline?: boolean;
  remote?: boolean;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function dataUriMetadata(uri: string): SourceImageMetadata {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
  if (!m) throw new Error("malformed image data URI");
  const bytes = Buffer.from(m[2]!, "base64");
  return { source: "<inline>", file: "<inline>", mime: m[1]!, bytes: bytes.length, sha256: sha256(bytes), inline: true };
}

export function sourceImageMetadata(projectDir: string, image: string): SourceImageMetadata {
  if (image.startsWith("data:")) return dataUriMetadata(image);
  if (/^https?:\/\//i.test(image)) {
    let file = image;
    try {
      file = basename(new URL(image).pathname) || image;
    } catch {
      // Keep the original string as a fallback label.
    }
    return { source: file, file, mime: null, bytes: null, sha256: null, remote: true };
  }
  const abs = resolve(projectDir, image);
  const ext = extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? null;
  const bytes = readFileSync(abs);
  return { source: image, file: basename(image), mime, bytes: statSync(abs).size, sha256: sha256(bytes) };
}

export function validateImageInputs(opts: { projectDir: string; images: string[]; provider?: "meshy" | "fal" }): string[] {
  const errors: string[] = [];
  if (opts.images.length === 0) errors.push("no images provided");
  if (opts.images.length > 4) errors.push("--images accepts 1-4 images");
  for (const image of opts.images) {
    if (image.startsWith("data:")) {
      try {
        dataUriMetadata(image);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (/^https?:\/\//i.test(image)) {
      if (opts.provider !== "fal") errors.push(`remote image URLs are only supported with --provider fal: ${image}`);
      continue;
    }
    const abs = resolve(opts.projectDir, image);
    const ext = extname(abs).toLowerCase();
    if (!IMAGE_MIME[ext]) errors.push(`unsupported image type "${ext}" for ${image} (use png/jpg/webp)`);
    if (!existsSync(abs)) errors.push(`image not found: ${abs}`);
  }
  return errors;
}

function sourceImagePath(projectDir: string, out: string | undefined, prompt: string, mime: string): string {
  const ext = extensionForImageMime(mime);
  if (out) {
    const next = /\.glb$/i.test(out) ? out.replace(/\.glb$/i, `.source.${ext}`) : `${out}.source.${ext}`;
    return resolve(projectDir, next);
  }
  return resolve(projectDir, join("assets", `${slug(prompt)}.source.${ext}`));
}

export function buildGenOutputPath(projectDir: string, label: string, out?: string): string {
  return resolve(projectDir, out ?? join("assets", `${slug(label || "model")}.glb`));
}

function compactSourceImage(meta: SourceImageMetadata): Record<string, unknown> {
  return {
    file: meta.file,
    ...(meta.mime ? { mime: meta.mime } : {}),
    ...(meta.bytes != null ? { bytes: meta.bytes } : {}),
    ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    ...(meta.inline ? { inline: true } : {}),
    ...(meta.remote ? { remote: true } : {}),
  };
}

function imageLabel(images: string[]): string {
  return basename(images[0] ?? "model").replace(/\.(png|jpe?g|webp)$/i, "");
}

export interface GenDryRunOptions {
  prompt: string;
  projectDir: string;
  out?: string;
  texture: boolean;
  polycount?: number;
  key?: string;
  image?: string;
  images?: string[];
  viaImage?: boolean;
  imageKey?: string;
  imageProvider?: string;
  imageModel?: string;
  imageSize?: string;
  imageOptions?: OpenAIImageOptions;
  provider?: "meshy" | "fal";
  falModel?: string;
  falInput?: Record<string, unknown>;
  qualityReport?: boolean;
}

export interface GenDryRunPlan {
  dryRun: true;
  mode: "text-to-3d" | "image-to-3d" | "multi-image-to-3d" | "via-image";
  provider: "meshy" | "fal";
  output: string;
  texture: boolean;
  polycount?: number;
  sourceImageOutput?: string;
  qualityReport: boolean;
  keys: Record<string, boolean>;
  imageOptions?: Record<string, unknown>;
  falModel?: string;
  falInput?: Record<string, unknown>;
  notes: string[];
  errors: string[];
}

export function buildGenDryRunPlan(opts: GenDryRunOptions): GenDryRunPlan {
  const projectDir = resolve(opts.projectDir);
  const provider = opts.provider ?? "meshy";
  const images = opts.images ?? (opts.image ? [opts.image] : []);
  const isImage = images.length > 0;
  const viaImage = !!opts.viaImage;
  const label = isImage ? imageLabel(images) : opts.prompt;
  const output = buildGenOutputPath(projectDir, label || "model", opts.out);
  const keyVar = provider === "fal" ? "FAL_KEY" : "MESHY_API_KEY";
  const notes: string[] = [];
  const errors: string[] = [];
  const hasProviderKey = !!resolveEnvKey(keyVar, projectDir, opts.key);
  const hasOpenAIKey = viaImage ? !!resolveEnvKey("OPENAI_API_KEY", projectDir, opts.imageKey) : false;

  if (isImage && viaImage) errors.push("choose either --image/--images or --via-image, not both");
  if (isImage) errors.push(...validateImageInputs({ projectDir, images, provider }));
  if (viaImage) {
    if (!opts.prompt) errors.push('usage: stereoframe gen "<prompt>" --via-image');
    if (opts.imageProvider && opts.imageProvider !== "openai") errors.push(`unknown image provider "${opts.imageProvider}" (available: openai)`);
    errors.push(...validateOpenAIImageOptions({ ...(opts.imageOptions ?? {}), model: opts.imageModel, size: opts.imageSize }));
  }

  if (provider === "meshy" && !hasProviderKey && !isImage && !viaImage) {
    notes.push("no MESHY_API_KEY -> would use test mode (sample model, ignores prompt)");
  }
  if (provider === "meshy" && !hasProviderKey && (isImage || viaImage)) {
    errors.push("image-to-3D needs a real MESHY_API_KEY");
  }
  if (provider === "fal" && !hasProviderKey) errors.push("fal generation needs FAL_KEY");
  if (viaImage && !hasOpenAIKey) errors.push("--via-image needs OPENAI_API_KEY");
  if (opts.qualityReport) notes.push("quality report would run after the GLB is generated");

  const mode: GenDryRunPlan["mode"] = isImage ? (images.length > 1 ? "multi-image-to-3d" : "image-to-3d") : viaImage ? "via-image" : "text-to-3d";
  const format = opts.imageOptions?.format;
  const sourceMime = mimeForImageFormat(format);
  return {
    dryRun: true,
    mode,
    provider,
    output,
    texture: opts.texture,
    ...(opts.polycount ? { polycount: opts.polycount } : {}),
    ...(viaImage ? { sourceImageOutput: sourceImagePath(projectDir, opts.out, opts.prompt || "model", sourceMime) } : {}),
    qualityReport: !!opts.qualityReport,
    keys: { [keyVar]: hasProviderKey, ...(viaImage ? { OPENAI_API_KEY: hasOpenAIKey } : {}) },
    ...(viaImage ? { imageOptions: { model: opts.imageModel ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2", size: opts.imageSize ?? "1024x1024", ...(opts.imageOptions ?? {}) } } : {}),
    ...(opts.falModel ? { falModel: opts.falModel } : {}),
    ...(opts.falInput ? { falInput: opts.falInput } : {}),
    notes,
    errors,
  };
}

async function meshy(path: string, key: string, init?: RequestInit): Promise<any> {
  const res = await fetch(MESHY_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Meshy ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollTask(
  taskId: string,
  key: string,
  label: string,
  base = "/openapi/v2/text-to-3d",
): Promise<any> {
  const deadline = Date.now() + 8 * 60_000; // 8 min cap
  let lastProgress = -1;
  while (Date.now() < deadline) {
    const task = await meshy(`${base}/${taskId}`, key);
    const status = task.status as string;
    const progress = Number(task.progress ?? 0);
    if (progress !== lastProgress) {
      process.stderr.write(`\r  ${label}: ${status} ${progress}%   `);
      lastProgress = progress;
    }
    if (status === "SUCCEEDED") {
      process.stderr.write("\n");
      return task;
    }
    if (status === "FAILED" || status === "CANCELED") {
      process.stderr.write("\n");
      throw new Error(`${label} ${status}: ${task.task_error?.message ?? "unknown error"}`);
    }
    await sleep(3000);
  }
  throw new Error(`${label} timed out after 8 minutes`);
}

export async function genModel(opts: GenOptions): Promise<string> {
  const projectDir = resolve(opts.projectDir);
  if (opts.provider === "fal") {
    return genViaFal({
      projectDir,
      model: opts.falModel ?? "",
      prompt: opts.prompt,
      out: opts.out,
      key: opts.key,
      label: opts.prompt,
      input: opts.falInput,
    });
  }
  const { key, isTest } = resolveKey(projectDir, opts.key);
  if (isTest) {
    console.error(
      "⚠ no MESHY_API_KEY found — using Meshy test mode (returns a SAMPLE model, ignores the prompt).\n" +
        "  Set MESHY_API_KEY in your shell or project .env for real generations (https://www.meshy.ai/settings/api).",
    );
  }

  const out = buildGenOutputPath(projectDir, opts.prompt, opts.out);
  mkdirSync(join(out, ".."), { recursive: true });

  console.error(`generating "${opts.prompt}" → ${out}`);

  // 1. Preview (untextured mesh).
  const previewRequest = {
    mode: "preview",
    prompt: opts.prompt,
    ai_model: "latest",
    target_formats: ["glb"],
    should_remesh: true,
    ...(opts.polycount ? { target_polycount: opts.polycount } : {}),
  };
  const preview = await meshy("/openapi/v2/text-to-3d", key, {
    method: "POST",
    body: JSON.stringify(previewRequest),
  });
  const previewId = preview.result;
  const previewTask = await pollTask(previewId, key, "preview");

  // 2. Refine (PBR textures) — optional.
  let finalTask = previewTask;
  let refineId: string | undefined;
  let refineRequest: Record<string, unknown> | undefined;
  if (opts.texture) {
    refineRequest = {
      mode: "refine",
      preview_task_id: previewId,
      enable_pbr: true,
      target_formats: ["glb"],
    };
    const refine = await meshy("/openapi/v2/text-to-3d", key, {
      method: "POST",
      body: JSON.stringify(refineRequest),
    });
    finalTask = await pollTask(refine.result, key, "texture");
    refineId = refine.result;
  }

  return downloadAndWrite(
    finalTask.model_urls?.glb,
    out,
    projectDir,
    {
      prompt: opts.prompt,
      provider: "meshy",
      task: "text-to-3d",
      aiModel: "latest",
      textured: opts.texture !== false,
      ...(opts.polycount ? { targetPolycount: opts.polycount } : {}),
      previewTaskId: previewId,
      ...(refineId ? { refineTaskId: refineId } : {}),
      testMode: isTest,
      request: { preview: previewRequest, ...(refineRequest ? { refine: refineRequest } : {}) },
    },
    isTest,
  );
}

/** Download the finished task's GLB to `out` + write the `.gen.json` provenance
 *  sidecar (the recipe — generation isn't reproducible, so keep how it was made).
 *  Shared by text-to-3D and image-to-3D. */
async function downloadAndWrite(
  glbUrl: string,
  out: string,
  projectDir: string,
  provenance: Record<string, unknown>,
  isTest = false,
): Promise<string> {
  if (!glbUrl) throw new Error("generator returned no GLB url");
  const glb = await fetch(glbUrl);
  if (!glb.ok) throw new Error(`downloading GLB → ${glb.status}`);
  writeFileSync(out, Buffer.from(await glb.arrayBuffer()));

  const provenancePath = out.replace(/\.glb$/i, "") + ".gen.json";
  writeFileSync(
    provenancePath,
    JSON.stringify({ ...provenance, output: basename(out), generatedAt: new Date().toISOString() }, null, 2) + "\n",
  );

  const rel = out.startsWith(projectDir) ? out.slice(projectDir.length + 1) : out;
  const provRel = provenancePath.startsWith(projectDir) ? provenancePath.slice(projectDir.length + 1) : provenancePath;
  console.error(`\n✓ saved ${rel}`);
  console.error(`  recorded → ${provRel}`);
  console.error(`  use it:  <sf-model src="${rel}" scale="1"></sf-model>`);
  if (isTest) console.error("  (sample model — set MESHY_API_KEY to generate from your prompt)");
  return out;
}

/** Read a local image into a base64 data URI (Meshy accepts these as image_url). */
export function imageToDataUri(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`unsupported image type "${ext}" (use png/jpg/webp)`);
  if (!existsSync(path)) throw new Error(`image not found: ${path}`);
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

export interface ImageGenOptions {
  images: string[]; // 1-4 local image paths OR base64 data URIs
  projectDir: string;
  out?: string;
  texture: boolean;
  polycount?: number;
  key?: string;
  /** label for slug/provenance when not derived from a path (e.g. via-image prompt). */
  label?: string;
  /** extra provenance fields (e.g. imageProvider/imagePrompt for --via-image). */
  provenance?: Record<string, unknown>;
  /** "fal" routes the image-to-3D step through fal.ai instead of Meshy. */
  provider?: "meshy" | "fal";
  falModel?: string;
  falInput?: Record<string, unknown>;
}

/** image-to-3D (1 image) or multi-image-to-3D (2-4 views). */
export async function genFromImages(opts: ImageGenOptions): Promise<string> {
  const projectDir = resolve(opts.projectDir);
  if (opts.provider === "fal") {
    return genViaFal({
      projectDir,
      model: opts.falModel ?? "",
      images: opts.images,
      out: opts.out,
      key: opts.key,
      label: opts.label,
      provenance: opts.provenance,
      input: opts.falInput,
    });
  }
  const key = resolveEnvKey("MESHY_API_KEY", projectDir, opts.key);
  if (!key) {
    throw new Error("image-to-3D needs a real MESHY_API_KEY (no test mode) — set it in your shell or project .env, or pass --key.");
  }
  const imgs = opts.images;
  const inputErrors = validateImageInputs({ projectDir, images: imgs, provider: "meshy" });
  if (inputErrors.length) throw new Error(inputErrors.join("; "));
  const sourceImages = imgs.map((p) => sourceImageMetadata(projectDir, p));
  const dataUris = imgs.map((p) => (p.startsWith("data:") ? p : imageToDataUri(resolve(projectDir, p))));
  const multi = dataUris.length > 1;
  const endpoint = multi ? "/openapi/v1/multi-image-to-3d" : "/openapi/v1/image-to-3d";
  const labelSlug = opts.label ?? imgs[0]!.replace(/\.(png|jpe?g|webp)$/i, "");
  const out = buildGenOutputPath(projectDir, basename(labelSlug), opts.out);
  mkdirSync(join(out, ".."), { recursive: true });

  console.error(`${multi ? "multi-image" : "image"}-to-3D from ${imgs.length} image(s) → ${out}`);
  const requestBody = {
    ...(multi ? { image_urls: dataUris } : { image_url: dataUris[0] }),
    ai_model: "latest",
    should_texture: opts.texture !== false,
    enable_pbr: true,
    target_formats: ["glb"],
    ...(opts.polycount ? { target_polycount: opts.polycount } : {}),
  };
  const submit = await meshy(endpoint, key, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  const taskId = submit.result;
  const task = await pollTask(taskId, key, multi ? "multi-image-to-3d" : "image-to-3d", endpoint);

  return downloadAndWrite(task.model_urls?.glb, out, projectDir, {
    provider: "meshy",
    task: multi ? "multi-image-to-3d" : "image-to-3d",
    aiModel: "latest",
    textured: opts.texture !== false,
    ...(opts.polycount ? { targetPolycount: opts.polycount } : {}),
    sourceImages: sourceImages.map(compactSourceImage),
    taskId,
    request: {
      ...requestBody,
      ...(multi ? { image_urls: sourceImages.map(compactSourceImage) } : { image_url: compactSourceImage(sourceImages[0]!) }),
    },
    ...(opts.provenance ?? {}),
  });
}

export interface ViaImageOptions {
  prompt: string;
  projectDir: string;
  out?: string;
  texture: boolean;
  polycount?: number;
  key?: string; // Meshy
  imageKey?: string; // image provider
  imageProvider?: string;
  imageModel?: string;
  imageSize?: string;
  imageOptions?: OpenAIImageOptions;
  /** "fal" routes the image-to-3D step through fal.ai instead of Meshy. */
  provider?: "meshy" | "fal";
  falModel?: string;
  falInput?: Record<string, unknown>;
}

/** Text → reference image (an ImageProvider) → image-to-3D. The generated image is
 *  saved next to the GLB as provenance. */
export async function genViaImage(opts: ViaImageOptions): Promise<string> {
  const projectDir = resolve(opts.projectDir);
  const provider = getImageProvider(opts.imageProvider);
  console.error(`generating reference image via ${provider.name}…`);
  const { data, mime, metadata } = await provider.generate(opts.prompt, {
    projectDir,
    key: opts.imageKey,
    model: opts.imageModel,
    size: opts.imageSize,
    ...(opts.imageOptions ?? {}),
  });
  const imgPath = sourceImagePath(projectDir, opts.out, opts.prompt, mime);
  mkdirSync(join(imgPath, ".."), { recursive: true });
  writeFileSync(imgPath, data);
  const imgRel = imgPath.startsWith(projectDir) ? imgPath.slice(projectDir.length + 1) : imgPath;
  console.error(`  reference image → ${imgRel}`);
  return genFromImages({
    images: [imgPath],
    projectDir,
    out: opts.out,
    texture: opts.texture,
    polycount: opts.polycount,
    key: opts.key,
    label: opts.prompt,
    provider: opts.provider,
    falModel: opts.falModel,
    falInput: opts.falInput,
    provenance: {
      viaImage: true,
      imageProvider: provider.name,
      imagePrompt: opts.prompt,
      sourceImageFile: basename(imgPath),
      ...(metadata ? { imageGeneration: metadata } : {}),
    },
  });
}

// ── fal.ai generation gateway ──────────────────────────────────────────────
// fal is pure pay-as-you-go (no provider minimum) and fronts many 3D generators
// (Hunyuan3D, Tripo, Rodin, Trellis). Premium PBR single-mesh output — the cheap
// route to a good-looking model when Meshy's look isn't enough. (Per-part still
// needs a genuinely multi-part GLB; fal generators output one fused mesh.)
const FAL_QUEUE = "https://queue.fal.run";

export const FAL_MODEL_PRESETS = {
  "tripo3d/tripo/v2.5/text-to-3d": {
    task: "text-to-3d",
    promptField: "prompt",
    outputKeys: ["model_glb_pbr", "model_glb", "model_mesh", "model"],
  },
  "tripo3d/tripo/v2.5/image-to-3d": {
    task: "image-to-3d",
    imageField: "image_url",
    multiImageField: "image_urls",
    outputKeys: ["model_glb_pbr", "model_glb", "model_mesh", "model"],
  },
} as const;

const DEFAULT_FAL_TEXT_MODEL = "tripo3d/tripo/v2.5/text-to-3d";
const DEFAULT_FAL_IMAGE_MODEL = "tripo3d/tripo/v2.5/image-to-3d";

interface FalSubmit {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

/** Upload bytes to fal storage → a public URL (fal models fetch images by URL,
 *  not data URI). initiate (signed PUT url + file url) → PUT bytes → file_url. */
async function falUpload(bytes: Buffer, contentType: string, fileName: string, key: string): Promise<string> {
  const init = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
  });
  if (!init.ok) throw new Error(`fal storage initiate → ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const j = (await init.json()) as any;
  if (!j.upload_url || !j.file_url) throw new Error("fal storage initiate: missing upload_url/file_url");
  const put = await fetch(j.upload_url as string, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes as any,
  });
  if (!put.ok) throw new Error(`fal storage PUT → ${put.status}`);
  return j.file_url as string;
}

async function falSubmit(model: string, key: string, input: Record<string, unknown>): Promise<FalSubmit> {
  const res = await fetch(`${FAL_QUEUE}/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`fal submit ${model} → ${res.status}: ${text.slice(0, 300)}`);
  const j = text ? JSON.parse(text) : {};
  if (!j.request_id) throw new Error(`fal submit: no request_id (${text.slice(0, 200)})`);
  // Use the canonical URLs fal returns (constructing them by hand breaks for
  // multi-slash model ids like "fal-ai/hunyuan-3d/v3.1").
  return {
    requestId: j.request_id as string,
    statusUrl: (j.status_url as string) ?? `${FAL_QUEUE}/${model}/requests/${j.request_id}/status`,
    responseUrl: (j.response_url as string) ?? `${FAL_QUEUE}/${model}/requests/${j.request_id}`,
  };
}

async function falPoll(sub: FalSubmit, key: string, label: string): Promise<any> {
  const auth = { Authorization: `Key ${key}` };
  const deadline = Date.now() + 8 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(sub.statusUrl, { headers: auth });
    const j = (await res.json()) as any;
    const status = j.status as string;
    if (status !== last) {
      process.stderr.write(`\r  ${label}: ${status}    `);
      last = status;
    }
    if (status === "COMPLETED") {
      process.stderr.write("\n");
      const r = await fetch(sub.responseUrl, { headers: auth });
      if (!r.ok) throw new Error(`fal result → ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
    if (status === "FAILED" || status === "ERROR") {
      process.stderr.write("\n");
      throw new Error(`fal ${label} ${status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    await sleep(3000);
  }
  throw new Error(`fal ${label} timed out after 8 minutes`);
}

/** Find the GLB url in a fal result — output field names vary by model
 *  (model_glb_pbr / model_glb / model_mesh / model), so prefer those then deep-scan. */
export function findGlbUrl(obj: any, preferredKeys = ["model_glb_pbr", "model_glb", "model_mesh", "model"]): string | undefined {
  for (const k of preferredKeys) {
    const v = obj?.[k];
    const u = typeof v === "string" ? v : v?.url;
    if (typeof u === "string" && /\.glb(\?|$)/i.test(u)) return u;
  }
  let found: string | undefined;
  const walk = (v: any): void => {
    if (found || v == null) return;
    if (typeof v === "string") {
      if (/^https?:\/\/.*\.glb(\?|$)/i.test(v)) found = v;
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      if (typeof v.url === "string" && /\.glb(\?|$)/i.test(v.url)) found = v.url;
      else for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(obj);
  return found;
}

export interface FalGenOptions {
  projectDir: string;
  model: string; // fal model id, e.g. "fal-ai/hyper3d/rodin" or "fal-ai/tripo3d"
  prompt?: string; // text-to-3D
  images?: string[]; // image paths / data-uris → image-to-3D
  out?: string;
  key?: string;
  label?: string;
  provenance?: Record<string, unknown>;
  /** model-specific input fields passed through verbatim (overrides the defaults). */
  input?: Record<string, unknown>;
}

/** Generate a GLB via a fal.ai 3D model (queue REST: submit → poll → fetch). */
export async function genViaFal(opts: FalGenOptions): Promise<string> {
  const projectDir = resolve(opts.projectDir);
  const key = resolveEnvKey("FAL_KEY", projectDir, opts.key);
  if (!key)
    throw new Error(
      "fal generation needs FAL_KEY — set it in your shell or project .env, or pass --key (https://fal.ai/dashboard/keys).",
    );
  // Default to verified Tripo v2.5 endpoints; override with --fal-model for any
  // fal 3D model (fal.ai/models?categories=3d).
  const model = opts.model || (opts.images?.length ? DEFAULT_FAL_IMAGE_MODEL : DEFAULT_FAL_TEXT_MODEL);
  const preset = FAL_MODEL_PRESETS[model as keyof typeof FAL_MODEL_PRESETS];

  const labelSrc = (opts.label ?? opts.prompt ?? opts.images?.[0] ?? "model").replace(
    /\.(png|jpe?g|webp|glb)$/i,
    "",
  );
  const out = buildGenOutputPath(projectDir, basename(labelSrc), opts.out);
  mkdirSync(join(out, ".."), { recursive: true });

  // Image-to-3D: fal fetches images by URL (it rejects base64 data URIs), so
  // upload local images/data-URIs to fal storage first and pass the URLs. Field
  // name `image_url`/`image_urls` covers Tripo/Trellis/most; override per-model
  // via `input` (CLI --input '<json>'). Otherwise a text prompt.
  const input: Record<string, unknown> = { ...(opts.input ?? {}) };
  let sourceImages: SourceImageMetadata[] | undefined;
  if (opts.images && opts.images.length) {
    const inputErrors = validateImageInputs({ projectDir, images: opts.images, provider: "fal" });
    if (inputErrors.length) throw new Error(inputErrors.join("; "));
    sourceImages = opts.images.map((p) => sourceImageMetadata(projectDir, p));
    const urls: string[] = [];
    for (const p of opts.images) {
      if (/^https?:\/\//i.test(p)) {
        urls.push(p);
        continue;
      }
      let bytes: Buffer;
      let mime: string;
      let fname: string;
      if (p.startsWith("data:")) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(p);
        if (!m) throw new Error("malformed image data URI");
        mime = m[1]!;
        bytes = Buffer.from(m[2]!, "base64");
        fname = `image.${mime.split("/")[1] ?? "png"}`;
      } else {
        const abs = resolve(projectDir, p);
        if (!existsSync(abs)) throw new Error(`image not found: ${abs}`);
        mime = IMAGE_MIME[extname(abs).toLowerCase()] ?? "image/png";
        bytes = readFileSync(abs);
        fname = basename(abs);
      }
      console.error(`  uploading ${fname} to fal storage…`);
      urls.push(await falUpload(bytes, mime, fname, key));
    }
    const multiField = "multiImageField" in (preset ?? {}) ? preset.multiImageField : "image_urls";
    const imageField = "imageField" in (preset ?? {}) ? preset.imageField : "image_url";
    if (urls.length > 1) input[multiField] ??= urls;
    else input[imageField] ??= urls[0];
  } else if (opts.prompt) {
    const promptField = "promptField" in (preset ?? {}) ? preset.promptField : "prompt";
    input[promptField] ??= opts.prompt;
  }

  console.error(`generating via fal (${model}) → ${out}`);
  const sub = await falSubmit(model, key, input);
  const result = await falPoll(sub, key, "fal");
  const outputKeys = preset?.outputKeys ? [...preset.outputKeys] : undefined;
  const glbUrl = findGlbUrl(result, outputKeys);
  if (!glbUrl)
    throw new Error(
      `fal ${model} returned no GLB url (output keys: ${Object.keys(result ?? {}).join(", ")}). ` +
        "Try a different --fal-model, or check that model's output schema.",
    );

  return downloadAndWrite(glbUrl, out, projectDir, {
    provider: "fal",
    falModel: model,
    ...(preset ? { falPreset: preset.task } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(sourceImages ? { sourceImages: sourceImages.map(compactSourceImage) } : {}),
    requestId: sub.requestId,
    request: {
      ...input,
      ...(sourceImages
        ? sourceImages.length > 1
          ? { image_urls: sourceImages.map(compactSourceImage) }
          : { image_url: compactSourceImage(sourceImages[0]!) }
        : {}),
    },
    resultKeys: Object.keys(result ?? {}),
    ...(opts.provenance ?? {}),
  });
}
