/**
 * Text → image, for the image-first asset pipeline (`gen --via-image`): generate a
 * clean reference image from a prompt, then hand it to Meshy image-to-3D. The
 * provider is swappable so fal.ai (or others) can drop in later; OpenAI
 * `gpt-image-2` is the default — strongest at prompt adherence + isolated-subject
 * product shots, which is exactly what lifts cleanly to 3D. Override per-call with
 * --image-model / OPENAI_IMAGE_MODEL.
 */
import { resolveEnvKey } from "./gen";

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
// OpenAI's current image model (GA Apr 2026). Override with --image-model or OPENAI_IMAGE_MODEL.
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

/** Nudge the prompt toward a clean, single-subject, plain-background shot — the
 *  kind of reference image image-to-3D reconstructs best. */
export function isolationPrompt(prompt: string): string {
  return `${prompt.trim()}. Single subject, isolated on a plain seamless light-grey studio background, full subject centered and fully in frame, soft even studio lighting, no props, no text, no shadows on the backdrop.`;
}

export type OpenAIImageQuality = "low" | "medium" | "high" | "auto";
export type OpenAIImageFormat = "png" | "jpeg" | "webp";
export type OpenAIImageBackground = "auto" | "opaque";
export type OpenAIImageModeration = "auto" | "low";

export interface OpenAIImageOptions {
  quality?: OpenAIImageQuality;
  format?: OpenAIImageFormat;
  compression?: number;
  background?: OpenAIImageBackground;
  moderation?: OpenAIImageModeration;
}

export interface ImageProviderOptions extends OpenAIImageOptions {
  projectDir: string;
  key?: string;
  size?: string;
  model?: string;
}

export interface ImageProviderResult {
  data: Buffer;
  mime: string;
  metadata?: Record<string, unknown>;
}

export interface ImageProvider {
  name: string;
  /** Returns the raw image bytes + mime (e.g. image/png). */
  generate(prompt: string, opts: ImageProviderOptions): Promise<ImageProviderResult>;
}

const QUALITIES = new Set(["low", "medium", "high", "auto"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const BACKGROUNDS = new Set(["auto", "opaque"]);
const MODERATIONS = new Set(["auto", "low"]);

export function mimeForImageFormat(format?: OpenAIImageFormat): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export function extensionForImageMime(mime: string): "png" | "jpg" | "webp" {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

export function validateOpenAIImageOptions(opts: OpenAIImageOptions & { size?: string; model?: string }): string[] {
  const errors: string[] = [];
  if (opts.quality && !QUALITIES.has(opts.quality)) errors.push("--image-quality must be low, medium, high, or auto");
  if (opts.format && !FORMATS.has(opts.format)) errors.push("--image-format must be png, jpeg, or webp");
  if (opts.background && !BACKGROUNDS.has(opts.background)) errors.push("--image-background must be auto or opaque");
  if (opts.moderation && !MODERATIONS.has(opts.moderation)) errors.push("--image-moderation must be auto or low");
  if (opts.compression !== undefined) {
    if (!Number.isInteger(opts.compression) || opts.compression < 0 || opts.compression > 100) {
      errors.push("--image-compression must be an integer from 0 to 100");
    }
    if (opts.format !== "jpeg" && opts.format !== "webp") {
      errors.push("--image-compression requires --image-format jpeg or webp");
    }
  }
  if (opts.size && opts.size !== "auto") {
    const m = /^(\d+)x(\d+)$/i.exec(opts.size);
    if (!m) {
      errors.push("--size must be auto or <width>x<height>");
    } else if (!opts.model || opts.model === "gpt-image-2") {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const long = Math.max(w, h);
      const short = Math.min(w, h);
      const pixels = w * h;
      if (long > 3840) errors.push("--size max edge must be <= 3840 for gpt-image-2");
      if (w % 16 !== 0 || h % 16 !== 0) errors.push("--size edges must be multiples of 16 for gpt-image-2");
      if (long / short > 3) errors.push("--size long:short ratio must be <= 3:1 for gpt-image-2");
      if (pixels < 655_360 || pixels > 8_294_400) errors.push("--size pixels must be between 655,360 and 8,294,400 for gpt-image-2");
    }
  }
  return errors;
}

export function buildOpenAIImageRequest(prompt: string, opts: ImageProviderOptions): Record<string, unknown> {
  const model = opts.model ?? process.env.OPENAI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
  const size = opts.size ?? "1024x1024";
  const errors = validateOpenAIImageOptions({ ...opts, model, size });
  if (errors.length) throw new Error(errors.join("; "));
  return {
    model,
    prompt: isolationPrompt(prompt),
    size,
    n: 1,
    ...(opts.quality ? { quality: opts.quality } : {}),
    ...(opts.format ? { output_format: opts.format } : {}),
    ...(opts.compression !== undefined ? { output_compression: opts.compression } : {}),
    ...(opts.background ? { background: opts.background } : {}),
    ...(opts.moderation ? { moderation: opts.moderation } : {}),
  };
}

export const openaiImageProvider: ImageProvider = {
  name: "openai",
  async generate(prompt, opts) {
    const key = resolveEnvKey("OPENAI_API_KEY", opts.projectDir, opts.key);
    if (!key) {
      throw new Error("--via-image needs OPENAI_API_KEY (shell or project .env), or pass --image-key.");
    }
    const request = buildOpenAIImageRequest(prompt, opts);
    const res = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const err = JSON.parse(text).error;
        const moderation = err?.moderation_details ? ` moderation=${JSON.stringify(err.moderation_details).slice(0, 180)}` : "";
        detail = `${err?.code ?? err?.type ?? "error"}: ${err?.message ?? detail}${moderation}`;
      } catch {
        // Keep the raw text fallback.
      }
      throw new Error(`OpenAI image ${res.status}${requestId ? ` request_id=${requestId}` : ""}: ${detail}`);
    }
    const json = JSON.parse(text);
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data");
    return {
      data: Buffer.from(b64, "base64"),
      mime: mimeForImageFormat(opts.format),
      metadata: {
        request,
        response: {
          ...(requestId ? { requestId } : {}),
          ...(json.created ? { created: json.created } : {}),
          ...(json.usage ? { usage: json.usage } : {}),
          ...(json.data?.[0]?.revised_prompt ? { revisedPrompt: json.data[0].revised_prompt } : {}),
        },
      },
    };
  },
};

export function getImageProvider(name = "openai"): ImageProvider {
  if (name === "openai") return openaiImageProvider;
  throw new Error(`unknown image provider "${name}" (available: openai)`);
}
