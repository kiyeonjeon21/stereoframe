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
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { basename } from "node:path";
import { addBlock, listBlocks } from "./blocks";
import { genModel, genFromImages, genViaImage } from "./gen";
import { inspectModel } from "./inspect";
import { bakeProject } from "./bake";
import { buildStoryboard, readStoryboard, validateStoryboard } from "./storyboard";
import { runBrief } from "./brief";
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
      --model <glb>    the model to direct (required)
      --dir <dir>      output project dir (default: <brief> slug or film)
      --render         compile + render the result to mp4 (--draft for fast)
      --llm-model <n>  LLM model (default gpt-4o; or OPENAI_MODEL); needs OPENAI_API_KEY
  stereoframe storyboard <plan.json>   compile a shot plan (JSON) into a multi-shot directed film
      --dir <dir>      output project dir (default: <title> slug or <stem>-film)
      --render         render the compiled film to mp4 (--draft for fast)
  stereoframe inspect <model.glb>      segment + tag a GLB: list its parts (name, material, where, size)
      --json           print the manifest as JSON instead of a table
  stereoframe gen "<prompt>"           generate a 3D model (GLB) via Meshy
      --image <png>    image-to-3D from one local image (instead of text)
      --images a,b,c   multi-image-to-3D from 1-4 views (front/side/back…)
      --via-image      text → image (OpenAI gpt-image-1) → image-to-3D, more art-directable
      --image-provider openai (default; for --via-image)   --size <wxh>   --image-key <key>
      --dir <dir>      project dir (default .)
      --out <path>     output path (default assets/<slug>.glb)
      --no-texture     skip the PBR texture pass (faster, untextured mesh)
      --polycount <n>  target polygon count
      --key <key>      Meshy API key (else MESHY_API_KEY / .env / test mode)
      --stage <preset> one-shot: generate then stage into a film (reveal|hero-orbit|turntable|exploded-view|spec|teardown)
      --render         with --stage, also render the result to mp4 (--draft for fast)
  stereoframe add <block> [dir]        install a visual block's assets + print usage
  stereoframe blocks                   list available blocks
  stereoframe update [dir]             refresh assets/stereoframe.js from the CLI's bundled runtime
`;

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
  console.log(`inspecting ${model}…`);
  const manifest = await inspectModel({ model, silent: true, write: false });
  const metalRig =
    manifest.dominant.character === "metal" && (manifest.dominant.metalness ?? 0) > 0.6;
  if (metalRig) console.log("  dominant material is metal → tamed exposure + rim/fill rig");

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
      console.warn(`note: ${model} has <2 separable mesh parts — ${preset} film will render without callouts.`);
    } else {
      console.log(`  callouts: ${callouts.map((c) => c.value).join(", ")}`);
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
  console.log(`staged ${model} (${preset}) → ${created}`);
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
      const created = scaffoldProject(name);
      console.log(`created ${created}`);
      console.log(`next: cd ${name} && stereoframe render`);
      return;
    }
    case "lint": {
      const htmlPath = join(resolve(dir), "index.html");
      if (!existsSync(htmlPath)) throw new Error(`no index.html in ${resolve(dir)}`);
      const findings = lintHtml(readFileSync(htmlPath, "utf8"), {
        fileExists: (rel) => existsSync(join(resolve(dir), rel)),
      });
      reportFindings("lint", findings, options.get("json") === true);
      return;
    }
    case "validate": {
      const findings = await validateProject(dir);
      reportFindings("validate", findings, options.get("json") === true);
      return;
    }
    case "bake": {
      const target = options.get("target");
      if (typeof target !== "string") {
        throw new Error("usage: stereoframe bake [dir] --target <element-id> [--fps n] [--out file.bin]");
      }
      const out = await bakeProject({
        projectDir: dir,
        target,
        fps: options.has("fps") ? Number(options.get("fps")) : undefined,
        out: typeof options.get("out") === "string" ? (options.get("out") as string) : undefined,
      });
      console.log(`baked → ${out}`);
      return;
    }
    case "render": {
      const out = await renderProject({
        projectDir: dir,
        fps: options.has("fps") ? Number(options.get("fps")) : undefined,
        crf: options.has("crf") ? Number(options.get("crf")) : undefined,
        out: typeof options.get("out") === "string" ? (options.get("out") as string) : undefined,
        draft: options.get("draft") === true,
      });
      console.log(out);
      return;
    }
    case "preview": {
      const port = options.has("port") ? Number(options.get("port")) : 0;
      const handle = await serveProject(dir, port);
      console.log(`preview: ${handle.url}?sf-preview`);
      console.log("press ctrl-c to stop");
      return; // server keeps the process alive
    }
    case "inspect": {
      const model = positional[0];
      if (!model) throw new Error("usage: stereoframe inspect <model.glb> [--json]");
      await inspectModel({ model, json: options.get("json") === true });
      return;
    }
    case "stage": {
      const model = positional[0];
      if (!model) throw new Error('usage: stereoframe stage <model.glb> [--preset reveal|hero-orbit|turntable]');
      const preset = (typeof options.get("preset") === "string" ? options.get("preset") : "reveal") as Preset;
      if (!PRESETS.includes(preset)) {
        throw new Error(`unknown preset: ${preset}\n\npresets: ${PRESETS.join(", ")}`);
      }
      const stem = basename(model).replace(/\.(glb|gltf)$/i, "");
      const outDir =
        typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${stem}-${preset}`;
      await runStage({
        model,
        outDir,
        preset,
        duration: options.has("duration") ? Number(options.get("duration")) : undefined,
        background: typeof options.get("bg") === "string" ? (options.get("bg") as string) : undefined,
        title: typeof options.get("title") === "string" ? (options.get("title") as string) : undefined,
      });
      console.log(`next: cd ${outDir} && stereoframe render`);
      return;
    }
    case "storyboard": {
      const planPath = positional[0];
      if (!planPath) {
        throw new Error("usage: stereoframe storyboard <plan.json> [--dir out] [--render]");
      }
      const { plan, planDir } = readStoryboard(planPath);
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
      console.log(`compiled ${plan.shots.length} shot(s), ${duration.toFixed(1)}s → ${built}`);
      if (options.get("render") === true) {
        const out = await renderProject({ projectDir: built, draft: options.get("draft") === true });
        console.log(out);
      } else {
        console.log(`next: cd ${outDir} && stereoframe render`);
      }
      return;
    }
    case "brief": {
      const brief = positional.join(" ").trim();
      const model = options.get("model");
      if (!brief || typeof model !== "string") {
        throw new Error('usage: stereoframe brief "<brief>" | <brief.md> --model <model.glb> [--dir out] [--render] [--draft] [--llm-model <name>]');
      }
      const slug = brief
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "film";
      const outDir = typeof options.get("dir") === "string" ? (options.get("dir") as string) : `${slug}-film`;
      await runBrief({
        brief,
        model,
        outDir,
        render: options.get("render") === true,
        draft: options.get("draft") === true,
        llmModel: typeof options.get("llm-model") === "string" ? (options.get("llm-model") as string) : undefined,
        key: typeof options.get("key") === "string" ? (options.get("key") as string) : undefined,
      });
      return;
    }
    case "gen": {
      const prompt = positional.join(" ").trim();
      const projectDir = typeof options.get("dir") === "string" ? (options.get("dir") as string) : ".";
      const out = typeof options.get("out") === "string" ? (options.get("out") as string) : undefined;
      const texture = options.get("no-texture") !== true;
      const polycount = options.has("polycount") ? Number(options.get("polycount")) : undefined;
      const key = typeof options.get("key") === "string" ? (options.get("key") as string) : undefined;
      const imageOpt = options.get("image");
      const imagesOpt = options.get("images");

      let glbPath: string;
      if (typeof imagesOpt === "string" || typeof imageOpt === "string") {
        // image-to-3D / multi-image-to-3D from local image(s)
        const images =
          typeof imagesOpt === "string"
            ? imagesOpt.split(",").map((s) => s.trim()).filter(Boolean)
            : [imageOpt as string];
        glbPath = await genFromImages({ images, projectDir, out, texture, polycount, key });
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
          imageSize: typeof options.get("size") === "string" ? (options.get("size") as string) : undefined,
        });
      } else {
        if (!prompt) {
          throw new Error('usage: stereoframe gen "<prompt>" [--via-image] | --image <png> | --images a,b,c [--stage <preset>] [--render]');
        }
        glbPath = await genModel({ prompt, projectDir, out, texture, polycount, key });
      }

      // One-shot: model → directed film (→ optional render).
      const stagePreset = options.get("stage");
      if (typeof stagePreset === "string") {
        const preset = stagePreset as Preset;
        if (!PRESETS.includes(preset)) {
          throw new Error(`unknown preset: ${preset}\n\npresets: ${PRESETS.join(", ")}`);
        }
        const slug = (prompt || basename(glbPath).replace(/\.glb$/i, "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "gen";
        const outDir =
          typeof options.get("stage-dir") === "string" ? (options.get("stage-dir") as string) : `${slug}-${preset}`;
        const created = await runStage({
          model: glbPath,
          outDir,
          preset,
          duration: options.has("duration") ? Number(options.get("duration")) : undefined,
          background: typeof options.get("bg") === "string" ? (options.get("bg") as string) : undefined,
          title: typeof options.get("title") === "string" ? (options.get("title") as string) : undefined,
        });
        if (options.get("render") === true) {
          const out = await renderProject({ projectDir: created, draft: options.get("draft") === true });
          console.log(out);
        } else {
          console.log(`next: cd ${outDir} && stereoframe render`);
        }
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
      console.log(`updated ${updateRuntime(dir)}`);
      return;
    }
    case "help":
    case "--help":
    case undefined:
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
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
  if (errors > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
