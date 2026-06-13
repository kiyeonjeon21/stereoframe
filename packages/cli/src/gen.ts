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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getImageProvider } from "./imagegen";

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

function slug(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "model"
  );
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
      process.stdout.write(`\r  ${label}: ${status} ${progress}%   `);
      lastProgress = progress;
    }
    if (status === "SUCCEEDED") {
      process.stdout.write("\n");
      return task;
    }
    if (status === "FAILED" || status === "CANCELED") {
      process.stdout.write("\n");
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
    console.log(
      "⚠ no MESHY_API_KEY found — using Meshy test mode (returns a SAMPLE model, ignores the prompt).\n" +
        "  Set MESHY_API_KEY in your shell or project .env for real generations (https://www.meshy.ai/settings/api).",
    );
  }

  const out = resolve(projectDir, opts.out ?? join("assets", `${slug(opts.prompt)}.glb`));
  mkdirSync(join(out, ".."), { recursive: true });

  console.log(`generating "${opts.prompt}" → ${out}`);

  // 1. Preview (untextured mesh).
  const preview = await meshy("/openapi/v2/text-to-3d", key, {
    method: "POST",
    body: JSON.stringify({
      mode: "preview",
      prompt: opts.prompt,
      ai_model: "latest",
      target_formats: ["glb"],
      should_remesh: true,
      ...(opts.polycount ? { target_polycount: opts.polycount } : {}),
    }),
  });
  const previewId = preview.result;
  const previewTask = await pollTask(previewId, key, "preview");

  // 2. Refine (PBR textures) — optional.
  let finalTask = previewTask;
  let refineId: string | undefined;
  if (opts.texture) {
    const refine = await meshy("/openapi/v2/text-to-3d", key, {
      method: "POST",
      body: JSON.stringify({
        mode: "refine",
        preview_task_id: previewId,
        enable_pbr: true,
        target_formats: ["glb"],
      }),
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
  console.log(`\n✓ saved ${rel}`);
  console.log(`  recorded → ${provRel}`);
  console.log(`  use it:  <sf-model src="${rel}" scale="1"></sf-model>`);
  if (isTest) console.log("  (sample model — set MESHY_API_KEY to generate from your prompt)");
  return out;
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

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
  const imgs = opts.images.slice(0, 4);
  if (imgs.length === 0) throw new Error("genFromImages: no images");
  const dataUris = imgs.map((p) => (p.startsWith("data:") ? p : imageToDataUri(resolve(projectDir, p))));
  const multi = dataUris.length > 1;
  const endpoint = multi ? "/openapi/v1/multi-image-to-3d" : "/openapi/v1/image-to-3d";
  const labelSlug = opts.label ?? imgs[0]!.replace(/\.(png|jpe?g|webp)$/i, "");
  const out = resolve(projectDir, opts.out ?? join("assets", `${slug(basename(labelSlug))}.glb`));
  mkdirSync(join(out, ".."), { recursive: true });

  console.log(`${multi ? "multi-image" : "image"}-to-3D from ${imgs.length} image(s) → ${out}`);
  const submit = await meshy(endpoint, key, {
    method: "POST",
    body: JSON.stringify({
      ...(multi ? { image_urls: dataUris } : { image_url: dataUris[0] }),
      ai_model: "latest",
      should_texture: opts.texture !== false,
      enable_pbr: true,
      target_formats: ["glb"],
      ...(opts.polycount ? { target_polycount: opts.polycount } : {}),
    }),
  });
  const taskId = submit.result;
  const task = await pollTask(taskId, key, multi ? "multi-image-to-3d" : "image-to-3d", endpoint);

  return downloadAndWrite(task.model_urls?.glb, out, projectDir, {
    provider: "meshy",
    task: multi ? "multi-image-to-3d" : "image-to-3d",
    aiModel: "latest",
    textured: opts.texture !== false,
    ...(opts.polycount ? { targetPolycount: opts.polycount } : {}),
    sourceImages: imgs.map((p) => (p.startsWith("data:") ? "<inline>" : basename(p))),
    taskId,
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
  console.log(`generating reference image via ${provider.name}…`);
  const { data, mime } = await provider.generate(opts.prompt, {
    projectDir,
    key: opts.imageKey,
    model: opts.imageModel,
    size: opts.imageSize,
  });
  const ext = mime === "image/png" ? "png" : "jpg";
  const imgPath = resolve(
    projectDir,
    opts.out ? opts.out.replace(/\.glb$/i, `.source.${ext}`) : join("assets", `${slug(opts.prompt)}.source.${ext}`),
  );
  mkdirSync(join(imgPath, ".."), { recursive: true });
  writeFileSync(imgPath, data);
  const imgRel = imgPath.startsWith(projectDir) ? imgPath.slice(projectDir.length + 1) : imgPath;
  console.log(`  reference image → ${imgRel}`);
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
    provenance: { viaImage: true, imageProvider: provider.name, imagePrompt: opts.prompt, sourceImageFile: basename(imgPath) },
  });
}

// ── fal.ai generation gateway ──────────────────────────────────────────────
// fal is pure pay-as-you-go (no provider minimum) and fronts many 3D generators
// (Hunyuan3D, Tripo, Rodin, Trellis). Premium PBR single-mesh output — the cheap
// route to a good-looking model when Meshy's look isn't enough. (Per-part still
// needs a genuinely multi-part GLB; fal generators output one fused mesh.)
const FAL_QUEUE = "https://queue.fal.run";

interface FalSubmit {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
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
      process.stdout.write(`\r  ${label}: ${status}    `);
      last = status;
    }
    if (status === "COMPLETED") {
      process.stdout.write("\n");
      const r = await fetch(sub.responseUrl, { headers: auth });
      if (!r.ok) throw new Error(`fal result → ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
    if (status === "FAILED" || status === "ERROR") {
      process.stdout.write("\n");
      throw new Error(`fal ${label} ${status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    await sleep(3000);
  }
  throw new Error(`fal ${label} timed out after 8 minutes`);
}

/** Find the GLB url in a fal result — output field names vary by model
 *  (model_glb_pbr / model_glb / model_mesh / model), so prefer those then deep-scan. */
function findGlbUrl(obj: any): string | undefined {
  for (const k of ["model_glb_pbr", "model_glb", "model_mesh", "model"]) {
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
  const model =
    opts.model ||
    (opts.images?.length ? "tripo3d/tripo/v2.5/image-to-3d" : "tripo3d/tripo/v2.5/text-to-3d");

  const labelSrc = (opts.label ?? opts.prompt ?? opts.images?.[0] ?? "model").replace(
    /\.(png|jpe?g|webp|glb)$/i,
    "",
  );
  const out = resolve(projectDir, opts.out ?? join("assets", `${slug(basename(labelSrc))}.glb`));
  mkdirSync(join(out, ".."), { recursive: true });

  // Image-to-3D uses input_image_url(s); otherwise a text prompt. Both are common
  // fal conventions; override per-model via `input` (CLI --input '<json>').
  const input: Record<string, unknown> = { ...(opts.input ?? {}) };
  if (opts.images && opts.images.length) {
    const uris = opts.images.map((p) => (p.startsWith("data:") ? p : imageToDataUri(resolve(projectDir, p))));
    if (uris.length > 1) input.input_image_urls ??= uris;
    else input.input_image_url ??= uris[0];
  } else if (opts.prompt && input.prompt === undefined) {
    input.prompt = opts.prompt;
  }

  console.log(`generating via fal (${model}) → ${out}`);
  const sub = await falSubmit(model, key, input);
  const result = await falPoll(sub, key, "fal");
  const glbUrl = findGlbUrl(result);
  if (!glbUrl)
    throw new Error(
      `fal ${model} returned no GLB url (output keys: ${Object.keys(result ?? {}).join(", ")}). ` +
        "Try a different --fal-model, or check that model's output schema.",
    );

  return downloadAndWrite(glbUrl, out, projectDir, {
    provider: "fal",
    falModel: model,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.images
      ? { sourceImages: opts.images.map((p) => (p.startsWith("data:") ? "<inline>" : basename(p))) }
      : {}),
    requestId: sub.requestId,
    ...(opts.provenance ?? {}),
  });
}
