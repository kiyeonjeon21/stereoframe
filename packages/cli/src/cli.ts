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
import { genModel } from "./gen";
import { PRESETS, stageModel, type Preset } from "./stage";
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
  stereoframe preview [dir]            serve with looping wall-clock playback
      --port <n>       fixed port (default: random)
  stereoframe stage <model.glb>        auto-direct a GLB into a cinematic motion graphic
      --preset <name>  reveal | hero-orbit | turntable (default reveal)
      --dir <dir>      output project dir (default: <model name>)
      --duration <s>   seconds (default 8)
      --title "<text>" optional title overlay
      --bg <color>     background color (preset default otherwise)
  stereoframe gen "<prompt>"           generate a 3D model (GLB) from text via Meshy
      --dir <dir>      project dir (default .)
      --out <path>     output path (default assets/<slug>.glb)
      --no-texture     skip the PBR texture pass (faster, untextured mesh)
      --polycount <n>  target polygon count
      --key <key>      Meshy API key (else MESHY_API_KEY / .env / test mode)
  stereoframe add <block> [dir]        install a visual block's assets + print usage
  stereoframe blocks                   list available blocks
  stereoframe update [dir]             refresh assets/stereoframe.js from the CLI's bundled runtime
`;

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
      const created = stageModel({
        model,
        projectDir: outDir,
        preset,
        duration: options.has("duration") ? Number(options.get("duration")) : undefined,
        background: typeof options.get("bg") === "string" ? (options.get("bg") as string) : undefined,
        title: typeof options.get("title") === "string" ? (options.get("title") as string) : undefined,
      });
      console.log(`staged ${model} (${preset}) → ${created}`);
      console.log(`next: cd ${outDir} && stereoframe render`);
      return;
    }
    case "gen": {
      const prompt = positional.join(" ").trim();
      if (!prompt) throw new Error('usage: stereoframe gen "<prompt>"');
      await genModel({
        prompt,
        projectDir: typeof options.get("dir") === "string" ? (options.get("dir") as string) : ".",
        out: typeof options.get("out") === "string" ? (options.get("out") as string) : undefined,
        texture: options.get("no-texture") !== true,
        polycount: options.has("polycount") ? Number(options.get("polycount")) : undefined,
        key: typeof options.get("key") === "string" ? (options.get("key") as string) : undefined,
      });
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
