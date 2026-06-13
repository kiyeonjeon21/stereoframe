# Stereoframe Markup v0

A custom-element vocabulary for describing declarative 3D scenes. The runtime (`stereoframe.js`) compiles the markup into a three.js scene and renders every frame as a pure function of time `t` (seconds).

## Two host modes

**Standalone mode (default)** — the stereoframe CLI drives the runtime's own protocol:

```bash
stereoframe init my-video && cd my-video && stereoframe render
```

The runtime exposes `window.__stereoframe = { ready, duration, width, height, seek }`. The CLI renderer (Puppeteer + ffmpeg) waits for `ready === true` (every GLB/HDRI loaded, shaders compiled), then loops `seek(frame/fps)` → CDP screenshot → ffmpeg pipe to produce the mp4. The runtime also drives `.clip[data-start]` element visibility as a function of t. Add `?sf-preview` to the URL for looping browser playback.

**HyperFrames embed mode** — when the page has a `[data-composition-id]` root, the runtime switches automatically: it follows `hf-seek` events and gates `window.__hf` until assets are ready (DOMContentLoaded does NOT wait for module top-level await — measured). DOM clips/timelines belong to HyperFrames.

In both modes, load the runtime with an **inline module script**:

```html
<script type="module">
  import "./assets/stereoframe.js";
</script>
```

> In embed mode, never use `<script type="module" src="...">` — the HyperFrames
> bundler inlines relative `script[src]` as classic scripts, breaking the module context.

## Elements

### `<sf-scene>` — scene root (= shot)

**Multi-shot**: multiple sf-scenes on one page become time-windowed shots. Total video duration = max(start + duration). `sf-animate` inside a shot is written in **shot-local time** (shot start = 0s). Hidden shots skip rendering (safe — all state is a pure function of t), and canvas z-order = document order, so listing shots in time order naturally stacks crossfades on top. DOM clips (`.clip[data-start]`) stay in **global time**.

| attribute | default | description |
|---|---|---|
| `start` | 0 | shot start (global seconds). Omit for a single scene — behaves as before |
| `duration` | (required) | shot length (seconds). In embed mode, inherits the root's `data-duration` |
| `transition` | cut | `cut` \| `crossfade` — transition at the shot's head |
| `transition-duration` | 0.6 | crossfade length (seconds). The previous shot's duration must cover `start + transition-duration`, or the fade reveals the page background |
| `environment` | — | HDRI path (.hdr). PBR ambient light/reflections, PMREM-processed |
| `background` | transparent | `#hex` color, `transparent`, or `environment` (HDRI as backdrop) |
| `exposure` | 1 | tone-mapping exposure |
| `tone-mapping` | aces | `aces` or `none` |
| `width`/`height` | 1920/1080 | canvas size (embed mode: inherits the composition root's `data-width/height`) |
| `samples` | 2 | supersampling antialiasing factor (1–4). 2 = render at 4× pixels then downsample — deterministic, crisp edges. Use 1 for speed |
| `environment` | — | HDRI path (.hdr) **or** `room`/`studio` (a procedural studio environment, no asset — gives metal/glass real reflections) |
| `bloom` | 0 | highlight glow strength (e.g. 0.3–0.5); 0 disables. Don't bloom bright/light backgrounds |
| `bloom-threshold`/`bloom-radius` | 0.85 / 0.6 | bloom threshold (higher = only the brightest pixels) / spread |
| `vignette` | 0 | darken the edges (0–1, e.g. 0.4) — cinematic framing |
| `chromatic-aberration` | 0 | radial RGB split at the edges (e.g. 0.3–0.5) — lens/film feel |
| `grain` | 0 | film grain amount (e.g. 0.03–0.06); seeded by `t`, so seekable |
| `contrast`/`saturation` | 1 / 1 | light color grade (e.g. 1.05 / 1.1) |
| `ground` | — | `contact-shadow` (or `shadow`) renders a soft top-down depth shadow onto a `y`-plane — grounds the model so it stops looking like floating CG. Pair with model `fit-ground`. Tune with `ground-y` (0), `ground-size` (6), `ground-opacity` (0.75), `ground-blur` (3), `ground-darkness` (1.4) |
| `light-sweep` | 0 | rotate the environment (reflections) `light-sweep` turns over the whole timeline — a slow specular sweep travels across metal/glass, the signature "premium product film" highlight. Needs `environment` (`room`/`studio`/HDRI). Try 0.1 |

**The "finish" attributes** (`samples`, `environment="room"`, `bloom`, `vignette`) are what separate a tech-demo look from a polished one: supersampling removes jaggies, a procedural environment gives metal/glass something to reflect, bloom makes highlights glow, and a vignette frames the shot. All are deterministic. Note the earlier `environment` row (HDRI) — the same attribute now also accepts `room`/`studio`.

The canvas is auto-inserted as sf-scene's first child. Control layering with regular CSS.

### `<sf-camera>`

| attribute | default | description |
|---|---|---|
| `fov` | 35 | vertical field of view (degrees) |
| `far` | 200 | far clipping plane — raise (e.g. 5000) for sky/ocean horizons |
| `position` | `0 1 5` | `x y z` |
| `look-at` | — | `#id` (tracked every frame) or `x y z` |
| `look-at-offset` | `0 0 0` | aim-point offset for object look-at (e.g. `0 0.7 0` for a character's torso) |

### `<sf-model>` — GLB/GLTF

| attribute | description |
|---|---|
| `src` | GLB/GLTF path (local). Draco / KTX2 / Meshopt-compressed models work — Meshopt is bundled; Draco/KTX2 decoders load once from a pinned CDN during preload (before the ready gate, so render stays seekable) |
| `id` | for `#id` references |
| `position`/`rotation`/`scale` | `x y z` (rotation in degrees); scale accepts a single value |
| `clip` | initially playing clip name (default: first clip). Other clips wait at weight 0 |
| `fit` | auto-frame: normalize the model so its longest dimension = this many world units, centered at origin (e.g. `2.6`). Makes a fixed camera/lighting preset frame any model regardless of its original scale/origin |
| `fit-ground` | (with `fit`) rest the model on `y=0` instead of centering it vertically |

All clips stay in the playing state (only weights change) and are seeked with `mixer.setTime(t)` (timeScale pinned to 1). Switch clips with the `crossfade-clip` verb — weights become a pure function of t, so random-access seeking is safe.

### `<sf-particles>` — stateless analytic particles

Every particle position is computed in-shader as a closed-form function `f(seeded attributes, t)`. No simulation steps, so any seek order is safe; the same seed (mulberry32) is bit-identical on every render.

| attribute | default | description |
|---|---|---|
| `preset` | fountain | `fountain` (spray/sparks), `snow` (falling + sway), `dust` (floating motes) |
| `count` | 500 | particle count |
| `seed` | 1 | PRNG seed — change for a different arrangement |
| `color`/`size`/`opacity` | #ffffff / 0.08 / 0.9 | |
| `position` | `0 0 0` | emitter/volume center |
| `area` | `6 4 6` | snow/dust volume size |
| `speed`/`spread`/`gravity`/`life` | 3 / 25 / 4 / 2.5 | fountain only |
| `amplitude` | 0.4 | dust wander radius |

Blending: fountain/dust are additive, snow is normal.

### `<sf-mesh>` — procedural geometry

| attribute | default | description |
|---|---|---|
| `geometry` | box | `box` `sphere` `plane` `cylinder` `torus` `icosahedron` `rounded-box` (args: `w h d cornerRadius`) |
| `args` | per geometry | space-separated numbers (box: `w h d`, cylinder: `rTop rBottom h`, …) |
| `material` | standard | `standard` \| `physical` \| `glass` (transmission preset) \| `matcap` (a baked material look needing no lights — set `matcap="pearl\|chrome\|iridescent\|clay\|holo"`; distinctive designer-grade surfaces) |
| `color` | #ffffff | base color (a tint for glass) |
| `metalness`/`roughness` | 0 / 0.5 | |
| `transmission`/`thickness`/`ior`/`clearcoat`/`clearcoat-roughness`/`dispersion` | per preset | physical/glass knobs — explicit attributes override the preset |
| `emissive`/`emissive-intensity` | #000 / 1 | self-illumination (useful for glow plates behind glass) |
| `env-map-intensity` | 1 | environment reflection strength |
| `position`/`rotation`/`scale` | | transform |

Glass tip: transmission refracts what's *behind* the mesh — over pure black, glass reads as black. Put emissive glow plates/spheres behind it and enable an environment HDRI to make glass look like glass.

### `<sf-swarm>` — paper scraps → typography choreography (block)

Samples target points from text rasterized on a canvas, then gathers an InstancedMesh from seeded scatter positions with stagger. Every instance matrix is recomputed from t alone each frame — random-access safe, bit-stable per seed.

| attribute | default | description |
|---|---|---|
| `text` | STEREOFRAME | `\|` breaks lines |
| `font` | 900 140px sans-serif | canvas font string |
| `count`/`seed` | 1500 / 1 | scrap count / PRNG seed |
| `size` | 0.12 | base scrap size (world units) |
| `width` | 12 | text world width (height follows the aspect) |
| `palette` | 4 grays+red | comma-separated colors |
| `scatter` | width-based | scatter volume `x y z` |
| `start`/`duration`/`stagger`/`ease` | 0.5 / 3.5 / 0.5 / power3.inOut | choreography timing |
| `mode` | gather | `gather` (scatter→text) \| `disperse` (reverse) |
| `position` | 0 0 0 | text center |

### `<sf-light>`

Presets: `preset="studio"` (key+rim+ambient), `soft`, `sunset`.
Or a single light: `type="directional|ambient|hemisphere|point"` + `color`/`intensity`/`position`.

### `<sf-sky>` — physical atmosphere dome (block)

three.js Sky addon. Pure shader (no assets, no time dependence — deterministic by construction).

| attribute | default | description |
|---|---|---|
| `elevation`/`azimuth` | 15 / 180 | sun altitude/azimuth (degrees). 2–15° = golden hour |
| `turbidity`/`rayleigh` | 10 / 2 | atmospheric haze/scattering |
| `mie-coefficient`/`mie-directional-g` | 0.005 / 0.8 | Mie scattering |
| `scale` | 2000 | dome size — keep below `sf-camera far` |

Lower the exposure (e.g. `<sf-scene exposure="0.55">`) for a natural look. The sf-sky sun direction automatically drives sf-ocean highlights in the same scene.

### `<sf-ocean>` — water plane (block)

three.js Water addon (reflections, refraction, sun glint). Install the normal map (`assets/waternormals.jpg`) with `stereoframe add ocean`. The shader's time uniform is set to `t × speed` by the seek loop — random-access safe.

| attribute | default | description |
|---|---|---|
| `size` | 2000 | plane size — raise `sf-camera far` accordingly (e.g. 5000) |
| `color` | #001e0f | water color |
| `speed` | 1 | wave speed multiplier |
| `distortion-scale` | 3.7 | distortion strength |
| `normals` | assets/waternormals.jpg | normal map path |
| `sun-direction`/`sun-color` | 0.7 0.6 0.3 / #ffffff | overridden automatically when sf-sky is present |

### `<sf-metaball>` — marching-cubes blobs (block)

Liquid/goo blobs. Ball centers follow closed-form seeded orbits (`f(seed_i, t)`), so the field is rebuilt from scratch on every seek — stateless, random-access safe. Material attributes reuse the sf-mesh vocabulary (color/material/roughness/…).

| attribute | default | description |
|---|---|---|
| `count`/`seed` | 5 / 1 | blob count / PRNG seed |
| `resolution` | 56 | marching-cubes resolution (higher = smoother, slower) |
| `scale` | 2 | world size (field width = 2×scale) |
| `speed` | 0.7 | orbit speed multiplier |
| `strength`/`isolation` | 0.7 / 60 | blob merging behavior |
| `position` | 0 0 0 | cluster center |

Staging tip: omit the sf-scene `background` (transparent) and place DOM typography *before* the sf-scene in document order — the blobs occlude the letters (`examples/metaball`).

### `<sf-animate>` — semantic verbs

Common attributes: `target` (`camera` or `#id`), `verb`, `start` (seconds, default 0), `duration` (seconds), `ease`.

> Note: verb timing uses bare **`start`/`duration`**. `data-start`/`data-duration` are
> HyperFrames *clip* timing attributes — don't use them on sf-animate.

| verb | parameters (defaults) | description |
|---|---|---|
| `turntable` | `rpm` (6), `axis` (y) | continuous spin; no duration needed |
| `orbit` | `around` (`#id`\|`x y z`, default origin), `radius` (initial distance), `from`/`to` (deg, default initial→+360°), `height` (initial relative height), duration default 4 | arc around a center; on a camera, combine with look-at |
| `dolly` | `toward` (`#id`\|`x y z`), `distance` (1), duration default 1.5 | move toward the target (negative = pull back) |
| `move` | `to` (`x y z`, required), `from` (default initial position), duration default 2 | straight-line travel |
| `follow` | `subject` (`#id`), `offset` (`x y z`, default initial relative offset) | rigidly track a moving subject; continuous; runs in the late pass so it always applies after the subject's own movement verbs |
| `crossfade-clip` | `from`/`to` (clip names, required), duration default 0.5 | GLB clip weight crossfade (e.g. Survey→Run) |
| `camera-path` | `points` (comma-separated `x y z` list, ≥2), `look` (`ahead`\|`none`, default ahead), duration default 8 | Catmull-Rom spline flythrough; arc-length parameterized (constant spatial speed). `look="ahead"` aims along the path — omit `look-at` on sf-camera (it is applied later and would override). Runs in the late pass |
| `bounce-in` | duration default 0.6, ease default `back.out` | scale 0→original entrance |
| `fade-in` | duration default 0.6 | material opacity 0→original |
| `float` | `amplitude` (0.1), `period` (4) | sinusoidal bob on Y; continuous |
| `sway` | `amount` (6, degrees), `period` (5) | continuous multi-axis secondary motion (gentle wobble) — makes a form feel alive; analytic, seekable |
| `explode` | `distance` (1.5) | exploded view — separate a model's parts outward from its center over the window. Needs a **multi-component** GLB (separate part meshes); single-mesh or rigged-character models have nothing to separate (no effect) |
| `isolate` | `part` (index, required), `dim` (0.8) | feature spotlight — fade every *other* part's material toward black over the window so one component reads as the hero. `dim` is how far the rest darken (1 = fully). Needs a multi-component GLB; pair with a slow `dolly`/`orbit` toward the part |
| `variant` | `color`/`roughness`/`metalness` (target values), `material` (GLB material name filter), duration default 0.8 | material colorway transitions (configurators). Multiple variants on one target chain in start order — each one's from-state is the previous one's result (resolved at compile time, backward-seek safe) |

### Easing vocabulary (GSAP-compatible names)

`linear` `none`, `power1–4.in/.out/.inOut`, `sine.*`, `expo.*`, `circ.*`, `back.*`, `elastic.out`, `bounce.out`. Default is `power1.out` (`back.out` for bounce-in).

### `<sf-callout>` — spec-callout labels that track a 3D point

A thin leader line from a feature to a floating typographic label — the signature product-film annotation ("48MP · Main camera"). The tracked point is `Vector3.project()`ed against the final camera each seek and a real DOM label + SVG leader are positioned over the canvas, so the type stays crisp and seekable (it never affects the WebGL determinism check — the validator fingerprints the canvas, not the overlay). Lives inside `<sf-scene>`. Standalone mode only (in embed mode, annotations belong to HyperFrames).

| attribute | default | description |
|---|---|---|
| `target` | — | `#id` of an `sf-model`/object to anchor on (tracks it through turntable/orbit) |
| `part` | — | with `target`: which component to point at (index into the same part list `explode`/`isolate` use). Omit to anchor the whole object's center |
| `point` | — | `x y z` fixed world point to anchor on, instead of `target`/`part` |
| `value` | — | the big headline line (e.g. `48MP`, `Titanium`) — optional |
| `text` | — | the small uppercase caption under the value |
| `anchor` | right | `left` or `right` — which side the label sits on |
| `start`/`duration` | 0 / 0.7 | the leader draws on and the label settles in over this window; stays after |
| `ease` | power2.out | draw-on easing |

Pairs naturally with `isolate`: isolate a part, dolly toward it, and callout the same `part` index — one complete feature-highlight beat. The label is hidden automatically when its point is off-screen or behind the camera.

## DOM overlays (standalone mode)

- Visibility windows: `class="clip"` + `data-start`/`data-duration` (seconds) — the runtime toggles visibility as a function of t.
- Entrances: the `fade-in` (with optional `rise` px — fades in while rising) and `bounce-in` verbs fall back to DOM elements when `#id` is not a 3D object, driving inline styles (opacity/transform).
- `sf-animate` must live inside `<sf-scene>` even when it targets a DOM element.

In embed mode, DOM clips/animation belong to HyperFrames (GSAP timelines).

## Escape hatch

```html
<script type="stereoframe">
  // Runs once after assets load.
  // sf = { THREE, scene, camera, renderer, width, height, objects, scenes, onSeek }
  const product = sf.objects.get("product");
  sf.onSeek((t) => {
    product.rotation.z = Math.sin(t * 2) * 0.05;
  });
</script>
```

`onSeek` callbacks must be pure functions of `t`.

**`sf.THREE` is the full three.js namespace** — build custom geometry, materials, and GLSL shaders the markup can't express (iridescent/marble/oil-slick materials, vertex displacement, procedural effects), add them to `sf.scene`, and drive uniforms from `onSeek(t)`. This is how you escape the "everything looks like a preset" ceiling. It still goes through the deterministic seek loop and post-processing.

Determinism rules for custom GLSL (do not skip — broken determinism shows up as frames that diverge mid-render):
- Drive all time from a `uTime` uniform you set to `t`. Never read a clock in the shader.
- Use a **sin-free hash** for noise (e.g. Dave Hoskins' `fract(p*…)` hash). `sin(dot(p, large))*43758` loses GPU precision for large arguments and drifts run-to-run.
- Keep poly counts sane (`IcosahedronGeometry(r, 8)`, not `24`) — extreme geometry load can make the GPU vary between runs.

## Determinism: two tiers

Determinism governs **structure** — what's where, when, and how it moves — so compositions are seekable, editable, and reproducible. It does **not** straitjacket the visuals.

**Seekability (required).** Each frame must be a pure function of `t` *within a render*, so frame-by-frame capture produces a coherent video and any frame can be re-derived:
1. Drive everything from `t = frame/fps`. No `Date.now()` / `performance.now()` / wall clock.
2. Randomness must be **seeded** so it's identical for a given `t` (e.g. `<sf-particles seed>`, a `uTime`/uv-seeded GLSL hash). No unseeded `Math.random()` per frame.
3. No dependence on previous frames (trails, feedback, accumulators, stepped physics) — frames are seeked in any order.
4. Local assets only; no network fetch during render.

`stereoframe validate` enforces exactly this (a seek-idempotency probe).

**Bit-exactness across runs (NOT required).** You do *not* need two separate renders to be byte-identical. Inside the seekability envelope, go wild: sin-based GLSL noise, very high poly, heavy custom shaders, rich materials — all fine. (Cross-run identical files are only relevant for byte-level caching/CI, which is not a goal here; if you want them, prefer sin-free hashes and modest poly counts, but it's optional.)

The renderer keeps `antialias: false` (driver MSAA is non-deterministic) and supersamples instead (`samples`), and pins `pixelRatio 1`.

## Architecture notes

- Seek path: seek(t) → verb writers → `mixer.setTime(t)` → time uniforms → `camera.lookAt` → `renderer.render`. One synchronous function (`seek.ts`).
- HyperFrames touchpoints (the `__hf` global, `hf-seek`) are isolated in `seek.ts` — the upstream adapter contract is v0/experimental.
- Readiness gate (embed mode): the runtime proxies `window.__hf` to delay the render engine's readiness poll (`__hf.duration > 0`) until assets finish loading. DOMContentLoaded does not wait for module top-level await (measured), hence the gate.
