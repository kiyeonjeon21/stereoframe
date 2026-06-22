# stereoframe

[![stereoframe on npm](https://img.shields.io/npm/v/stereoframe?label=stereoframe&logo=npm)](https://www.npmjs.com/package/stereoframe) [![stereoframe-runtime on npm](https://img.shields.io/npm/v/stereoframe-runtime?label=stereoframe-runtime&logo=npm)](https://www.npmjs.com/package/stereoframe-runtime) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Declarative `<sf-*>` HTML markup → inspectable GLB evidence and seekable MP4 renders, built on three.js.

![stereoframe showcase — six example renders](docs/media/showcase.png)

## What it is

stereoframe has two connected jobs. First, it evaluates GLB assets: inspect geometry, score quality metrics, and compare candidate models under the same deterministic lighting and camera rig. Second, it authors 3D video: describe a scene, camera, motion, and post-processing in plain HTML; render it frame-by-frame to MP4 from the CLI.

The contract that connects them is **seekability** — every frame is a pure function of `t` (seconds). There is no wall-clock, no accumulated state across frames, no `requestAnimationFrame` loop in the renderer. The CLI drives `window.__stereoframe.seek(t)` in headless Chrome and pipes screenshots into ffmpeg. Because the frame at any `t` is always the same, lint and validate checks are machine-reliable, renders are reproducible, and multi-shot films with crossfades compose cleanly.

## Packages

Two npm packages, versioned lock-step:

- **`stereoframe`** — the `stereoframe` CLI (bin: `stereoframe`). Puppeteer + ffmpeg.
- **`stereoframe-runtime`** — `dist/stereoframe.js`: three.js r184 bundled with the `<sf-*>` custom elements and the seek protocol. Load it in any HTML file as a module script.

## Prerequisites

- Node ≥ 20
- ffmpeg on PATH
- [bun](https://bun.sh) (for building from source)

## Quick start

**From npm** — evaluate a GLB and render a comparison:

```bash
npx stereoframe evaluate meshy.glb rodin.glb --frames --render
# → quality reports, comparison frames, renders/evaluation.mp4, REPORT.md
```

**Scaffold a new composition and render it:**

```bash
npx stereoframe init my-video
cd my-video
npx stereoframe lint && npx stereoframe validate
npx stereoframe render   # → renders/render_<ts>.mp4
npx stereoframe preview  # looping playback in the browser
```

**Build from source:**

```bash
bun install
bun run build   # builds runtime bundle + CLI
bun test        # pure unit tests, no GPU required
node packages/cli/dist/cli.js init my-video
```

## A minimal composition

This is `examples/hello-standalone/index.html` — a 5-second scene with a mesh, three verbs, and a text fade:

```html
<sf-scene duration="5" width="1920" height="1080" background="#101225">
  <sf-camera fov="38" position="0 0.8 6" look-at="0 0 0"></sf-camera>
  <sf-light preset="soft"></sf-light>

  <sf-mesh id="hero" geometry="icosahedron" args="1.4 2" color="#7dd3fc"
           metalness="0.4" roughness="0.25"></sf-mesh>

  <sf-animate target="#hero" verb="bounce-in" start="0.3" duration="0.8"></sf-animate>
  <sf-animate target="#hero" verb="turntable" rpm="10"></sf-animate>
  <sf-animate target="#hero" verb="float" amplitude="0.12" period="3"></sf-animate>
  <sf-animate target="#title" verb="fade-in" start="1.2" duration="0.8" rise="30"></sf-animate>
</sf-scene>

<div id="title" class="clip" data-start="1.2">hello stereoframe</div>

<script type="module">
  import "./assets/stereoframe.js";
</script>
```

A GLB composition adds `<sf-model src="...">` and an `environment` HDRI to `<sf-scene>`. Multiple `<sf-scene>` elements on one page become time-windowed shots that crossfade or cut. See `examples/product-teardown/` for a hand-directed multi-shot film and `examples/multi-shot/` for a three-shot crossfade trailer.

## How it fits together

```
<sf-*> markup
      │
      ▼
stereoframe-runtime (dist/stereoframe.js)
  three.js r184 + custom elements + seek protocol
  window.__stereoframe = { ready, seek, duration, width, height }
      │
      ▼ (CLI drives headless Chrome)
stereoframe CLI (Puppeteer + ffmpeg)
  lint → validate → render → MP4
```

- `lint` — static checks: markup structure, asset paths, time-purity rules.
- `validate` — headless probes: framing, black frames, seek idempotency (the determinism contract, machine-checked).
- `render` — waits for `__stereoframe.ready`, then loops `seek(frame/fps)` → CDP screenshot → ffmpeg pipe.

The CLI also runs `stage` and `inspect` as **composition authors**: they read a GLB and emit the same `<sf-*>` HTML you could write by hand, so the output is always editable.

## CLI commands

| Command | What it does |
|---|---|
| `init` | Scaffold a new composition directory |
| `evaluate` | Inspect one or more GLBs → quality reports, scores, optional comparison render |
| `evaluate --audit` | Deep single-GLB audit: animated report, per-part evidence, teardown for separable meshes |
| `stage` | Auto-frame a GLB with a preset (reveal, hero-orbit, turntable, spec, teardown, cinematic) |
| `inspect` | Segment a GLB into named/tagged parts for targeting by `#id` |
| `gen` | Generate a candidate GLB via Meshy (default) or fal.ai (`--provider fal`) |
| `lint` | Static checks — exits 1 on error |
| `validate` | Headless probes including seek idempotency — exits 1 on error |
| `render` | Headless render → MP4 |
| `preview` | Open the composition in the browser for looping playback |
| `add` / `update` | Add or update the runtime asset in a project directory |
| `schema` | Print the machine-readable spec (elements, verbs, eases, presets) as JSON |

`stereoframe schema` is the agent-facing entry point: it outputs the full `<sf-*>` vocabulary sourced from code, so it never drifts from the implementation. Results are `{ok:true, command, outputs, …}` on success and `{ok:false, error:{code, message, hint}}` on failure. Progress goes to stderr; stdout stays parseable.

## Authoring vocabulary

Verbs available to `<sf-animate>`: `turntable`, `orbit`, `dolly`, `move`, `follow`, `camera-path`, `path`, `morph`, `deform`, `crossfade-clip`, `bounce-in`, `fade-in`, `float`, `sway`, `explode`, `isolate`, `variant`.

Material options: physical/glass materials (transmission, emissive, rounded-box) and matcaps (pearl, chrome, iridescent, clay, holo).

Generative elements: `<sf-shader>` (GLSL fullscreen or mesh, auto-wired `uTime`), `<sf-scatter>` (seeded instanced fields), `<sf-particles>` (fountain/snow/dust — stateless, computed in-shader as a closed-form function of seed and `t`), `<sf-sky>`, `<sf-ocean>`, `<sf-swarm>`, `<sf-metaball>`.

Post-processing (all deterministic): supersampling AA (`samples`), bloom, vignette, chromatic aberration, film grain (seeded by `t`), depth of field, color grade (`contrast`/`saturation`), 3D LUT.

Custom shaders via the escape hatch: `<script type="stereoframe">` receives `sf` with the full `sf.THREE` namespace; add objects to `sf.scene` and drive uniforms from `sf.onSeek(t)`.

The full attribute reference is in [docs/format.md](docs/format.md). Run `stereoframe schema` for the machine-readable version.

## Repository layout

```
packages/runtime/            stereoframe-runtime → dist/stereoframe.js
packages/cli/                stereoframe CLI → dist/cli.js
examples/
  hello-standalone/          scaffolded starter, no external deps
  character-run-standalone/  Fox GLB run cycle + follow cam + particles
  ocean-flythrough/          sf-sky + sf-ocean + camera-path flight
  glass-hero/                transmission glass panels
  shader-flow/               GLSL flow field via <sf-shader>
  type-poster/               editorial poster: type occluded by a matcap form
  product-teardown/          5-shot film: hero → teardown → per-part spotlights
  storyboard-camera/         JSON shot list → 4-beat cinematic
  multi-shot/                16s three-shot trailer with crossfades
  baked-flock/               forward boids sim baked and replayed seekably
  forward-trails/            mode="forward" accumulating motion trail
  … (more in examples/)
docs/format.md               markup specification
docs/prompting.md            natural-language directing guide
```

## Development notes

Run `bun test` before committing. For compositions, `stereoframe lint` and `stereoframe validate` both exit 1 on error — run them before `render`. The test suite is pure unit tests with no GPU dependency.

Both packages are versioned lock-step. `bun run release [patch|minor|major]` runs the full check suite, bumps both packages, commits, tags, and pushes. CI re-checks the tagged commit and publishes. See [VERSIONING.md](VERSIONING.md) for the bump policy.

Agent contributors: read [AGENTS.md](AGENTS.md) first.

## License

MIT.

Example assets: [Water Bottle](https://github.com/KhronosGroup/glTF-Sample-Models/tree/main/2.0/WaterBottle) (CC0), [Fox](https://github.com/KhronosGroup/glTF-Sample-Models/tree/main/2.0/Fox) by PixelMannen (model, CC0) & @tomkranis (rigging/animation, CC BY 4.0), [Anisotropy Barn Lamp](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AnisotropyBarnLamp) by Eric Chadwick (© 2023 Wayfair, LLC, CC BY 4.0), HDRIs from [Poly Haven](https://polyhaven.com) (CC0), water normal map from [three.js](https://github.com/mrdoob/three.js) (MIT).
