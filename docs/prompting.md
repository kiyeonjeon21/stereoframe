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

**High altitude — enough most of the time:**

> "A 10-second product video with my helmet GLB. Dark studio, slow rotation while the camera arcs slightly, 'Titan Mk-II' title at the bottom."

**Shot-level — trailers:**

> "A 15-second trailer: ① the words 'LAUNCH WEEK' assemble from paper scraps → ② 'March 24' over a glass panel → ③ fly over the ocean to an ending logo. Crossfade between shots."

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

**Asset rule**: for requests that need models or environment maps, provide the GLB/HDRI files or say "abstract with primitives". The agent won't use CDN assets because remote fetches during render break determinism (CC0 sources: Poly Haven HDRIs, Khronos sample GLBs).

## What's in range of the current vocabulary

**Works in one pass** — turntable/orbit/dolly/spline-flythrough cameras, character clip transitions (idle→run) with a follow camera, paper-swarm typography, glass panels (transmission), ocean/sky (golden hour), particles (fountain/snow/dust), metaball goo, material colorway switching (variant), multi-shot cuts/crossfades, DOM titles/captions.

**Not yet** — the agent will try the escape hatch or tell you the limit: physics simulation (collapse/collision), photorealistic humans, audio, wipe/shader transitions, 3D text meshes (captions are handled as DOM overlays).

## Most efficient pattern: reference + difference

Starting from a proven example (`examples/`) and stating only the difference gives the highest first-render hit rate:

> "Like ocean-flythrough but a night sea, a lighthouse GLB instead of the buoy (attached), 'COMING SOON' at the end"

| reference example | style |
|---|---|
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
