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

export interface ImageProvider {
  name: string;
  /** Returns the raw image bytes + mime (e.g. image/png). */
  generate(prompt: string, opts: { projectDir: string; key?: string; size?: string; model?: string }): Promise<{ data: Buffer; mime: string }>;
}

export const openaiImageProvider: ImageProvider = {
  name: "openai",
  async generate(prompt, opts) {
    const key = resolveEnvKey("OPENAI_API_KEY", opts.projectDir, opts.key);
    if (!key) {
      throw new Error("--via-image needs OPENAI_API_KEY (shell or project .env), or pass --image-key.");
    }
    const model = opts.model ?? process.env.OPENAI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
    const size = opts.size ?? "1024x1024";
    const res = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: isolationPrompt(prompt), size, n: 1 }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI image ${res.status}: ${text.slice(0, 400)}`);
    const json = JSON.parse(text);
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data");
    return { data: Buffer.from(b64, "base64"), mime: "image/png" };
  },
};

export function getImageProvider(name = "openai"): ImageProvider {
  if (name === "openai") return openaiImageProvider;
  throw new Error(`unknown image provider "${name}" (available: openai)`);
}
