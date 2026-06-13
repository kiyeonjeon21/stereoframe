/**
 * `stereoframe brief "<brief>" | <brief.md> --model <glb>` — the directing layer's
 * natural-language front door, the symmetric twin of `gen`:
 *
 *   gen   "candy-red hypercar…"      → Meshy   → model.glb (+ .gen.json)
 *   brief "dark neon reveal, 24s…"   → an LLM  → plan.json (+ brief.md)
 *
 * A person describes the film in plain language; an LLM (OpenAI, key from `.env`)
 * turns it into a rich storyboard plan, which `storyboard` then compiles + renders.
 * The plan is model-aware (we `inspect` the GLB and feed its facts to the LLM, so
 * it can pose a flat model, pick a metal rig, etc.) and validated + repaired before
 * it's written. The brief is saved alongside as provenance, like `.gen.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { inspectModel, type ModelManifest } from "./inspect";
import {
  buildStoryboard,
  STORYBOARD_SCHEMA_DOC,
  validateStoryboard,
  type Storyboard,
} from "./storyboard";
import { renderProject } from "./render";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";

export interface BriefOptions {
  brief: string; // inline text or a path to a .md/.txt file
  model: string; // GLB path (the subject to direct)
  outDir: string;
  render?: boolean;
  draft?: boolean;
  llmModel?: string;
  key?: string;
}

/** OpenAI key from --key, env, or the project `.env` (mirrors gen.ts resolveKey). */
export function resolveOpenAIKey(projectDir: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envPath = join(resolve(projectDir), ".env");
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("OPENAI_API_KEY="));
    const v = line?.slice("OPENAI_API_KEY=".length).trim();
    if (v) return v;
  }
  throw new Error(
    "no OpenAI key — set OPENAI_API_KEY in your shell or project .env (https://platform.openai.com/api-keys), or pass --key.",
  );
}

/** Pull the first JSON object out of an LLM response (handles ```json fences / prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("LLM returned no JSON object");
  }
  return JSON.parse(body.slice(start, end + 1));
}

/** One-line facts about the model so the LLM can pose/light it correctly. */
export function manifestFacts(m: ModelManifest): string {
  const sz = m.bounds?.size;
  const sizeStr = sz ? `${sz.map((n) => n.toFixed(2)).join(" x ")}` : "unknown";
  // Only flag a *genuinely* thin slab (phone/tablet/card), not a naturally low,
  // wide object like a car — and even then, posing is the LLM's judgement call.
  const flat =
    sz && Math.min(...sz) / Math.max(...sz) < 0.12
      ? ` (VERY thin/flat — like a phone, tablet, or card lying down. Add a "pose" to stand it up ONLY if it is such a device meant to be upright; do NOT pose vehicles, characters, furniture, or anything naturally low/wide)`
      : "";
  const parts = m.parts
    .filter((p) => p.kind === "mesh")
    .slice(0, 8)
    .map((p) => p.name)
    .join(", ");
  return [
    `MODEL FACTS for "${basename(m.model)}":`,
    `- bounding box (x y z): ${sizeStr}${flat}`,
    `- dominant material: ${m.dominant?.character ?? "unknown"}${m.dominant?.metalness != null ? ` (metalness ${m.dominant.metalness.toFixed(2)})` : ""}${m.dominant?.character === "metal" ? ' → consider lighting:"auto" or a cool-rim/warm-fill split, and a tamed exposure' : ""}`,
    `- ${m.isSingleMesh ? "SINGLE-MESH (no separable parts → do NOT use callout/isolate/explode)" : `multi-part: ${parts}`}`,
    `- recommended fit: ${m.recommendedFit ?? 2.6}`,
  ].join("\n");
}

export function buildMessages(brief: string, manifest: ModelManifest): Array<{ role: string; content: string }> {
  const system = `You are a world-class product-film director and director of photography for "stereoframe", a deterministic 3D-video framework. You translate a creative brief into a STORYBOARD PLAN (strict JSON) that compiles into a cinematic film from a single 3D model.

${STORYBOARD_SCHEMA_DOC}

OUTPUT RULES:
- Return ONLY one JSON object matching the schema above. No prose, no markdown.
- Make it genuinely cinematic and DYNAMIC (this is the whole point): 6-9 shots, 18-28s total,
  varied beat lengths, a clear arc, varied camera types, backdrop + secondaryMotion on most
  shots, atmosphere only where allowed, complementary split lighting, per-beat grade + light-sweep.
- Obey the determinism constraint: never put "atmosphere" on a shot that crossfades out.
- Respect the model facts (pose a flat model; metal → auto/rim-fill rig).
- The "model" field will be overwritten by the tool; you may omit it.`;

  const user = `${manifestFacts(manifest)}

CREATIVE BRIEF:
${brief}

Return the storyboard plan JSON now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function repairMessage(errors: string[]): string {
  return `That plan failed validation with these errors:\n- ${errors.join("\n- ")}\nReturn a corrected full JSON plan that fixes every error. JSON only.`;
}

async function openaiChat(
  messages: Array<{ role: string; content: string }>,
  key: string,
  model: string,
): Promise<string> {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      response_format: { type: "json_object" },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  return content;
}

/** Normalize the LLM object into a Storyboard (unwrap {plan:…}, coerce model). */
function asPlan(obj: unknown): Storyboard {
  const o = obj as Record<string, unknown>;
  const plan = (o && typeof o === "object" && "shots" in o ? o : (o?.plan ?? o)) as Storyboard;
  return plan;
}

export async function runBrief(opts: BriefOptions): Promise<{ dir: string; plan: Storyboard; duration?: number }> {
  const projectDir = process.cwd();
  const key = resolveOpenAIKey(projectDir, opts.key);
  const llmModel = opts.llmModel ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  const glb = resolve(opts.model);
  if (!existsSync(glb)) throw new Error(`brief: model not found: ${opts.model}`);
  const briefText = existsSync(resolve(opts.brief)) ? readFileSync(resolve(opts.brief), "utf8") : opts.brief;

  console.log(`inspecting ${basename(glb)}…`);
  const manifest = await inspectModel({ model: glb, silent: true, write: false });

  console.log(`directing via ${llmModel} (one creative call)…`);
  const messages = buildMessages(briefText, manifest);
  let raw = await openaiChat(messages, key, llmModel);
  let plan = asPlan(extractJson(raw));

  // Force the model reference + dimensions the tool controls.
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  plan.model = relative(outDir, glb) || basename(glb);
  plan.width ??= 1920;
  plan.height ??= 1080;

  let errors = validateStoryboard(plan);
  if (errors.length) {
    console.log(`  plan had ${errors.length} issue(s) — asking for one repair…`);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: repairMessage(errors) });
    raw = await openaiChat(messages, key, llmModel);
    plan = asPlan(extractJson(raw));
    plan.model = relative(outDir, glb) || basename(glb);
    plan.width ??= 1920;
    plan.height ??= 1080;
    errors = validateStoryboard(plan);
  }
  if (errors.length) {
    throw new Error(`brief: the generated plan is still invalid:\n  - ${errors.join("\n  - ")}`);
  }

  // Write plan.json + the brief (provenance, like .gen.json).
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(outDir, "brief.md"), briefText.trim() + "\n");
  const beats = plan.shots.length;
  console.log(`✓ wrote plan.json (${beats} shot${beats === 1 ? "" : "s"}) + brief.md → ${outDir}`);

  if (opts.render) {
    const built = await buildStoryboard({ plan, planDir: outDir, outDir });
    const out = await renderProject({ projectDir: built.dir, draft: opts.draft === true });
    console.log(out);
    return { dir: outDir, plan, duration: built.duration };
  }
  console.log(`next: stereoframe storyboard ${join(opts.outDir, "plan.json")} --render`);
  return { dir: outDir, plan };
}
