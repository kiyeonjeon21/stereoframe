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
import { join, resolve, basename } from "node:path";
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
  IR_DRIVER_KINDS,
  IR_BEHAVIOR_KINDS,
  IR_TIMELINE_KINDS,
  IR_CHANNELS,
  IR_VERB_CHANNEL,
} from "stereoframe-runtime/vocab";
import { addBlock, listBlocks } from "./blocks";
import {
  buildGenDryRunPlan,
  genModel,
  genFromImages,
  genViaImage,
  validateImageInputs,
  type GenDryRunPlan,
} from "./gen";
import { validateOpenAIImageOptions, type OpenAIImageOptions } from "./imagegen";
import { inspectModel } from "./inspect";
import { writeQualityReport, type QualityReport } from "./quality";
import { bakeProject } from "./bake";
import { buildStoryboard, readStoryboard, validateStoryboard } from "./storyboard";
import { runBrief } from "./brief";
import { segmentModel } from "./segment";
import { buildAutoCallouts, explodeTiming, PRESETS, stageModel, type Preset } from "./stage";
import { lintHtml, type Finding } from "./lint";
import { renderProject } from "./render";
import { captureFrame } from "./frame";
import { scaffoldProject, updateRuntime } from "./scaffold";
import { serveProject } from "./serve";
import { validateProject } from "./validate";
import { auditModel, evaluateModels } from "./evaluate";

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

/** A command's result: JSON `{ok,command,...}` to stdout for agents, prose for humans. */
function reportResult(command: string, payload: Record<string, unknown>, lines: string[]): void {
  if (WANT_JSON) {
    console.log(JSON.stringify({ ok: true, command, ...payload }));
  } else {
    for (const l of lines) console.log(l);
  }
}

const HELP = `stereoframe — deterministic GLB evaluation and 3D video on three.js

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
  stereoframe frame [dir]              render a single frame to PNG (look at your scene without a full render)
      --t <seconds>    time to capture (default 0, clamped to duration)
      --out <path>     output file (default frames/frame_<t>s.png)
  stereoframe bake [dir]               freeze a forward-mode sim into a seekable cache for <sf-baked>
      --target <id>    the InstancedMesh element id to bake (required)
      --fps <n>        bake frame rate (default 30)
  stereoframe preview [dir]            serve with looping wall-clock playback
      --port <n>       fixed port (default: random)
  stereoframe evaluate <a.glb> [b.glb…]   inspect, score, compare, and stage GLBs as evidence
      --dir <dir>      output evaluation suite (default: glb-evaluation)
      --title "<text>" report/comparison title
      --audit          one GLB -> animated audit report (report.html, parts.json, optional report.mp4)
      --frames [list]  capture evidence frames (compare default: 0,2,4,6; audit default: overview/structure/parts)
      --render         render standardized comparison/audit mp4 (--draft for fast)
  stereoframe stage <model.glb>        stage an accepted GLB into a deterministic preview/film
      --preset <name>  reveal | hero-orbit | turntable | exploded-view | spec | teardown | cinematic (default reveal)
                       spec     = auto-annotated asset preview (inspects the GLB, places named callouts)
                       teardown = exploded view with a labelled callout tracking each separated part
      --dir <dir>      output project dir (default: <model name>)
      --duration <s>   seconds (default 8; cinematic default 11.5)
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
  stereoframe gen "<prompt>"           labs: generate a candidate GLB via Meshy/fal.ai
      --image <png>    image-to-3D from one local image (instead of text)
      --images a,b,c   multi-image-to-3D from 1-4 views (front/side/back…)
      --via-image      text → image (OpenAI gpt-image-2) → image-to-3D, more art-directable
      --image-provider openai (default)  --image-model <id>  --size <wxh>  --image-key <key>
      --image-quality low|medium|high|auto  --image-format png|jpeg|webp
      --image-compression <0-100>  --image-background auto|opaque  --image-moderation auto|low
      --provider fal   generate via fal.ai (premium, pay-as-you-go) instead of Meshy
      --fal-model <id>   fal model, e.g. tripo3d/tripo/v2.5/text-to-3d  (browse fal.ai/models?categories=3d)
      --input '<json>'   model-specific fal input fields (merged into the request)
      --dir <dir>      project dir (default .)
      --out <path>     output path (default assets/<slug>.glb)
      --no-texture     skip the PBR texture pass (faster, untextured mesh)
      --polycount <n>  target polygon count
      --key <key>      Meshy API key (else MESHY_API_KEY / .env / test mode)
      --dry-run        resolve the plan (mode, provider, output path, key presence) without spending
      --quality-report inspect the generated GLB and write <name>.quality.json
      --stage <preset> one-shot: generate then stage into a film (reveal|hero-orbit|turntable|exploded-view|spec|teardown|cinematic)
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
  { name: "frame", summary: "render a single frame to PNG for visual inspection", flags: ["t", "out", "json"] },
  { name: "bake", summary: "freeze a forward-mode sim into a seekable cache", flags: ["target", "fps", "out"] },
  { name: "preview", summary: "serve with looping wall-clock playback", flags: ["port"] },
  { name: "stage", summary: "stage an accepted GLB into a deterministic preview or film", args: ["model.glb"], flags: ["preset", "dir", "duration", "title", "bg", "json"] },
  { name: "evaluate", summary: "inspect, score, compare, and stage GLBs as evidence", args: ["model.glb..."], flags: ["dir", "title", "audit", "frames", "render", "draft", "json"] },
  { name: "brief", summary: "natural-language directing → a plan.json (via an LLM)", flags: ["model", "gen", "dir", "render", "llm-provider", "vertical", "square"] },
  { name: "storyboard", summary: "compile a shot plan (JSON) into a multi-shot film", args: ["plan.json"], flags: ["dir", "render", "vertical", "square", "json"] },
  { name: "inspect", summary: "segment + tag a GLB: list its parts", args: ["model.glb"], flags: ["json"] },
  { name: "segment", summary: "report a mesh's separable connected components", args: ["model.glb"], flags: ["min-faces", "json"] },
  {
    name: "gen",
    summary: "labs: generate a candidate 3D model (GLB) via Meshy or fal.ai",
    args: ["prompt"],
    flags: [
      "image",
      "images",
      "via-image",
      "image-provider",
      "image-model",
      "image-key",
      "image-quality",
      "image-format",
      "image-compression",
      "image-background",
      "image-moderation",
      "size",
      "provider",
      "fal-model",
      "input",
      "dir",
      "out",
      "no-texture",
      "polycount",
      "key",
      "dry-run",
      "quality-report",
      "stage",
      "stage-dir",
      "duration",
      "bg",
      "title",
      "render",
      "draft",
      "json",
    ],
  },
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

function stringOpt(options: Map<string, string | boolean>, name: string): string | undefined {
  const v = options.get(name);
  return typeof v === "string" ? v : undefined;
}

function numberOpt(options: Map<string, string | boolean>, name: string): number | undefined {
  if (!options.has(name)) return undefined;
  const raw = options.get(name);
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number`, "invalid_flag");
  return n;
}

function integerOpt(options: Map<string, string | boolean>, name: string): number | undefined {
  const n = numberOpt(options, name);
  if (n !== undefined && !Number.isInteger(n)) throw new CliError(`--${name} must be an integer`, "invalid_flag");
  return n;
}

function parseJsonObject(raw: string | undefined, flag: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new CliError(`--${flag} must be a valid JSON object`, "invalid_flag");
  }
}

function imageOptionsFromFlags(options: Map<string, string | boolean>): OpenAIImageOptions {
  return {
    quality: stringOpt(options, "image-quality") as OpenAIImageOptions["quality"],
    format: stringOpt(options, "image-format") as OpenAIImageOptions["format"],
    compression: integerOpt(options, "image-compression"),
    background: stringOpt(options, "image-background") as OpenAIImageOptions["background"],
    moderation: stringOpt(options, "image-moderation") as OpenAIImageOptions["moderation"],
  };
}

function framesOpt(options: Map<string, string | boolean>): number[] | undefined {
  if (!options.has("frames")) return undefined;
  const raw = options.get("frames");
  if (raw === true) return [0, 2, 4, 6];
  if (typeof raw !== "string") return undefined;
  const frames = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (frames.length === 0) throw new CliError("--frames must be a comma-separated list of seconds", "invalid_flag");
  return frames;
}

function auditFramesOpt(options: Map<string, string | boolean>): number[] | "default" | undefined {
  if (!options.has("frames")) return undefined;
  const raw = options.get("frames");
  if (raw === true) return "default";
  return framesOpt(options);
}

async function maybeWriteQualityReport(glbPath: string, enabled: boolean): Promise<{ path: string; report: QualityReport } | undefined> {
  if (!enabled) return undefined;
  console.error(`inspecting ${glbPath} for quality report…`);
  const manifest = await inspectModel({ model: glbPath, silent: true, write: false });
  const quality = writeQualityReport(glbPath, manifest);
  const warningCount = quality.report.warnings.length;
  console.error(`  quality report → ${quality.path}${warningCount ? ` (${warningCount} warning${warningCount === 1 ? "" : "s"})` : ""}`);
  return quality;
}

function qualityPayload(quality: { path: string; report: QualityReport } | undefined): Record<string, unknown> {
  if (!quality) return {};
  return {
    qualityReport: quality.path,
    qualityWarnings: quality.report.warnings.map((w) => w.code),
  };
}

function dryRunLines(plan: GenDryRunPlan): string[] {
  const lines = [`dry-run: ${plan.mode} via ${plan.provider} -> ${plan.output}`];
  for (const [key, present] of Object.entries(plan.keys)) lines.push(`  ${key}: ${present ? "present" : "MISSING"}`);
  if (plan.sourceImageOutput) lines.push(`  source image: ${plan.sourceImageOutput}`);
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  return lines;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  const dir = positional[0] ?? ".";

  switch (command) {
    case "init": {
      const name = positional[0];
      if (!name) throw new Error("usage: stereoframe init <name>");
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
    case "frame": {
      const frameOut = typeof options.get("out") === "string" ? (options.get("out") as string) : undefined;
      const t = options.has("t") ? Number(options.get("t")) : 0;
      if (Number.isNaN(t)) {
        throw new CliError("--t must be a number of seconds", "bad_argument", "e.g. --t 1.5");
      }
      const r = await captureFrame({ projectDir: dir, t, out: frameOut });
      reportResult(
        "frame",
        { outputs: [r.out], t: r.t, durationSec: r.duration, width: r.width, height: r.height },
        [r.out],
      );
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
      if (!model) throw new Error(`usage: stereoframe stage <model.glb> [--preset ${PRESETS.join("|")}]`);
      const preset = (typeof options.get("preset") === "string" ? options.get("preset") : "reveal") as Preset;
      if (!PRESETS.includes(preset)) {
        throw new CliError(`unknown preset: ${preset}`, "unknown_preset", `presets: ${PRESETS.join(", ")}`);
      }
      const stem = basename(model).replace(/\.(glb|gltf)$/i, "");
      const outDir =
        typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${stem}-${preset}`;
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
    case "evaluate": {
      if (positional.length === 0) {
        throw new Error("usage: stereoframe evaluate <a.glb> [b.glb…] [--dir out] [--audit] [--frames 0,2,4] [--render]");
      }
      const audit = options.get("audit") === true;
      if (audit && positional.length !== 1) {
        throw new CliError("--audit expects exactly one GLB", "invalid_flag", "run evaluate without --audit to compare multiple GLBs");
      }
      const defaultDir =
        audit
          ? `${basename(positional[0]!).replace(/\.(glb|gltf)$/i, "")}-audit`
          : positional.length === 1
          ? `${basename(positional[0]!).replace(/\.(glb|gltf)$/i, "")}-evaluation`
          : "glb-evaluation";
      if (audit) {
        const result = await auditModel({
          model: positional[0]!,
          outDir: stringOpt(options, "dir") ?? defaultDir,
          title: stringOpt(options, "title"),
          frames: auditFramesOpt(options),
          render: options.get("render") === true,
          draft: options.get("draft") === true,
        });
        const outputs = [
          result.reportHtml,
          result.index,
          result.report,
          result.summary,
          result.parts,
          join(result.dir, result.asset.report),
          ...result.frames.map((frame) => frame.out),
          ...(result.render ? [result.render] : []),
        ];
        reportResult(
          "evaluate",
          {
            outputs,
            mode: "audit",
            dir: result.dir,
            asset: {
              label: result.asset.label,
              score: result.asset.score,
              warnings: result.asset.quality.warnings.map((w) => w.code),
              report: join(result.dir, result.asset.report),
              separable: result.audit.asset.separable,
              selectedPartCount: result.audit.asset.selectedPartCount,
            },
            frames: result.frames.map((frame) => frame.out),
            ...(result.render ? { render: result.render } : {}),
          },
          [
            `audit → ${result.dir}`,
            `report → ${result.report}`,
            `html → ${result.reportHtml}`,
            ...(result.render ? [`render → ${result.render}`] : []),
          ],
        );
        return;
      }
      const result = await evaluateModels({
        models: positional,
        outDir: stringOpt(options, "dir") ?? defaultDir,
        title: stringOpt(options, "title"),
        frames: framesOpt(options),
        render: options.get("render") === true,
        draft: options.get("draft") === true,
      });
      const outputs = [
        result.index,
        result.report,
        result.summary,
        ...result.assets.map((asset) => join(result.dir, asset.report)),
        ...result.frames.map((frame) => frame.out),
        ...(result.render ? [result.render] : []),
      ];
      reportResult(
        "evaluate",
        {
          outputs,
          dir: result.dir,
          assets: result.assets.map((asset) => ({
            label: asset.label,
            score: asset.score,
            warnings: asset.quality.warnings.map((w) => w.code),
            report: join(result.dir, asset.report),
          })),
          frames: result.frames.map((frame) => frame.out),
          ...(result.render ? { render: result.render } : {}),
        },
        [
          `evaluation → ${result.dir}`,
          `report → ${result.report}`,
          ...(result.render ? [`render → ${result.render}`] : []),
        ],
      );
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

      let model: string;
      if (oneShot) {
        mkdirSync(resolve(outDir, "assets"), { recursive: true });
        const gopts = {
          projectDir: outDir,
          out: "assets/model.glb",
          texture: options.get("no-texture") !== true,
          polycount: integerOpt(options, "polycount"),
          key: stringOpt(options, "key"), // Meshy
        };
        if (typeof imagesOpt === "string" || typeof imageOpt === "string") {
          const images =
            typeof imagesOpt === "string"
              ? imagesOpt.split(",").map((s) => s.trim()).filter(Boolean)
              : [imageOpt as string];
          model = await genFromImages({ images, ...gopts });
        } else if (options.has("via-image")) {
          const imageOptions = imageOptionsFromFlags(options);
          const imageErrors = validateOpenAIImageOptions({
            ...imageOptions,
            model: stringOpt(options, "image-model"),
            size: stringOpt(options, "size"),
          });
          if (imageErrors.length) throw new CliError(imageErrors.join("; "), "invalid_gen_options");
          model = await genViaImage({
            prompt: genPrompt!,
            ...gopts,
            imageKey: stringOpt(options, "image-key"),
            imageProvider: stringOpt(options, "image-provider"),
            imageModel: stringOpt(options, "image-model"),
            imageSize: stringOpt(options, "size"),
            imageOptions,
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
      const projectDir = stringOpt(options, "dir") ?? ".";
      const out = stringOpt(options, "out");
      const texture = options.get("no-texture") !== true;
      const polycount = integerOpt(options, "polycount");
      const key = stringOpt(options, "key");
      const imageOpt = stringOpt(options, "image");
      const imagesOpt = stringOpt(options, "images");
      if (options.has("image") && !imageOpt) throw new CliError("--image requires a path", "invalid_flag");
      if (options.has("images") && !imagesOpt) throw new CliError("--images requires a comma-separated list", "invalid_flag");
      const images =
        imagesOpt !== undefined
          ? imagesOpt.split(",").map((s) => s.trim()).filter(Boolean)
          : imageOpt !== undefined
            ? [imageOpt]
            : [];
      // fal.ai generation gateway: `--provider fal --fal-model <id>` (premium, PAYG).
      const providerFlag = stringOpt(options, "provider");
      if (providerFlag && providerFlag !== "meshy" && providerFlag !== "fal") {
        throw new CliError(`unknown provider: ${providerFlag}`, "invalid_flag", "providers: meshy, fal");
      }
      const provider = providerFlag === "fal" ? ("fal" as const) : undefined;
      const falModel = stringOpt(options, "fal-model");
      const falInput = parseJsonObject(stringOpt(options, "input"), "input");
      const falOpts = { provider, falModel, falInput };
      const imageOptions = imageOptionsFromFlags(options);
      const imageProvider = stringOpt(options, "image-provider");
      const imageModel = stringOpt(options, "image-model");
      const imageSize = stringOpt(options, "size");
      const imageKey = stringOpt(options, "image-key");
      const viaPrompt = prompt || (typeof options.get("via-image") === "string" ? (options.get("via-image") as string) : "");

      // --dry-run: resolve the plan (mode, provider, output path, key presence)
      // WITHOUT calling any paid API or writing files. Generation costs real money
      // (Meshy/fal/OpenAI) — let an agent verify before spending.
      if (options.has("dry-run")) {
        const plan = buildGenDryRunPlan({
          prompt: viaPrompt || prompt,
          projectDir,
          out,
          texture,
          polycount,
          key,
          images,
          viaImage: options.has("via-image"),
          imageKey,
          imageProvider,
          imageModel,
          imageSize,
          imageOptions,
          ...falOpts,
          qualityReport: options.get("quality-report") === true,
        });
        if (plan.errors.length) {
          throw new CliError(`gen dry-run failed validation: ${plan.errors.join("; ")}`, "invalid_gen_options");
        }
        reportResult(
          "gen",
          { ...plan, ...(plan.notes.length ? { notes: plan.notes } : {}) },
          dryRunLines(plan),
        );
        return;
      }

      let glbPath: string;
      if (images.length > 0) {
        if (options.has("via-image")) throw new CliError("choose either --image/--images or --via-image, not both", "invalid_gen_options");
        const inputErrors = validateImageInputs({ projectDir, images, provider: provider ?? "meshy" });
        if (inputErrors.length) throw new CliError(inputErrors.join("; "), "invalid_gen_options");
        // image-to-3D / multi-image-to-3D from local image(s)
        glbPath = await genFromImages({ images, projectDir, out, texture, polycount, key, ...falOpts });
      } else if (options.has("via-image")) {
        // text → reference image → image-to-3D. (Tolerate `gen --via-image "prompt"`
        // where the prompt is captured as the flag's value.)
        if (!viaPrompt) throw new Error('usage: stereoframe gen "<prompt>" --via-image');
        const imageErrors = validateOpenAIImageOptions({ ...imageOptions, model: imageModel, size: imageSize });
        if (imageErrors.length) throw new CliError(imageErrors.join("; "), "invalid_gen_options");
        glbPath = await genViaImage({
          prompt: viaPrompt,
          projectDir,
          out,
          texture,
          polycount,
          key,
          imageKey,
          imageProvider,
          imageModel,
          imageSize,
          imageOptions,
          ...falOpts,
        });
      } else {
        if (!prompt) {
          throw new Error('usage: stereoframe gen "<prompt>" [--via-image] | --image <png> | --images a,b,c [--stage <preset>] [--render]');
        }
        glbPath = await genModel({ prompt, projectDir, out, texture, polycount, key, ...falOpts });
      }
      const quality = await maybeWriteQualityReport(glbPath, options.get("quality-report") === true);

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
        const created = await runStage({
          model: glbPath,
          outDir: stageDir,
          preset,
          duration: numberOpt(options, "duration"),
          background: stringOpt(options, "bg"),
          title: stringOpt(options, "title"),
        });
        if (options.get("render") === true) {
          const rout = await renderProject({ projectDir: created, draft: options.get("draft") === true });
          reportResult("gen", { outputs: [rout, ...(quality ? [quality.path] : [])], glb: glbPath, preset, ...qualityPayload(quality) }, [rout]);
        } else {
          reportResult("gen", { outputs: [created, ...(quality ? [quality.path] : [])], glb: glbPath, preset, next: `cd ${stageDir} && stereoframe render`, ...qualityPayload(quality) }, [
            `next: cd ${stageDir} && stereoframe render`,
          ]);
        }
      } else {
        reportResult("gen", { outputs: [glbPath, ...(quality ? [quality.path] : [])], provider: provider ?? "meshy", ...qualityPayload(quality) }, [glbPath]);
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
        ir: {
          driverKinds: IR_DRIVER_KINDS,
          behaviorKinds: IR_BEHAVIOR_KINDS,
          timelineKinds: IR_TIMELINE_KINDS,
          channels: IR_CHANNELS,
          verbChannel: IR_VERB_CHANNEL,
          targetForms: ["camera", "#id", "#model/part (GLB part by name or index; core=\"ir\")"],
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
