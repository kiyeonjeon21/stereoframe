/**
 * stereoframe CLI — the agent-facing entry point.
 *
 *   stereoframe init <name>          scaffold a composition project
 *   stereoframe render [dir] [...]   deterministic frame-by-frame mp4 render
 *   stereoframe preview [dir]        serve the project with looping playback
 *   stereoframe update [dir]         refresh assets/stereoframe.js
 *
 * Non-interactive by default: plain-text output, no prompts, meaningful exit
 * codes — designed so coding agents can scaffold → edit → render in a loop.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import {
  ELEMENT_NAMES,
  VERB_NAMES,
  VERB_PARAMS,
  COMMON_VERB_ATTRS,
  EASE_NAMES,
  ASSET_ATTRS,
  GEOMETRY_KINDS,
  MATERIAL_KINDS,
  FINISH_ATTRS,
  STAGE_PRESETS,
  GEN_PROVIDERS,
} from "stereoframe-runtime/vocab";
import { addBlock, listBlocks } from "./blocks";
import { genModel, genFromImages, genViaImage, slug as genSlug, resolveEnvKey } from "./gen";
import { inspectModel } from "./inspect";
import { bakeProject } from "./bake";
import { buildStoryboard, readStoryboard, validateStoryboard } from "./storyboard";
import { runBrief } from "./brief";
import { segmentModel } from "./segment";
import { buildAutoCallouts, explodeTiming, PRESETS, stageModel, type Preset } from "./stage";
import { lintHtml, type Finding } from "./lint";
import { renderProject } from "./render";
import { scaffoldProject, updateRuntime } from "./scaffold";
import { serveProject } from "./serve";
import { validateProject } from "./validate";

interface Flags {
  positional: string[];
  options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(key, next);
        i++;
      } else {
        options.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

// Agents (and pipes) get machine-readable JSON; humans on a TTY get prose.
// `--json` forces it; a non-TTY stdout auto-enables it (per agentic-CLI guidance).
const WANT_JSON = process.argv.includes("--json") || !process.stdout.isTTY;

/** A CLI error carrying a machine-readable code + actionable hint. */
class CliError extends Error {
  constructor(message: string, readonly code = "runtime_error", readonly hint?: string) {
    super(message);
  }
}

/** Reject paths that escape the working directory (agents hallucinate `../..`). */
function assertWithinCwd(p: string | undefined, flag: string): void {
  if (!p) return;
  const rel = relative(process.cwd(), resolve(p));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CliError(
      `${flag} "${p}" escapes the working directory`,
      "path_escape",
      "Use a path inside the current project (no leading '..' or absolute paths).",
    );
  }
}

/** A command's result: JSON `{ok,command,...}` to stdout for agents, prose for humans. */
function reportResult(command: string, payload: Record<string, unknown>, lines: string[]): void {
  if (WANT_JSON) {
    console.log(JSON.stringify({ ok: true, command, ...payload }));
  } else {
    for (const l of lines) console.log(l);
  }
}

const HELP = `stereoframe — declarative, deterministic 3D video on three.js

USAGE
  stereoframe init <name>              scaffold a new composition project
  stereoframe lint [dir]               static checks (markup, assets, time purity)
  stereoframe validate [dir]           headless run: errors, lighting, framing, idempotency
      --json           machine-readable findings (both lint and validate)
  stereoframe render [dir]             render index.html to mp4
      --fps <n>        frames per second (default 30)
      --out <path>     output file (default renders/render_<timestamp>.mp4)
      --crf <n>        x264 quality, lower = better (default 18)
      --draft          fast low-quality render for iteration
  stereoframe bake [dir]               freeze a forward-mode sim into a seekable cache for <sf-baked>
      --target <id>    the InstancedMesh element id to bake (required)
      --fps <n>        bake frame rate (default 30)
  stereoframe preview [dir]            serve with looping wall-clock playback
      --port <n>       fixed port (default: random)
  stereoframe stage <model.glb>        auto-direct a GLB into a cinematic motion graphic
      --preset <name>  reveal | hero-orbit | turntable | exploded-view | spec | teardown (default reveal)
                       spec     = auto-annotated product film (inspects the GLB, places named callouts)
                       teardown = exploded view with a labelled callout tracking each separated part
      --dir <dir>      output project dir (default: <model name>)
      --duration <s>   seconds (default 8)
      --title "<text>" optional title overlay
      --bg <color>     background color (preset default otherwise)
  stereoframe brief "<brief>" | <brief.md>   natural-language directing → a cinematic plan.json (via an LLM)
      --model <glb>    direct an existing model, OR generate one first (one-shot):
      --gen "<prompt>"   generate the model from text (add --via-image / --images / --image-model)
      --dir <dir>      output project dir (default: <brief> slug or film)
      --render         compile + render the result to mp4 (--draft for fast)
      --llm-provider   openai (default) | anthropic        --llm-model <id>   --llm-key <key>
      --vertical       frame for 1080x1920 (social) · --square for 1080x1080
  stereoframe storyboard <plan.json>   compile a shot plan (JSON) into a multi-shot directed film
      --dir <dir>      output project dir (default: <title> slug or <stem>-film)
      --render         render the compiled film to mp4 (--draft for fast)
      --vertical       force 1080x1920 (social) · --square forces 1080x1080
  stereoframe inspect <model.glb>      segment + tag a GLB: list its parts (name, material, where, size)
      --json           print the manifest as JSON instead of a table
  stereoframe segment <model.glb>      report a mesh's separable connected components
      --min-faces <n>  ignore components smaller than n triangles (default 50)
                       (AI text/image-to-3D output is one welded mesh → not separable)
  stereoframe gen "<prompt>"           generate a 3D model (GLB) via Meshy
      --image <png>    image-to-3D from one local image (instead of text)
      --images a,b,c   multi-image-to-3D from 1-4 views (front/side/back…)
      --via-image      text → image (OpenAI gpt-image-2) → image-to-3D, more art-directable
      --image-provider openai (default)  --image-model <id>  --size <wxh>  --image-key <key>
      --provider fal   generate via fal.ai (premium, pay-as-you-go) instead of Meshy
      --fal-model <id>   fal model, e.g. tripo3d/tripo/v2.5/text-to-3d  (browse fal.ai/models?categories=3d)
      --input '<json>'   model-specific fal input fields (merged into the request)
      --dir <dir>      project dir (default .)
      --out <path>     output path (default assets/<slug>.glb)
      --no-texture     skip the PBR texture pass (faster, untextured mesh)
      --polycount <n>  target polygon count
      --key <key>      Meshy API key (else MESHY_API_KEY / .env / test mode)
      --dry-run        resolve the plan (mode, provider, output path, key presence) without spending
      --stage <preset> one-shot: generate then stage into a film (reveal|hero-orbit|turntable|exploded-view|spec|teardown)
      --render         with --stage, also render the result to mp4 (--draft for fast)
  stereoframe add <block> [dir]        install a visual block's assets + print usage
  stereoframe blocks                   list available blocks
  stereoframe update [dir]             refresh assets/stereoframe.js from the CLI's bundled runtime
  stereoframe schema [--command <c>]   machine-readable spec: commands + authoring vocabulary (JSON)

Output: prose on a TTY; JSON when piped/non-TTY or with --json. Run \`stereoframe schema\` for the full vocabulary.
Exit codes: 0 ok · 1 tool error · 2 lint/validate findings.
`;

/** Declarative command table — the source for unknown-command help + \`schema\`. */
const COMMANDS = [
  { name: "init", summary: "scaffold a new composition project", args: ["name"] },
  { name: "lint", summary: "static checks (markup, assets, time purity)", flags: ["json"] },
  { name: "validate", summary: "headless run: errors, lighting, framing, seek-idempotency", flags: ["json"] },
  { name: "render", summary: "render index.html to mp4", flags: ["fps", "out", "crf", "draft", "json"] },
  { name: "bake", summary: "freeze a forward-mode sim into a seekable cache", flags: ["target", "fps", "out"] },
  { name: "preview", summary: "serve with looping wall-clock playback", flags: ["port"] },
  { name: "stage", summary: "auto-direct a GLB into a cinematic motion graphic", args: ["model.glb"], flags: ["preset", "dir", "duration", "title", "bg", "json"] },
  { name: "brief", summary: "natural-language directing → a plan.json (via an LLM)", flags: ["model", "gen", "dir", "render", "llm-provider", "vertical", "square"] },
  { name: "storyboard", summary: "compile a shot plan (JSON) into a multi-shot film", args: ["plan.json"], flags: ["dir", "render", "vertical", "square", "json"] },
  { name: "inspect", summary: "segment + tag a GLB: list its parts", args: ["model.glb"], flags: ["json"] },
  { name: "segment", summary: "report a mesh's separable connected components", args: ["model.glb"], flags: ["min-faces", "json"] },
  { name: "gen", summary: "generate a 3D model (GLB) via Meshy or fal.ai", args: ["prompt"], flags: ["image", "images", "via-image", "provider", "fal-model", "dir", "out", "no-texture", "dry-run", "stage", "render", "json"] },
  { name: "add", summary: "install a visual block's assets + print usage", args: ["block"] },
  { name: "blocks", summary: "list available blocks" },
  { name: "update", summary: "refresh assets/stereoframe.js", flags: ["json"] },
  { name: "schema", summary: "machine-readable spec: commands + authoring vocabulary", flags: ["command"] },
] as const;

const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/** Closest command name (prefix or single-edit) for an unknown-command hint. */
function suggestCommand(input: string): string | undefined {
  return (
    COMMAND_NAMES.find((c) => c.startsWith(input) || input.startsWith(c)) ??
    COMMAND_NAMES.find((c) => Math.abs(c.length - input.length) <= 2 && [...c].filter((ch, i) => ch !== input[i]).length <= 2)
  );
}

/** Stage a model with a preset, auto-placing callouts for spec/teardown.
 *  Shared by the `stage` command and `gen --stage`. */
async function runStage(opts: {
  model: string;
  outDir: string;
  preset: Preset;
  duration?: number;
  background?: string;
  title?: string;
}): Promise<string> {
  const { model, outDir, preset } = opts;
  const dur = opts.duration && opts.duration > 0 ? opts.duration : 8;

  // Inspect once — used both for spec/teardown callouts and to auto-adapt the
  // lighting (a dominantly-metal model gets a tamed exposure + rim/fill rig).
  console.error(`inspecting ${model}…`);
  const manifest = await inspectModel({ model, silent: true, write: false });
  const metalRig =
    manifest.dominant.character === "metal" && (manifest.dominant.metalness ?? 0) > 0.6;
  if (metalRig) console.error("  dominant material is metal → tamed exposure + rim/fill rig");

  let callouts;
  if (preset === "spec" || preset === "teardown") {
    callouts = buildAutoCallouts(
      manifest,
      dur,
      preset === "teardown"
        ? { max: 5, startAt: explodeTiming(dur).end + 0.2, leadFan: 46 }
        : { max: 3 },
    );
    if (callouts.length === 0) {
      console.error(`note: ${model} has <2 separable mesh parts — ${preset} film will render without callouts.`);
    } else {
      console.error(`  callouts: ${callouts.map((c) => c.value).join(", ")}`);
    }
  }
  const created = stageModel({
    model,
    projectDir: outDir,
    preset,
    duration: opts.duration,
    background: opts.background,
    title: opts.title,
    callouts,
    metalRig,
  });
  console.error(`staged ${model} (${preset}) → ${created}`);
  return created;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  const dir = positional[0] ?? ".";

  switch (command) {
    case "init": {
      const name = positional[0];
      if (!name) throw new Error("usage: stereoframe init <name>");
      assertWithinCwd(name, "init <name>");
      const created = scaffoldProject(name);
      reportResult("init", { outputs: [created], next: `cd ${name} && stereoframe render` }, [
        `created ${created}`,
        `next: cd ${name} && stereoframe render`,
      ]);
      return;
    }
    case "lint": {
      const htmlPath = join(resolve(dir), "index.html");
      if (!existsSync(htmlPath)) throw new Error(`no index.html in ${resolve(dir)}`);
      const findings = lintHtml(readFileSync(htmlPath, "utf8"), {
        fileExists: (rel) => existsSync(join(resolve(dir), rel)),
      });
      reportFindings("lint", findings, WANT_JSON);
      return;
    }
    case "validate": {
      const findings = await validateProject(dir);
      reportFindings("validate", findings, WANT_JSON);
      return;
    }
    case "bake": {
      const target = options.get("target");
      if (typeof target !== "string") {
        throw new Error("usage: stereoframe bake [dir] --target <element-id> [--fps n] [--out file.bin]");
      }
      const bakeOut = typeof options.get("out") === "string" ? (options.get("out") as string) : undefined;
      assertWithinCwd(bakeOut, "--out");
      const out = await bakeProject({
        projectDir: dir,
        target,
        fps: options.has("fps") ? Number(options.get("fps")) : undefined,
        out: bakeOut,
      });
      reportResult("bake", { outputs: [out] }, [`baked → ${out}`]);
      return;
    }
    case "render": {
      const renderOut = typeof options.get("out") === "string" ? (options.get("out") as string) : undefined;
      assertWithinCwd(renderOut, "--out");
      const out = await renderProject({
        projectDir: dir,
        fps: options.has("fps") ? Number(options.get("fps")) : undefined,
        crf: options.has("crf") ? Number(options.get("crf")) : undefined,
        out: renderOut,
        draft: options.get("draft") === true,
      });
      reportResult("render", { outputs: [out] }, [out]);
      return;
    }
    case "preview": {
      const port = options.has("port") ? Number(options.get("port")) : 0;
      const handle = await serveProject(dir, port);
      console.log(`preview: ${handle.url}?sf-preview`);
      console.error("press ctrl-c to stop");
      return; // server keeps the process alive
    }
    case "inspect": {
      const model = positional[0];
      if (!model) throw new Error("usage: stereoframe inspect <model.glb> [--json]");
      await inspectModel({ model, json: WANT_JSON });
      return;
    }
    case "stage": {
      const model = positional[0];
      if (!model) throw new Error('usage: stereoframe stage <model.glb> [--preset reveal|hero-orbit|turntable]');
      const preset = (typeof options.get("preset") === "string" ? options.get("preset") : "reveal") as Preset;
      if (!PRESETS.includes(preset)) {
        throw new CliError(`unknown preset: ${preset}`, "unknown_preset", `presets: ${PRESETS.join(", ")}`);
      }
      const stem = basename(model).replace(/\.(glb|gltf)$/i, "");
      const outDir =
        typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${stem}-${preset}`;
      assertWithinCwd(outDir, "--dir");
      const staged = await runStage({
        model,
        outDir,
        preset,
        duration: options.has("duration") ? Number(options.get("duration")) : undefined,
        background: typeof options.get("bg") === "string" ? (options.get("bg") as string) : undefined,
        title: typeof options.get("title") === "string" ? (options.get("title") as string) : undefined,
      });
      reportResult("stage", { outputs: [staged], preset, next: `cd ${outDir} && stereoframe render` }, [
        `next: cd ${outDir} && stereoframe render`,
      ]);
      return;
    }
    case "storyboard": {
      const planPath = positional[0];
      if (!planPath) {
        throw new Error("usage: stereoframe storyboard <plan.json> [--dir out] [--render]");
      }
      const { plan, planDir } = readStoryboard(planPath);
      if (options.get("vertical") === true) {
        plan.width = 1080;
        plan.height = 1920;
      } else if (options.get("square") === true) {
        plan.width = 1080;
        plan.height = 1080;
      }
      const errs = validateStoryboard(plan);
      if (errs.length) throw new Error(`storyboard plan has errors:\n  - ${errs.join("\n  - ")}`);
      const slug =
        (plan.title ?? basename(planPath).replace(/\.json$/i, ""))
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40) || "film";
      const outDir = typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${slug}-film`;
      assertWithinCwd(outDir, "--dir");
      const { dir: built, duration } = await buildStoryboard({ plan, planDir, outDir });
      console.error(`compiled ${plan.shots.length} shot(s), ${duration.toFixed(1)}s → ${built}`);
      if (options.get("render") === true) {
        const out = await renderProject({ projectDir: built, draft: options.get("draft") === true });
        reportResult("storyboard", { outputs: [out], shots: plan.shots.length, durationSec: duration }, [out]);
      } else {
        reportResult(
          "storyboard",
          { outputs: [built], shots: plan.shots.length, durationSec: duration, next: `cd ${outDir} && stereoframe render` },
          [`next: cd ${outDir} && stereoframe render`],
        );
      }
      return;
    }
    case "segment": {
      const m = positional[0];
      if (!m) throw new Error("usage: stereoframe segment <model.glb> [--min-faces N] [--dry-run]");
      const minFaces = options.has("min-faces") ? Number(options.get("min-faces")) : undefined;
      const report = await segmentModel({ model: m, minFaces, dryRun: true });
      const lines = [
        `mesh: ${report.meshTris} tris, ${report.weldedVerts} welded verts`,
        `connected components (>= min-faces): ${report.components.length}  (dropped ${report.dropped} specks)`,
        ...report.components.slice(0, 20).map((c, i) => {
          const sz = c.size.map((n) => n.toFixed(2)).join("×");
          const ctr = c.center.map((n) => n.toFixed(2)).join(" ");
          return `  #${i}  ${String(c.tris).padStart(7)} tris   size ${sz}   center ${ctr}`;
        }),
        ...(report.components.length <= 1
          ? ["\n→ single welded component: this mesh can't be auto-split (use a multi-part source GLB for per-part features)."]
          : []),
      ];
      reportResult("segment", { ...report }, lines);
      return;
    }
    case "brief": {
      const brief = positional.join(" ").trim();
      const modelOpt = options.get("model");
      const genPrompt = typeof options.get("gen") === "string" ? (options.get("gen") as string) : undefined;
      const imagesOpt = options.get("images");
      const imageOpt = options.get("image");
      // One-shot: --gen "<model prompt>" (text/--via-image) or --image(s) generates the
      // model first; otherwise an existing --model GLB is required.
      const oneShot = genPrompt !== undefined || typeof imagesOpt === "string" || typeof imageOpt === "string";
      if (!brief || (!oneShot && typeof modelOpt !== "string")) {
        throw new Error(
          'usage: stereoframe brief "<brief>" (--model <glb> | --gen "<model prompt>" [--via-image] | --images a,b,c) [--render] [--llm-provider openai|anthropic] [--llm-model <id>]',
        );
      }
      const slug = brief
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "film";
      const outDir = typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${slug}-film`;
      assertWithinCwd(outDir, "--dir");

      let model: string;
      if (oneShot) {
        mkdirSync(resolve(outDir, "assets"), { recursive: true });
        const gopts = {
          projectDir: outDir,
          out: "assets/model.glb",
          texture: options.get("no-texture") !== true,
          polycount: options.has("polycount") ? Number(options.get("polycount")) : undefined,
          key: typeof options.get("key") === "string" ? (options.get("key") as string) : undefined, // Meshy
        };
        if (typeof imagesOpt === "string" || typeof imageOpt === "string") {
          const images =
            typeof imagesOpt === "string"
              ? imagesOpt.split(",").map((s) => s.trim()).filter(Boolean)
              : [imageOpt as string];
          model = await genFromImages({ images, ...gopts });
        } else if (options.has("via-image")) {
          model = await genViaImage({
            prompt: genPrompt!,
            ...gopts,
            imageKey: typeof options.get("image-key") === "string" ? (options.get("image-key") as string) : undefined,
            imageProvider: typeof options.get("image-provider") === "string" ? (options.get("image-provider") as string) : undefined,
            imageModel: typeof options.get("image-model") === "string" ? (options.get("image-model") as string) : undefined,
            imageSize: typeof options.get("size") === "string" ? (options.get("size") as string) : undefined,
          });
        } else {
          model = await genModel({ prompt: genPrompt!, ...gopts });
        }
      } else {
        model = modelOpt as string;
      }

      const vdims =
        options.get("vertical") === true
          ? { width: 1080, height: 1920 }
          : options.get("square") === true
            ? { width: 1080, height: 1080 }
            : {};
      await runBrief({
        brief,
        model,
        outDir,
        ...vdims,
        render: options.get("render") === true,
        draft: options.get("draft") === true,
        llmProvider: typeof options.get("llm-provider") === "string" ? (options.get("llm-provider") as string) : undefined,
        llmModel: typeof options.get("llm-model") === "string" ? (options.get("llm-model") as string) : undefined,
        key: typeof options.get("llm-key") === "string" ? (options.get("llm-key") as string) : undefined, // LLM
      });
      return;
    }
    case "gen": {
      const prompt = positional.join(" ").trim();
      const projectDir = typeof options.get("dir") === "string" ? (options.get("dir") as string) : ".";
      const out = typeof options.get("out") === "string" ? (options.get("out") as string) : undefined;
      assertWithinCwd(projectDir, "--dir");
      assertWithinCwd(out, "--out");
      const texture = options.get("no-texture") !== true;
      const polycount = options.has("polycount") ? Number(options.get("polycount")) : undefined;
      const key = typeof options.get("key") === "string" ? (options.get("key") as string) : undefined;
      const imageOpt = options.get("image");
      const imagesOpt = options.get("images");
      // fal.ai generation gateway: `--provider fal --fal-model <id>` (premium, PAYG).
      const provider = options.get("provider") === "fal" ? ("fal" as const) : undefined;
      const falModel = typeof options.get("fal-model") === "string" ? (options.get("fal-model") as string) : undefined;
      let falInput: Record<string, unknown> | undefined;
      if (typeof options.get("input") === "string") {
        try {
          falInput = JSON.parse(options.get("input") as string);
        } catch {
          throw new Error("--input must be valid JSON (model-specific fal input fields)");
        }
      }
      const falOpts = { provider, falModel, falInput };

      // --dry-run: resolve the plan (mode, provider, output path, key presence)
      // WITHOUT calling any paid API or writing files. Generation costs real money
      // (Meshy/fal/OpenAI) — let an agent verify before spending.
      if (options.has("dry-run")) {
        const isImg = typeof imagesOpt === "string" || typeof imageOpt === "string";
        const viaImg = options.has("via-image");
        const label = isImg
          ? basename(typeof imagesOpt === "string" ? imagesOpt.split(",")[0]! : (imageOpt as string)).replace(/\.(png|jpe?g|webp)$/i, "")
          : prompt || (typeof options.get("via-image") === "string" ? (options.get("via-image") as string) : "");
        const outPath = out ?? join("assets", `${genSlug(label || "model")}.glb`);
        const prov = provider ?? "meshy";
        const keyVar = prov === "fal" ? "FAL_KEY" : "MESHY_API_KEY";
        const hasKey = !!resolveEnvKey(keyVar, projectDir, key);
        const hasOpenai = viaImg ? !!resolveEnvKey("OPENAI_API_KEY", projectDir, undefined) : undefined;
        const notes: string[] = [];
        if (prov === "meshy" && !hasKey) notes.push("no MESHY_API_KEY → would use test mode (sample model, ignores prompt)");
        if (prov === "fal" && !hasKey) notes.push("no FAL_KEY → generation would fail");
        if (viaImg && !hasOpenai) notes.push("no OPENAI_API_KEY → the --via-image image step would fail");
        const mode = isImg ? "image-to-3d" : viaImg ? "via-image" : "text-to-3d";
        reportResult(
          "gen",
          { dryRun: true, mode, provider: prov, output: join(resolve(projectDir), outPath), [keyVar]: hasKey, ...(viaImg ? { OPENAI_API_KEY: hasOpenai } : {}), ...(notes.length ? { notes } : {}) },
          [
            `dry-run: ${mode} via ${prov} → ${outPath}`,
            `  ${keyVar}: ${hasKey ? "present" : "MISSING"}`,
            ...(viaImg ? [`  OPENAI_API_KEY: ${hasOpenai ? "present" : "MISSING"}`] : []),
            ...notes.map((n) => `  note: ${n}`),
          ],
        );
        return;
      }

      let glbPath: string;
      if (typeof imagesOpt === "string" || typeof imageOpt === "string") {
        // image-to-3D / multi-image-to-3D from local image(s)
        const images =
          typeof imagesOpt === "string"
            ? imagesOpt.split(",").map((s) => s.trim()).filter(Boolean)
            : [imageOpt as string];
        glbPath = await genFromImages({ images, projectDir, out, texture, polycount, key, ...falOpts });
      } else if (options.has("via-image")) {
        // text → reference image → image-to-3D. (Tolerate `gen --via-image "prompt"`
        // where the prompt is captured as the flag's value.)
        const viaPrompt = prompt || (typeof options.get("via-image") === "string" ? (options.get("via-image") as string) : "");
        if (!viaPrompt) throw new Error('usage: stereoframe gen "<prompt>" --via-image');
        glbPath = await genViaImage({
          prompt: viaPrompt,
          projectDir,
          out,
          texture,
          polycount,
          key,
          imageKey: typeof options.get("image-key") === "string" ? (options.get("image-key") as string) : undefined,
          imageProvider: typeof options.get("image-provider") === "string" ? (options.get("image-provider") as string) : undefined,
          imageModel: typeof options.get("image-model") === "string" ? (options.get("image-model") as string) : undefined,
          imageSize: typeof options.get("size") === "string" ? (options.get("size") as string) : undefined,
          ...falOpts,
        });
      } else {
        if (!prompt) {
          throw new Error('usage: stereoframe gen "<prompt>" [--via-image] | --image <png> | --images a,b,c [--stage <preset>] [--render]');
        }
        glbPath = await genModel({ prompt, projectDir, out, texture, polycount, key, ...falOpts });
      }

      // One-shot: model → directed film (→ optional render).
      const stagePreset = options.get("stage");
      if (typeof stagePreset === "string") {
        const preset = stagePreset as Preset;
        if (!PRESETS.includes(preset)) {
          throw new CliError(`unknown preset: ${preset}`, "unknown_preset", `presets: ${PRESETS.join(", ")}`);
        }
        const slug = (prompt || basename(glbPath).replace(/\.glb$/i, "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "gen";
        const stageDir =
          typeof options.get("stage-dir") === "string" ? (options.get("stage-dir") as string) : `${slug}-${preset}`;
        assertWithinCwd(stageDir, "--stage-dir");
        const created = await runStage({
          model: glbPath,
          outDir: stageDir,
          preset,
          duration: options.has("duration") ? Number(options.get("duration")) : undefined,
          background: typeof options.get("bg") === "string" ? (options.get("bg") as string) : undefined,
          title: typeof options.get("title") === "string" ? (options.get("title") as string) : undefined,
        });
        if (options.get("render") === true) {
          const rout = await renderProject({ projectDir: created, draft: options.get("draft") === true });
          reportResult("gen", { outputs: [rout], glb: glbPath, preset }, [rout]);
        } else {
          reportResult("gen", { outputs: [created], glb: glbPath, preset, next: `cd ${stageDir} && stereoframe render` }, [
            `next: cd ${stageDir} && stereoframe render`,
          ]);
        }
      } else {
        reportResult("gen", { outputs: [glbPath], provider: provider ?? "meshy" }, [glbPath]);
      }
      return;
    }
    case "add": {
      const name = positional[0];
      if (!name) throw new Error(`usage: stereoframe add <block>\n\navailable blocks:\n${listBlocks()}`);
      console.log(addBlock(name, positional[1] ?? "."));
      return;
    }
    case "blocks": {
      console.log(listBlocks());
      return;
    }
    case "update": {
      const updated = updateRuntime(dir);
      reportResult("update", { outputs: [updated] }, [`updated ${updated}`]);
      return;
    }
    case "schema": {
      // Always JSON — this command exists for agents to read the spec from code
      // (so it never drifts from the SKILL/docs).
      const only = typeof options.get("command") === "string" ? (options.get("command") as string) : undefined;
      if (only) {
        const cmd = COMMANDS.find((c) => c.name === only);
        if (!cmd) throw new CliError(`unknown command: ${only}`, "unknown_command", `valid: ${COMMAND_NAMES.join(", ")}`);
        console.log(JSON.stringify(cmd, null, 2));
        return;
      }
      const spec = {
        commands: COMMANDS,
        vocab: {
          elements: ELEMENT_NAMES,
          verbs: VERB_PARAMS,
          commonVerbAttrs: COMMON_VERB_ATTRS,
          eases: EASE_NAMES,
          assetAttrs: ASSET_ATTRS,
          geometry: GEOMETRY_KINDS,
          materials: MATERIAL_KINDS,
          finishAttrs: FINISH_ATTRS,
          stagePresets: STAGE_PRESETS,
          genProviders: GEN_PROVIDERS,
        },
      };
      console.log(JSON.stringify(spec, null, 2));
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default: {
      const hint = suggestCommand(command);
      throw new CliError(
        `unknown command: ${command}`,
        "unknown_command",
        `${hint ? `did you mean "${hint}"? ` : ""}valid commands: ${COMMAND_NAMES.join(", ")}`,
      );
    }
  }
}

function reportFindings(command: string, findings: Finding[], asJson: boolean): void {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  if (asJson) {
    console.log(JSON.stringify({ command, errors, warnings, findings }, null, 2));
  } else {
    for (const f of findings) {
      const mark = f.severity === "error" ? "✗" : "⚠";
      console.log(`  ${mark} ${f.rule}: ${f.message}`);
      if (f.fixHint) console.log(`    Fix: ${f.fixHint}`);
    }
    console.log(`${command}: ${errors} error(s), ${warnings} warning(s)`);
  }
  // Exit 2 = the composition has findings (distinct from 1 = the tool errored), so
  // agents/CI can tell "your scene is broken" from "stereoframe crashed".
  if (errors > 0) process.exit(2);
}

main().catch((err: unknown) => {
  const code = err instanceof CliError ? err.code : "runtime_error";
  const hint = err instanceof CliError ? err.hint : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (WANT_JSON) {
    console.log(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }));
  } else {
    console.error(message);
    if (hint) console.error(`  ${hint}`);
  }
  process.exit(1);
});
