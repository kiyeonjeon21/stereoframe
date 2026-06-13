/**
 * `stereoframe gen "<prompt>"` — generate a 3D model from text via Meshy and
 * download it as a self-contained GLB into the project's assets/.
 *
 * Flow (Meshy async REST): submit a preview task → poll → (optionally) submit
 * a refine task for PBR textures → poll → download `model_urls.glb`.
 *
 * Key resolution: --key flag, then MESHY_API_KEY (env or project .env), then
 * Meshy's public test-mode key — which returns a sample model for free, so
 * the whole pipeline runs end-to-end with zero setup (the result ignores the
 * prompt; set a real key for actual generations).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MESHY_BASE = "https://api.meshy.ai";
const TEST_KEY = "msy_dummy_api_key_for_test_mode_12345678";

export interface GenOptions {
  prompt: string;
  projectDir: string;
  out?: string;
  texture: boolean;
  polycount?: number;
  key?: string;
}

function resolveKey(projectDir: string, explicit?: string): { key: string; isTest: boolean } {
  if (explicit) return { key: explicit, isTest: false };
  if (process.env.MESHY_API_KEY) return { key: process.env.MESHY_API_KEY, isTest: false };
  const envPath = join(resolve(projectDir), ".env");
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("MESHY_API_KEY="));
    const v = line?.slice("MESHY_API_KEY=".length).trim();
    if (v) return { key: v, isTest: false };
  }
  return { key: TEST_KEY, isTest: true };
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

async function pollTask(taskId: string, key: string, label: string): Promise<any> {
  const deadline = Date.now() + 8 * 60_000; // 8 min cap
  let lastProgress = -1;
  while (Date.now() < deadline) {
    const task = await meshy(`/openapi/v2/text-to-3d/${taskId}`, key);
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
  }

  // 3. Download the GLB.
  const glbUrl = finalTask.model_urls?.glb;
  if (!glbUrl) throw new Error("Meshy returned no GLB url");
  const glb = await fetch(glbUrl);
  if (!glb.ok) throw new Error(`downloading GLB → ${glb.status}`);
  writeFileSync(out, Buffer.from(await glb.arrayBuffer()));

  const rel = out.startsWith(projectDir) ? out.slice(projectDir.length + 1) : out;
  console.log(`\n✓ saved ${rel}`);
  console.log(`  use it:  <sf-model src="${rel}" scale="1"></sf-model>`);
  if (isTest) console.log("  (sample model — set MESHY_API_KEY to generate from your prompt)");
  return out;
}
