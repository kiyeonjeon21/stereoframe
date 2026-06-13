---
name: stereoframe
description: Declarative, deterministic 3D video on three.js. Use when creating product turntables, character shots, camera-move videos, or any 3D scene rendered to MP4 — author sf-scene/sf-model/sf-animate markup and render with the stereoframe CLI.
---

# Stereoframe

Stereoframe turns HTML markup into deterministic 3D video. You describe a three.js scene, camera, lights, and motion with custom elements; the runtime renders every frame as a pure function of seek time; the CLI captures frames in headless Chrome and encodes MP4 via ffmpeg. Same input → bit-identical output.

## Choosing your path

Pick the lightest path that fits the request, then refine:

1. **Have a GLB, want a polished video fast?** → `stage <model>.glb --preset <name>` auto-frames + finishes any model (presets below). Then hand-edit the generated `index.html` to taste. **This is the default for "make a product video / Apple-ad reveal."**
2. **Want the parts labelled (spec sheet / teardown)?** → `inspect` the GLB first to learn its parts, then `stage --preset spec` (annotated, still model) or `--preset teardown` (exploded, per-part labels). Multi-part GLBs only.
3. **No model yet?** → `stereoframe gen "<prompt>"` writes a textured GLB into `assets/` (real prompt-driven generation when `MESHY_API_KEY` is set — otherwise a sample model). For the whole thing in one command, `gen "<prompt>" --stage <preset> --render` → prompt → model → directed film → mp4.
4. **Custom scene / full control?** → hand-author `sf-scene` markup (canonical composition below).

Whatever the path, **always `lint` → `validate` before `render`.**

## The fast path: auto-direct any GLB

stereoframe's core job is **directing** a model, not making it. To turn any GLB into a polished cinematic motion graphic with zero hand-tuning:

```bash
stereoframe stage product.glb --preset reveal --title "Product Name"
cd product-reveal && stereoframe render
```

Presets: `reveal` (dramatic dark spiral-in + rim light), `hero-orbit` (clean studio orbit), `turntable` (product on a pedestal), `exploded-view` (parts separate outward — only for multi-component models with separate part meshes; single-mesh/rigged models won't separate), `spec` (auto-annotated product film). The model is auto-framed (`<sf-model fit="2.6">` normalizes its size/center), so the preset's camera move + lighting rig + timing + film finish frame ANY model correctly — no per-model camera/scale tweaking. Then hand-edit the generated `index.html` to taste.

**`spec` is the fully-automatic annotated film**: `stage` runs `inspect` on the GLB, then writes a grounded, still-model, slow-arc scene with named spec callouts drawn onto its top parts (by triangle count), labeled by name + material character, fanned so they don't overlap, staggered through the back half. One command (`stereoframe stage product.glb --preset spec`) → an annotated product film. Multi-part GLBs only (it warns and renders un-annotated for single-mesh models). The model is kept still (not spun) so the tracked labels stay readable.

**`teardown` is `spec` for an exploded view**: same auto-inspect → callouts, but the parts fly apart from the model center and a labelled callout tracks each one as it separates (an iFixit-style exploded breakdown). Best on models whose components are genuinely separate meshes that sit apart — parts that are physically nested (e.g. a windshield welded into a car body) won't separate and their labels will crowd. The model doesn't spin (labels stay readable); the explode `distance` is fit-invariant.

When a user gives you a model (or you `gen` one) and wants "an Apple-ad-style reveal / a product video", reach for `stage` first.

**Inspect before you direct.** `stereoframe inspect product.glb` segments + tags the GLB and prints its parts — name, kind, triangle count, material character (glass/metal/fabric/emissive/matte), where each sits (top/base/left/right/front/back/core), and size rank. It also writes `product.segments.json`. The part **indices/names it reports are exactly what `isolate`/`explode`/`sf-callout` target** (they share the same `collectParts` boundary), so this is how you stop guessing: inspect, learn that part 2 is `Glass`, then author `part="Glass"` by name. It also tells you up front if a model is single-mesh (explode/isolate/per-part callouts won't separate it) or rigged. Run it first whenever you plan to isolate or callout a specific feature. `--json` emits the manifest for programmatic use. The manifest also reports a `dominant` material — `stage` uses it to **auto-adapt the lighting**: a dominantly-metal model gets a tamed exposure + cool-rim/warm-fill rig instead of the studio preset, so chrome doesn't blow out (no manual tuning needed).

## Workflow

```bash
stereoframe init my-video      # scaffold index.html + assets/stereoframe.js
cd my-video
# edit index.html (markup below)
stereoframe lint               # static checks: markup, assets, time purity
stereoframe validate           # headless run: errors, lighting, framing, seek idempotency
stereoframe render --draft     # fast iteration render → renders/*.mp4
stereoframe render             # quality render (crf 18)
stereoframe preview            # browser playback at http://127.0.0.1:<port>/?sf-preview
stereoframe gen "<prompt>"     # text-to-3D: generate a textured GLB into assets/ (Meshy)
stereoframe gen "<prompt>" --stage spec --render   # one-shot: prompt → model → directed film → mp4
stereoframe bake --target <id> # freeze a mode="forward" sim's InstancedMesh into a seekable cache for <sf-baked>
stereoframe add ocean          # install a block's assets + print its markup
stereoframe blocks             # list available blocks
stereoframe update             # refresh assets/stereoframe.js after upgrading
```

**ALWAYS run `lint` then `validate` after editing, before rendering.** Both support `--json` and exit 1 on errors. They catch: missing/remote assets, unknown verbs/elements/eases, wall-clock or RNG in scripts, targets that don't exist, crossfade gaps, unlit scenes, everything-offscreen framing, near-black frames, and non-idempotent seeking (the determinism contract). Fix all errors and investigate warnings before `render`.

Non-interactive, plain-text output, exit code 1 on failure — safe to run in agent loops. Requires ffmpeg on PATH.

## Canonical composition

```html
<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      sf-scene { position: absolute; inset: 0; }
      #title { position: absolute; bottom: 100px; width: 100%; text-align: center;
               font-size: 64px; color: #fff; font-family: sans-serif; }
    </style>
  </head>
  <body>
    <sf-scene duration="8" width="1920" height="1080" background="#0b0f17"
              environment="assets/studio.hdr">
      <sf-camera fov="33" position="0 0.35 4.4" look-at="#product"></sf-camera>
      <sf-model id="product" src="assets/helmet.glb"></sf-model>
      <sf-light preset="studio"></sf-light>
      <sf-animate target="#product" verb="turntable" rpm="5"></sf-animate>
      <sf-animate target="camera" verb="orbit" around="#product"
                  from="0deg" to="35deg" duration="8" ease="sine.inOut"></sf-animate>
      <sf-animate target="#title" verb="fade-in" start="1" duration="0.8" rise="30"></sf-animate>
    </sf-scene>

    <div id="title" class="clip" data-start="1">Product Name</div>

    <script type="module">
      import "./assets/stereoframe.js";
    </script>
  </body>
</html>
```

- `<sf-scene duration="8">` defines the video length in seconds — required.
- HTML overlays: give them `class="clip"` + `data-start`/`data-duration` (seconds) for visibility windows; animate entrances with `fade-in`/`bounce-in` verbs targeting their `#id`.
- All `<sf-animate>` elements live INSIDE `<sf-scene>`, even when targeting DOM elements.

## Vocabulary

Elements: `sf-scene` (duration, width/height, background, environment HDRI, exposure) · `sf-camera` (fov, far, position, look-at, look-at-offset) · `sf-model` (GLB; `clip="Name"` picks the initial animation clip) · `sf-mesh` (box/sphere/plane/cylinder/torus/icosahedron/rounded-box; `material="glass"` for transmission panels; emissive/env-map-intensity knobs) · `sf-light` (preset studio/soft/sunset, or single light — multiple allowed) · `sf-particles` (preset fountain/snow/dust, count, seed, color, area) · `sf-sky` (atmosphere dome) · `sf-ocean` (animated water, needs `stereoframe add ocean`) · `sf-swarm` (paper scraps gathering into typography: text with `|` line breaks, count, seed, palette, stagger) · `sf-shader` (author a fragment shader directly — `fullscreen` for a generative background, or geometry-bound; auto-wires uTime/uResolution/vUv + a noise toolkit) · `sf-animate`.

Verbs (`start`/`duration` in seconds, `ease` = GSAP-compatible names like `power2.inOut`, `back.out`, `sine.inOut`):

| verb | params | use for |
|---|---|---|
| `turntable` | rpm, axis | product spins (continuous) |
| `orbit` | around, radius, from/to (deg), height | camera arcs around a subject |
| `dolly` | toward, distance | push-in / pull-back |
| `move` | to (required), from | straight-line travel |
| `follow` | subject, offset | camera tracking a moving subject (continuous) |
| `crossfade-clip` | from/to (clip names) | character clip transitions (idle → run) |
| `bounce-in` | (ease defaults back.out) | scale-in entrance (3D or DOM) |
| `fade-in` | rise (px, DOM only) | opacity entrance (3D materials or DOM) |
| `float` | amplitude, period | gentle hover (continuous) |
| `camera-path` | points ("x y z, x y z, …"), look (ahead\|none) | spline flythroughs/walkthroughs |
| `path` | points, orient (none\|ahead), closed | move an OBJECT along a Catmull-Rom path (object cousin of camera-path) |
| `morph` | index, to, from | animate a GLB morph-target influence (needs morph targets) |
| `deform` | amount, frequency, speed | continuous organic vertex ripple/undulation (sin-free GPU noise, MeshStandardMaterial) |
| `variant` | color/roughness/metalness, material (name filter) | colorway switches (configurators); chain multiple at different starts |

Blocks:
- `sf-metaball` (count, seed, resolution, scale, speed + sf-mesh material attrs) — gooey blobs. Omit the scene `background` and place DOM typography BEFORE the sf-scene to get text occluded by the blobs (see examples/metaball).
- `sf-scatter` (geometry/args + material, count, seed, area, distribution box\|sphere, scale-min/max, spin, float, palette) — a seeded field of instanced objects (forest/debris/grid) with per-instance spin+float; deterministic.
- `sf-baked` (src=.bake.json + geometry/args + material) — replay a baked simulation as a pure function of t (seekable again). Author a `mode="forward"` sim, `stereoframe bake --target <id>`, then `<sf-baked>`. See examples/baked-flock.

## Ocean flythrough recipe

```html
<sf-scene duration="10" exposure="0.55">
  <sf-camera fov="45" far="5000" position="-30 6 40"></sf-camera><!-- no look-at -->
  <sf-sky elevation="6" azimuth="195" turbidity="8"></sf-sky>
  <sf-ocean size="4000" color="#06222e"></sf-ocean>
  <sf-light type="hemisphere" color="#ffd9b3" intensity="1.2"></sf-light>
  <sf-animate target="camera" verb="camera-path" look="ahead"
              points="-30 6 40, -14 4 18, 2 2.5 2, 6 2 -8, 4 3 -22"
              duration="10" ease="power1.inOut"></sf-animate>
</sf-scene>
```

With `look="ahead"`, OMIT `look-at` on sf-camera (it would override the path's aim). The sf-sky sun automatically drives sf-ocean highlights; low elevation (2–15°) gives golden hour. Meshes still need `sf-light` — sky/ocean don't light objects.

## Glass panel recipe

```html
<sf-scene duration="9" background="#0a0a0c" environment="assets/studio.hdr" exposure="0.85">
  <!-- glass refracts what's BEHIND it: give it a glow backdrop, not pure black -->
  <sf-mesh geometry="plane" args="60 34" color="#05070d" emissive="#101b33"
           emissive-intensity="1.4" position="0 0 -7"></sf-mesh>
  <sf-mesh geometry="sphere" args="1.4" emissive="#6d48f5" emissive-intensity="2.6"
           position="5.8 2 -3.4"></sf-mesh>
  <sf-mesh geometry="rounded-box" args="4.4 2.9 0.22 0.12" material="glass"
           color="#8493a8" roughness="0.16" thickness="0.5" env-map-intensity="1.8"
           position="1.6 0.5 0" rotation="6 -18 4"></sf-mesh>
</sf-scene>
```

## Typography swarm recipe

```html
<sf-swarm text="EVERYTHING FALLS|INTO PLACE" font="900 150px Helvetica, sans-serif"
          count="2400" seed="7" size="0.14" width="13"
          palette="#1c1917,#44403c,#a8a29e,#dc2626,#f5f5f4"
          scatter="26 14 18" start="0.6" duration="4"
          stagger="0.55" ease="power3.inOut"></sf-swarm>
```

Light backgrounds read best; pair with a slow camera `dolly`. Same seed → identical scrap layout every render.

## Character shot recipe

```html
<sf-model id="char" src="assets/fox.glb" clip="Survey"
          position="-6 0 0" rotation="0 90 0" scale="0.02"></sf-model>
<sf-animate target="#char" verb="crossfade-clip" from="Survey" to="Run"
            start="1.2" duration="0.6"></sf-animate>
<sf-animate target="#char" verb="move" to="6 0 0" start="1.5" duration="5.5"
            ease="power1.inOut"></sf-animate>
<sf-animate target="camera" verb="follow" subject="#char" offset="0 1.6 5.5"></sf-animate>
```

Rotate the model to face its travel direction (`rotation="0 90 0"` for +X). Aim the camera at the body, not the feet: `look-at="#char" look-at-offset="0 0.7 0"`.

## Multi-shot trailer recipe

Multiple sf-scenes = shots. Verbs inside a shot use SHOT-LOCAL seconds (shot start = 0); DOM clips (`.clip[data-start]`) stay in GLOBAL seconds. Order shots in document order = time order.

```html
<!-- shot 1: 0–5.6s -->
<sf-scene start="0" duration="5.6" background="#f4f2ed"> … </sf-scene>

<!-- shot 2: fades in over shot 1 at 5s (overlap 0.6s ⇐ shot 1 covers it) -->
<sf-scene start="5" duration="5.6" transition="crossfade" transition-duration="0.8"
          background="#0a0a0c"> … </sf-scene>

<!-- shot 3: ending -->
<sf-scene start="10" duration="6" transition="crossfade" transition-duration="0.9"> … </sf-scene>

<div id="ending" class="clip" data-start="12.2">…</div><!-- global time -->
```

Total video duration = max(start + duration). For crossfades, make the previous shot's window cover `next.start + transition-duration`.

## Determinism = structure only (high creative freedom otherwise)

The contract is **seekability**: each frame a pure function of `t` within a render (so capture is coherent and frames are reproducible). That's all that's required. You do NOT need two renders to be byte-identical — use rich custom shaders (sin noise is fine), high poly, heavy materials freely. Only avoid things that break seekability: wall-clock reads, unseeded per-frame `Math.random()`, and previous-frame accumulation (trails/feedback). `validate` checks exactly this.

**Escape valve — `mode="forward"`** (for genuine live sim that can't be analytic): a `<sf-scene mode="forward">` opts out of seek-idempotency so escape-hatch code may accumulate cross-frame state. The seekFn gets a second arg `dt` (seconds since last seek; 0 on the first frame): `sf.onSeek((t, dt) => { if (dt > 0) step(dt); })`. Cost: no random-access seek/scrub — correct only under the monotonic render. Must be the sole, full-timeline scene (validate enforces). See `examples/forward-trails`. To use such a sim in a multi-shot composition, **bake** it into a seekable asset (`stereoframe bake`). Default to staying analytic/seekable; reach for forward only when a sim truly can't be a function of t.

## Rules (these break the render — they break seekability)

1. **Assets must be local** (`assets/...`) — never CDN models/HDRIs. If the user wants a model they don't have, generate one with `stereoframe gen "<prompt>"` (writes a GLB into assets/), then reference it with `<sf-model>`.
2. **Everything derives from seek time.** In `<script type="stereoframe">` escape-hatch code (`sf.onSeek((t) => ...)`, runs after assets load), no `Date.now()`, no `performance.now()`, no `Math.random()`, no state accumulated across frames. Randomness comes from `<sf-particles seed>`-style seeded attributes.
3. No previous-frame-dependent effects (trails, feedback, stepped physics) — frames must be seekable in any order.
4. Camera motion = verbs on `target="camera"`; one `sf-camera` per scene.

## Breaking the "formulaic" look

Determinism is NOT the limit on creativity — it only bans live simulation, unseeded randomness, and cross-frame accumulation. Everything below is seekable. Generic output = generic primitives + centered orbit + preset materials. To make something that looks designed, not auto-generated:
- **`<sf-shader>` — author GLSL directly (the biggest lever).** Drop a fragment shader as the element's text; you get `uTime`, `uResolution`, `vUv`, any `u-<name>` attribute as `u<Name>`, and a `hash21/hash22/vnoise/fbm` noise toolkit for free. `fullscreen` makes it a generative background canvas (flow fields, plasma, gradients); without it, the shader is bound to a `geometry`. Far less boilerplate than the `sf.THREE` escape hatch. Generative/abstract/organic looks the markup can't otherwise express — see `examples/shader-flow`. (The `sf.THREE` escape hatch is still there for custom geometry/meshes that need JS.)
- **Go non-product.** stereoframe is not only a product-shot tool: pure generative pieces (`sf-shader`), typographic/editorial motion posters (`examples/type-poster`), abstract/data pieces. Break the "object on dark studio bg, orbiting" default.
- **Art-directed composition**: off-center the subject (rule of thirds), big confident negative space, dramatic scale contrast; let a 3D form overlap/occlude large editorial typography (transparent scene `background`, DOM text BEFORE the sf-scene so the canvas occludes it — post-fx is alpha-aware, so bloom/grain/grade still work over a transparent scene).
- **A specific palette**: one bold flat background color + one accent (bright/cream backgrounds, not only "moody dark gradient"). Pair `material="matcap"` (iridescent/chrome/holo) — its dark core pops on light backgrounds. Reference real design, not the three.js default aesthetic.

## Polish — the "finish" attributes (use these for premium-looking output)

A flat, jagged, plastic look is almost always a missing-finish problem, not a content problem. On `<sf-scene>`:
- `samples="2"` — supersampling AA. On by default; the single biggest quality step. Crisp edges.
- `environment="room"` — a procedural studio environment (no asset). Gives metal/glass real reflections — turns "plastic" into "chrome". Essential whenever you use metalness or glass materials.
- `bloom="0.3"` (with `bloom-threshold="0.85"`) — soft glow on highlights. Keep it subtle; raise the threshold so only true highlights bloom. Do NOT bloom bright/light backgrounds (it washes out).
- `vignette="0.4"` — darken the edges for cinematic framing.
- `chromatic-aberration="0.4"` + `grain="0.04"` — lens/film feel (RGB edge split + seeded grain). Subtle is better.
- `contrast="1.05" saturation="1.1"` — light color grade.
- **`material="matcap" matcap="iridescent|chrome|pearl|clay|holo"`** — distinctive, designer-grade surfaces with zero lighting setup. The fastest way off the generic-preset look. Dark-core looks (iridescent) pop on LIGHT backgrounds; bright looks pop on dark. Match background contrast to the material.

**Product-film finish** (kills the "floating CG" look — the difference between a spinning GLB and a real product shot):
- **`ground="contact-shadow"`** on `<sf-scene>` + **`fit-ground`** on `<sf-model>` — a soft top-down shadow grounds the model on `y=0`. The single highest-impact fix for "it looks fake". Tune `ground-size`/`ground-opacity`/`ground-blur`/`ground-darkness`.
- **`light-sweep="0.1"`** on `<sf-scene>` — rotates the `environment` over the timeline so a specular highlight travels across metal/glass. The signature premium-product sweep. Needs `environment="room"` (or studio/HDRI).
- **`isolate` verb** (`part="<index>" dim="0.8"`) — fade every other part to black so one component is the hero. Multi-part GLB only; pair with a slow `dolly` toward it.
- **`<sf-callout>`** (`target="#m" part="2" value="48MP" text="Main camera" anchor="left" start="1.2"`) — a leader line + typographic label that tracks a 3D part as the camera moves (Apple-style spec callout). Crisp DOM type, deterministic, hidden when off-screen. The strongest "this is a designed product film, not a viewer" signal — pair it with `isolate` on the same `part` for a feature-highlight beat.

The `stage` presets already apply ground + light-sweep (and `spec`/`teardown` add the auto-callouts), so a plain `stage product.glb` gives a grounded, swept product film out of the box.

Example moody hero scene: `<sf-scene background="#070709" exposure="0.85" environment="room" samples="2" bloom="0.35" bloom-threshold="0.86" vignette="0.4">`. Metal/glass need `environment` to look right; emissive + `bloom` reads as glow/light.

## Framing heuristics

- ~2-unit-tall GLB: camera `position="0 0.35 4.4" fov="33"` gives comfortable margin.
- Pedestal: `<sf-mesh geometry="cylinder" args="1.5 1.7 0.08" position="0 -1.05 0">`.
- An HDRI `environment` is the highest-leverage look upgrade; pair with `preset="studio"`.

## HyperFrames embed mode (optional)

If the page has a HyperFrames `[data-composition-id]` root, the runtime automatically becomes a HyperFrames adapter (follows `hf-seek`, gates `window.__hf` readiness) — use `npx hyperframes render` instead, and author DOM animation with HyperFrames' GSAP timelines rather than DOM verbs.
