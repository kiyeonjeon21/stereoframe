# stereoframe

[![stereoframe on npm](https://img.shields.io/npm/v/stereoframe?label=stereoframe&logo=npm)](https://www.npmjs.com/package/stereoframe) [![stereoframe-runtime on npm](https://img.shields.io/npm/v/stereoframe-runtime?label=stereoframe-runtime&logo=npm)](https://www.npmjs.com/package/stereoframe-runtime) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**CI for generated 3D assets — inspect, score, compare, and render GLBs as reproducible evidence.**

![stereoframe showcase — six example renders](docs/media/showcase.png)

```bash
npx stereoframe evaluate meshy.glb rodin.glb tripo.glb --frames --render
# → quality reports, comparison frames, a standardized MP4, and REPORT.md
```

AI 3D generation is useful, but its output quality varies wildly. stereoframe treats generated GLBs as **candidate assets to evaluate**, not as guaranteed finished products. It gives teams a deterministic harness to inspect geometry, flag defects, compare providers/models under the same lighting/camera rig, capture evidence frames, and render reproducible preview videos. Once an asset is accepted, the same runtime can stage it into spec sheets, teardown explainers, or custom 3D video.

Underneath is a declarative, agent-friendly three.js video runtime. Describe a scene, camera, lighting, and motion in plain HTML custom elements; render it frame-perfectly to MP4 with the bundled CLI. The contract is seekability: every frame is a pure function of `t`, so agents and CI can lint, validate, capture, and render without guessing.

```bash
npx stereoframe init my-video && cd my-video
npx stereoframe lint && npx stereoframe validate   # agent-grade verification
npx stereoframe render      # → renders/render_<ts>.mp4, seekable frame capture
npx stereoframe preview     # looping playback in the browser
```

```html
<sf-scene environment="assets/studio.hdr" background="#0b0f17">
  <sf-camera fov="33" position="0 0.35 4.4" look-at="#product"></sf-camera>
  <sf-model id="product" src="assets/helmet.glb"></sf-model>
  <sf-light preset="studio"></sf-light>
  <sf-animate target="#product" verb="turntable" rpm="5"></sf-animate>
  <sf-animate target="camera" verb="orbit" around="#product"
              from="0deg" to="35deg" duration="8" ease="sine.inOut"></sf-animate>
</sf-scene>
```

## Evaluate candidate GLBs

Use `evaluate` when you have one or more GLBs from Meshy, Tripo, Rodin, Hunyuan, a DCC export, or a production asset library and need comparable evidence:

```bash
stereoframe evaluate candidate-a.glb candidate-b.glb \
  --dir iphone-eval \
  --title "iPhone provider comparison" \
  --frames 0,2,4,6 \
  --render --draft
```

The output directory contains:

- `index.html` — a standardized side-by-side comparison scene.
- `reports/summary.json` — machine-readable scores, metrics, warnings, and paths.
- `reports/*.quality.json` — per-asset bounds/aspect/triangle/single-mesh/off-origin reports.
- `REPORT.md` — a human-readable comparison table.
- `frames/` and `renders/evaluation.mp4` when requested.

Scores are evidence, not taste. A low score does not mean the asset is unusable, and a high score does not guarantee art direction quality. The point is to make generated/provided GLBs inspectable and comparable before investing in polish.

## Labs: generate candidate assets

Need a model you don't have? `stereoframe gen` can create candidate GLBs via Meshy or fal.ai. Treat this as an input source for evaluation, not the main product promise:

```bash
stereoframe gen "a low-poly treasure chest"   # → assets/a-low-poly-treasure-chest.glb
# then: <sf-model src="assets/a-low-poly-treasure-chest.glb"></sf-model>
```

**Image-first (more art-directable).** Text-to-3D is a lottery — pin the design in a 2D image first, then lift it to 3D for better fidelity and reliable orientation:

```bash
stereoframe gen --image front.png                  # image-to-3D from one image
stereoframe gen --images front.png,side.png,back.png  # multi-image-to-3D (1-4 views)
stereoframe gen "a matte-black headphone" --via-image # text → image (OpenAI) → 3D, one command
```

`--via-image` generates a clean reference image (OpenAI `gpt-image-2` by default; override with `--image-model`, `--image-quality`, `--image-format`, `--image-compression`, `--size`) and saves it next to the GLB. Each generation also writes a `<name>.gen.json` provenance sidecar (prompt/source images, options, sanitized request payloads, task ids) — generation isn't reproducible, so keep the recipe. Add `--dry-run --json` before spending provider credits, and evaluate the result with `stereoframe evaluate` or `--quality-report`.

It runs with no setup using Meshy's free test mode (returns a sample model); set `MESHY_API_KEY` (shell env or project `.env`) for real prompt-driven generations.

**Premium / alternative engines via fal.ai.** `--provider fal` routes the same `gen` flows (text-to-3D, image-to-3D, `--via-image`) through any [fal.ai](https://fal.ai/models?categories=3d) 3D model instead of Meshy — Tripo v2.5 (the default), Hyper3D/Rodin, Hunyuan3D, Trellis, and more. Set `FAL_KEY` and pick the model with `--fal-model`:

```bash
stereoframe gen "a candy-red hypercar" --provider fal                       # Tripo v2.5 text-to-3D (default)
stereoframe gen --image car.png --provider fal --fal-model fal-ai/hyper3d/rodin
stereoframe gen "a ribbed ceramic vase" --provider fal \
  --fal-model fal-ai/hunyuan-3d/v3.1 --input '{"guidance_scale":7.5}'        # --input passes model-specific fields
```

## Stage accepted assets

After a GLB passes evaluation, use `stage`, `spec`, `teardown`, or a custom storyboard to turn it into a deterministic preview, explainer, or film:

```bash
stereoframe stage accepted.glb --preset spec --title "Product"
cd accepted-spec && stereoframe render
```

`spec` and `teardown` inspect the GLB and place tracked callouts on real parts when the asset is separable. Single welded AI meshes still render, but they will not explode or support per-part labels in a meaningful way.

## Direct a film — in natural language, or a JSON shot list

For accepted assets that need a richer story, `brief` sends your paragraph to an LLM that writes a model-aware `plan.json`, validates + critiques/repairs it, then compiles and renders it:

**One command, end to end** exists for experiments, but it is intentionally a Labs path: generated 3D should still be inspected before you trust it.

```bash
stereoframe brief "a dark luxury reveal ending on the wordmark CHRONO, amber/steel, ~16s" \
  --gen "a luxury chronograph wristwatch, steel case, blue dial" --via-image --render
# prompt → image (gpt-image-2) → generated GLB → directed plan (LLM) → MP4
```

Under the hood it's a **storyboard plan** — a JSON shot list (camera / lighting /
grade / backdrop / atmosphere / secondary-motion / crossfade per beat) that compiles
into a multi-shot film with the timeline computed so crossfades never gap. Write it
yourself (or have any LLM write it) and compile directly:

```bash
stereoframe storyboard plan.json --render   # → a directed multi-shot film, timeline computed for you
```

```jsonc
// cold-open → ignition → hero, each with its own camera/lighting/grade
{ "title": "stereoframe cinematic", "model": "lamp.glb",
  "shots": [
    { "name": "cold open", "duration": 2.4, "camera": { "type": "push-in", "position": "3.6 0.5 3.5", "lookAt": "0 0.9 0", "distance": 0.45 } },
    { "name": "ignition",  "duration": 2.9, "transition": "crossfade", "camera": { "type": "orbit", "radius": 5, "from": 50, "to": 6, "height": 0.5 } },
    { "name": "hero",      "duration": 3.0, "transition": "crossfade", "camera": { "type": "hero", "from": 8, "to": -12 }, "text": { "title": "stereoframe", "subtitle": "directed, not generated" } }
  ] }
```

Camera types (`static`/`orbit`/`dolly`/`push-in`/`pull-back`/`path`/`hero`), 3-point or `"auto"` lighting, per-shot grade/`spin`/`isolate`/`explode`/`callout`/`text` — full schema in [docs/format.md](docs/format.md). See `examples/storyboard-camera/plan.json` (recreates a 4-beat cinematic from one GLB).

## How it works

- **Evaluation compiles to evidence.** `evaluate` inspects every GLB, writes quality reports, builds a standardized comparison composition, and optionally captures frames/renders. Poor generated assets stay useful because their defects become comparable data.
- **Directing compiles to markup.** `stage`, `storyboard`, `spec`/`teardown`, and `inspect` are *authors*, not a separate runtime: they emit the same deterministic `<sf-*>` HTML you could hand-write. `inspect` segments a GLB into named/tagged parts; `stage` auto-frames + finishes one; `storyboard` turns a JSON shot list into a multi-shot film with the timeline computed. The output is always editable markup — nothing is locked in a black box.
- **Seek-driven rendering.** The CLI drives the runtime's protocol (`window.__stereoframe.seek(t)`, `t = frame / fps`) in headless Chrome and screenshots each frame into ffmpeg. Every frame is a pure function of `t`: verb writers → `AnimationMixer.setTime(t)` → `camera.lookAt` → `renderer.render`. No wall clock, no `requestAnimationFrame`, no accumulated state.
- **Preload gate.** `__stereoframe.ready` only flips true after every GLB/HDRI is loaded and shaders are compiled — the renderer waits for it, so first frames are never half-loaded.
- **Semantic verbs.** `turntable`, `orbit`, `dolly`, `move`, `follow`, `camera-path`, `path`, `morph`, `deform`, `crossfade-clip`, `bounce-in`, `fade-in`, `float`, `sway`, `explode`, `isolate`, `variant` with GSAP-compatible easing names compile to pure analytic writers — idempotent, random-access seekable, unit-tested without a GPU.
- **Stateless particles.** `<sf-particles>` (fountain/snow/dust) computes every particle position in-shader as a closed-form function of seeded attributes and `t` — no simulation steps, bit-identical for a given seed.

- **Custom shaders via the escape hatch.** `<script type="stereoframe">` receives `sf` with the full `sf.THREE` namespace — write custom geometry/materials/GLSL (iridescent, marble, vertex-displaced morphs) that the markup can't express, add them to `sf.scene`, and drive uniforms from `sf.onSeek(t)`. Still deterministic and post-processed.
- **HyperFrames embed mode.** A composition with a `[data-composition-id]` root automatically behaves as a HyperFrames adapter instead (listens to `hf-seek`, gates `window.__hf` readiness) — use it when you want HyperFrames' 2D blocks, audio, and studio around your 3D scene.

## Repository layout

```
packages/runtime/    stereoframe-runtime → dist/stereoframe.js (three.js r184 bundled)
packages/cli/        stereoframe → `stereoframe` bin (evaluate/stage/brief/storyboard/inspect/segment/init/gen/lint/validate/render/frame/bake/preview/add/update/schema)
examples/
  hello-standalone/        CLI-scaffolded starter (no HyperFrames)
  character-run-standalone/ Fox run cycle + follow cam + particles, own pipeline
  ocean-flythrough/        sf-sky + sf-ocean + camera-path golden-hour flight
  glass-hero/              transmission glass panels ("Designed in glass")
  shader-flow/             generative flow field authored with <sf-shader> (GLSL)
  type-poster/             editorial motion poster: bold type occluded by an iridescent matcap form
  forward-trails/          mode="forward" — an accumulating motion trail (live state)
  baked-flock/             a baked forward boids sim replayed seekably via <sf-baked>
  storyboard-camera/       JSON shot list → 4-beat cinematic (the `storyboard` compiler)
  product-teardown/        hand-directed 5-shot film: hero → teardown → per-part spotlights (inspect + isolate + callouts)
  paper-swarm/             sf-swarm typography choreography
  multi-shot/              16s three-shot trailer (swarm → glass → ocean, crossfades)
  variant-demo/            colorway switching with the variant verb
  metaball/                gooey blobs occluding typography (sf-metaball)
  hello-cube/              HyperFrames embed: raw three.js + hf-seek
  product-turntable/       HyperFrames embed: GLB + HDRI + verbs
  verbs-demo/              HyperFrames embed: six-verb rehearsal
  character-run/           HyperFrames embed: character demo
skills/stereoframe/  agent authoring guide (SKILL.md)
docs/format.md       markup specification
docs/prompting.md    how to request videos in natural language
docs/research/       foundation research (ecosystem, determinism, AI formats)
```

## Quick start (from this repo)

```bash
bun install && bun run build
node packages/cli/dist/cli.js init my-video
cd my-video && node ../packages/cli/dist/cli.js render
```

Requires Node ≥ 20, ffmpeg, and [bun](https://bun.sh) (for building).

## Status

**v0 (Tier 3b+).** Determinism is scoped to seekability: every frame is a pure function of `t` within a render, which leaves the visuals free.

**Evaluate generated and production GLBs**
- `evaluate` — one or more GLBs → per-asset quality reports, heuristic scores, standardized comparison scene, optional frames, optional MP4, and `REPORT.md`.
- Quality reports — bounds/aspect/flatness/triangle count/single-mesh/off-origin warnings so generated assets can fail visibly instead of being hidden by polish.
- Provider comparison workflow — use `gen --provider ... --quality-report` to create candidates, then `evaluate` to compare them under the same deterministic rig.

**Direct any GLB**
- `brief` — natural-language directing: a paragraph → a model-aware, cinematic `plan.json` via an LLM (the directing twin of the `gen` prompt), validated + creatively critiqued/repaired, then compiled + rendered.
- `storyboard` compiler — a JSON shot list (camera / lighting / grade / backdrop / atmosphere / secondary-motion / crossfade per beat) → a multi-shot film, timeline computed so crossfades never gap.
- `stage` auto-director — auto-framing + presets: reveal, hero-orbit, turntable, exploded-view, **spec** (annotated asset preview), **teardown** (per-part exploded breakdown), **cinematic** (multi-shot reveal/macro/hero preview).
- `inspect` segment + tag pipeline — reads a GLB's parts (name, material character, position, size) so they can be targeted by name.
- `sf-callout` tracked spec labels — leader lines that follow a 3D part as the camera moves; auto-placed by `spec`/`teardown`.
- Product-film finish — contact-shadow grounding, environment light-sweep, feature-isolate spotlight.
- Compressed-GLB support (Draco / KTX2 / Meshopt) — real downloaded/generated models just load.

**Authoring (declarative 3D-video framework)**
- Plain-HTML scenes; GLB/HDRI preload gate; multi-shot compositions (each `sf-scene` is a shot — cut/crossfade, shot-local time).
- Seventeen analytic verbs — turntable, orbit, dolly, move, follow, camera-path, **path**, **morph**, **deform**, crossfade-clip, bounce-in, fade-in, float, sway, explode, isolate, variant — with GSAP-compatible easing.
- Materials — glass/physical (transmission, rounded-box, emissive) and matcaps (pearl/chrome/iridescent/clay/holo).
- Generative & instancing blocks — **`sf-shader`** (author GLSL directly: fullscreen/mesh, auto-wired uTime + noise toolkit), **`sf-scatter`** (seeded instanced fields), stateless GPU particles (fountain/snow/dust), `sf-sky`/`sf-ocean`/`sf-swarm`/`sf-metaball`.
- Post-processing — supersampling AA, `environment="room"` reflections, bloom, vignette, film grain, chromatic aberration, color grade (all deterministic).
- Custom shaders via the `sf.THREE` escape hatch; DOM title overlays.

**Live simulation, kept seekable**
- **`mode="forward"`** — opt a scene out of seek-idempotency for genuine live/stateful sim (cloth, fluid, accumulating trails, flocking); writers get a `dt`. Cost: capture-only, no random-access seek.
- **`stereoframe bake` + `<sf-baked>`** — freeze a forward sim into a per-frame cache and replay it as a pure function of `t`, so it's fully seekable again and drops into multi-shot. (forward-trails → baked-flock.)

**Pipeline & verification**
- CLI — evaluate / init / gen / inspect / lint / validate / render / frame / preview / add / update / schema (Puppeteer + ffmpeg).
- Text/image-to-3D — `stereoframe gen` → textured GLB via Meshy (default, free test mode) **or any fal.ai 3D model** (`--provider fal`: Tripo, Hyper3D/Rodin, Hunyuan3D, Trellis…), incl. `--via-image` (text → reference image → 3D).
- `lint` — markup / asset / time-purity static checks. `validate` — headless probes for lighting, framing, static screen-space motion, black frames, and seek idempotency (the determinism contract, machine-checked).

HyperFrames embed mode retained. **Roadmap:** depth of field + motion blur, audio mux, alpha output, Docker bit-parity CI.

## Releasing

`stereoframe` (CLI) and `stereoframe-runtime` are versioned lock-step; `bun run release` (patch by default) bumps both, publishes, and tags. See [VERSIONING.md](VERSIONING.md) for the bump policy.

## License

MIT.

Example assets: [Water Bottle](https://github.com/KhronosGroup/glTF-Sample-Models/tree/main/2.0/WaterBottle) (CC0), [Fox](https://github.com/KhronosGroup/glTF-Sample-Models/tree/main/2.0/Fox) by PixelMannen (model, CC0) & @tomkranis (rigging/animation, CC BY 4.0), [Anisotropy Barn Lamp](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AnisotropyBarnLamp) by Eric Chadwick (© 2023 Wayfair, LLC, CC BY 4.0), HDRIs from [Poly Haven](https://polyhaven.com) (CC0), water normal map from [three.js](https://github.com/mrdoob/three.js) (MIT).
