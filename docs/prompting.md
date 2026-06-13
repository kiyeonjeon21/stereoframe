# Prompting Guide

When making a video with stereoframe, describe your **directorial intent**, not the markup. Translating intent into markup is the job of an agent that has read the skill (`skills/stereoframe/SKILL.md`). This document covers how to request a good first result and a fast refinement loop.

## Five things to put in a request

| # | item | example |
|---|---|---|
| 1 | **what** | a product GLB, text, a character, an abstract scene |
| 2 | **mood** | "golden hour", "dark studio", "bright paper texture" |
| 3 | **length/format** | "8 seconds", "1080p", "vertical (1080×1920)" |
| 4 | **shot flow** | "① title → ② product → ③ ending" — a shot list is the strongest form for multi-shot |
| 5 | **text/copy** | the exact wording — the one thing the agent should never invent |

## Examples by altitude

**Lowest effort — hand the agent a GLB:** for "make my model look good", the agent reaches for `stage` (auto-frame + director preset) — you don't describe a scene at all.

> "Make an Apple-ad-style reveal of this helmet GLB." → `stage helmet.glb --preset reveal`
> "Annotate the parts of this lamp as a spec sheet." → `inspect` then `stage --preset spec`

**High altitude — enough most of the time:**

> "A 10-second product video with my helmet GLB. Dark studio, slow rotation while the camera arcs slightly, 'Titan Mk-II' title at the bottom."

**Shot-level — trailers:** a shot list is the strongest form. When you give beats with their own camera/lighting/grade, the agent can write a **storyboard plan** (JSON) and compile the whole multi-shot film in one command (`stereoframe storyboard plan.json`), with crossfade timing computed for you.

> "A 15-second trailer: ① the words 'LAUNCH WEEK' assemble from paper scraps → ② 'March 24' over a glass panel → ③ fly over the ocean to an ending logo. Crossfade between shots."

> "A cinematic spot of this GLB: cold-open in near-black → ignition orbit → push-in macro → low-angle hero with our wordmark. Teal-rim/warm-fill, moody grade." → a storyboard plan (see `examples/storyboard-camera`).

**One paragraph → a whole film (the `brief`):** direction is natural-language too —
the symmetric twin of the Meshy *gen* prompt. `stereoframe brief "<paragraph>" --model
<glb> --render` sends your brief to an LLM that writes a rich, cinematic `plan.json`
(model-aware: it inspects the GLB), then compiles + renders it. The brief is saved
next to the result as `brief.md` (provenance, like `gen`'s `.gen.json`). A good brief
names: the **product/mood**, the **arc** (cold-open → reveal → detail → hero), the
**palette**, the **length**, and the **copy** (exact wording).

> `stereoframe brief "A dark, high-drama neon showroom film of this hypercar. Cold open in near-black, hard cut as the lights slam on, sweep + push-in + a flythrough, end on a low hero with 'APEX' / 'engineered in motion' / '0–100 in 2.4s · 1020 bhp'. Cyan/magenta, ~24s, drifting dust." --model car.glb --render`

(When you're working *with an agent* like Claude, you don't need the command — just
describe the film and the agent writes the rich plan directly.)

**Iterative refinement — the core loop after the first render:**

> "Make shot 2 half a second longer" · "Camera lower" · "Delay the title by a second and use fade instead of bounce" · "Make the particles amber"

Because the markup is declarative, a partial edit is a one-line diff, and because rendering is deterministic, you get a result where only that part changed. The agent verifies its own output before rendering with `stereoframe lint` (static) and `validate` (headless — lighting, framing, black frames, seek idempotency), so most mistakes are caught before you ever watch the video. Don't try to write the perfect prompt in one go — running this refinement loop is fastest (decomposed iterative refinement beating one-shot generation is a research-backed pattern — Keyframer, MoVer).

## Leave to the agent vs. give explicitly

| Leave to the agent (defaults are tuned) | Give explicitly |
|---|---|
| camera coordinates, fov, easing names | the exact wording/copy |
| lighting values, exposure, tone-mapping | asset files (GLB/HDRI), or say "procedural" |
| particle count/seed, fine shot-length splits | brand colors (if any) |
| glass/water material parameters | total length and intended use (social/presentation/demo) |

**Asset rule**: for requests that need models or environment maps, you can (a) provide the GLB/HDRI files, (b) say "abstract with primitives", or (c) let the agent **generate** a model from text — `stereoframe gen "<prompt>"` produces a textured GLB via Meshy. The agent won't use CDN assets at render time because remote fetches break determinism, but generation happens up front and the GLB is saved locally (CC0 sources for hand-picked assets: Poly Haven HDRIs, Khronos sample GLBs).

## What's in range of the current vocabulary

**Works in one pass** — auto-directing a GLB (`stage`: reveal/hero-orbit/turntable/exploded-view/spec/teardown), compiling a shot list into a multi-shot film (`storyboard`), turntable/orbit/dolly/spline-flythrough cameras, character clip transitions (idle→run) with a follow camera, paper-swarm typography, glass panels (transmission), ocean/sky (golden hour), particles (fountain/snow/dust), metaball goo, material colorway switching (variant), multi-shot cuts/crossfades, DOM titles/captions.

**Not yet** — the agent will try the escape hatch or tell you the limit: physics simulation (collapse/collision), photorealistic humans, audio, depth of field, motion blur, wipe/shader transitions, 3D text meshes (captions are DOM overlays).

**Freedom note**: determinism here only governs structure (layout/timing/motion are reproducible and seekable) — not the visuals. You can ask for arbitrarily rich custom-shader looks, distinctive matcap materials, and film finish (grain, chromatic aberration, grade); none of that is constrained by reproducibility.

## Most efficient pattern: reference + difference

Starting from a proven example (`examples/`) and stating only the difference gives the highest first-render hit rate:

> "Like ocean-flythrough but a night sea, a lighthouse GLB instead of the buoy (attached), 'COMING SOON' at the end"

| reference example | style |
|---|---|
| `storyboard-camera` | directed multi-shot spot from a JSON shot list (the `storyboard` compiler) |
| `product-teardown` | annotated product film (inspect + isolate + tracked callouts) |
| `product-turntable` | product video (HDRI studio + turntable + orbit) |
| `character-run-standalone` | character shot (clip transition + follow cam + particles) |
| `ocean-flythrough` | nature flythrough (sky/ocean + camera path) |
| `glass-hero` | dark glass hero (transmission + glow) |
| `paper-swarm` | typography motion graphics (paper scraps gathering) |
| `metaball` | gooey blobs occluding typography |
| `variant-demo` | colorway switching with the variant verb |
| `multi-shot` | multi-shot trailer (cut/crossfade structure) |

When the same visual style is needed repeatedly, say **"make this a block"** — it gets promoted into the vocabulary (an `sf-*` element) and is reusable with a few attributes thereafter.

## Request template

```
[Use] product launch trailer / social teaser / presentation opener …
[Length/format] 12 seconds, 1920×1080
[Shot flow] ① … → ② … → ③ …  (transition: cut/crossfade)
[Mood] …
[Copy] title "…", caption "…"
[Assets] attached GLB/HDRI or "procedural"
[Other] brand color #…, reference example …
```

You don't have to fill it all in — the agent fills blanks with defaults, and you refine after seeing the render.
