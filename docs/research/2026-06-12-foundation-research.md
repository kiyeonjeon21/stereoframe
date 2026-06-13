# Stereoframe Foundation Research: AI-Programmable 3D Video on Three.js

Researched 2026-06-12. Foundation research for extending what Hyperframes (HTML → deterministic video) did for 2D motion graphics into three.js-based 3D.

> Historical note: this document captures the initial research, when stereoframe was scoped as a Hyperframes extension layer. The project later went standalone (its own CLI, render protocol, and pipeline), keeping a HyperFrames embed mode as an option. The technical findings below still hold; the "build on Hyperframes" recommendation in §5 was superseded.

---

## 1. Decomposing the Hyperframes model (the design we should replicate)

Core design of Hyperframes (heygen-com/hyperframes, Apache-2.0, ~27k stars, v0.6.93):

| layer | implementation | core idea |
|---|---|---|
| authoring format | plain HTML + data attributes (`data-composition-id`, `data-start`, `data-duration`, `data-track-index`) | use the medium LLMs trained on most (HTML) as-is |
| animation | GSAP timeline (`window.__timelines[id]`) — a 2-layer split from declarative structure (HTML) | "no scripted media play/pause/seek" — the framework manages it |
| time model | `frame = floor(time × fps)`, `t = frame / fps` integer math | wall clock fully excluded → determinism |
| Frame Adapter | `{ id, init, getDurationFrames, seekFrame(frame), destroy }` — idempotent seek, arbitrary seek order guaranteed | integrates any runtime (GSAP/Anime/Lottie/CSS/**Three.js**) as seekable |
| capture | chrome-headless-shell + CDP `HeadlessExperimental.beginFrame` (`--deterministic-mode`), byte-identical output in Docker mode | drives the compositor loop directly |
| encoding | FFmpeg (CRF presets), PNG/alpha, ProRes 4444/VP9/GIF/HDR10 | |
| parameterization | `data-composition-variables` + `data-variable-values` → batch/personalized renders | |
| agent UX | non-interactive CLI (`init/preview/render/lint/validate/inspect`), `/hyperframes` skill, natural-language→config vocabulary table ("bouncy"→`back.out`), lint→validate→render loop | |
| catalog | 80+ blocks (almost all 2D; 3D limited to shader transitions / device mockups) | |

**Key finding 1 — Hyperframes already has a Three.js frame adapter.** It passes deterministic time via the `hf-seek` event + `window.__hfThreeTime` global, and the user updates transforms/AnimationMixer from that time. But it's a thin escape hatch: no 3D vocabulary (camera moves, lighting rigs, GLTF staging) and no real 3D blocks in the catalog.

**Key finding 2 — the HTML-in-Canvas guide already uses three.js.** It captures the DOM as a `THREE.CanvasTexture` via `<canvas layoutsubtree>` + `ctx.drawElementImage()` to apply shader effects. So the Hyperframes camp is expanding toward 3D too, but only at the "bring DOM into 3D" level — making "the 3D scene itself a first-class citizen" is unoccupied.

---

## 2. Market gap analysis (as of 2026-06)

| project | status | limitation from a 3D-video perspective |
|---|---|---|
| **Remotion + @remotion/three** | active (v4.0.471) | paid license (~$25/dev/mo for 4+ people), React-bound, fragile GL path (ANGLE memory leak, Lambda falls back to SwiftShader CPU). AI story (llms.txt, Claude skills) is best-in-class — a benchmark target |
| **Theatre.js** | effectively dormant (last release 2023-08) | a sequencer/editor only; no render/export pipeline |
| **Motion Canvas** | abandoned (since 2024-08; fork Revideo semi-dormant) | 2D only. Its generator-based time model is worth referencing |
| **A-Frame** | maintained but slow (v1.7.1, 2025-04) | evidence that declarative HTML 3D works for LLMs. But a wall-clock runtime, no seek/export |
| **R3F/drei/Threlte** | active | interactive runtime. `useFrame` = wall clock, no video pipeline of its own |
| **Blender bpy (+MCP)** | exploding AI integration (blender-mcp 16k+ stars, official MCP server) | heavy, non-web, slow render. The MCPs are interactive copilots, not reproducible render pipelines |
| **Needle/PlayCanvas/Spline** | active | no programmatic video export (Spline is GUI-only paid render) |
| **JSON video APIs (Shotstack etc.)** | active | 2D layer compositing, not scene-graph 3D |

**The empty intersection = stereoframe's positioning:**

1. An open-source (Apache/MIT) + 3D-native + deterministic frame-seek video framework **does not exist**.
2. There is no standard for describing **scene graph + camera + timeline** in an LLM-friendly declarative format (HTML/JSON) — the combination of A-Frame's markup × Hyperframes' timeline is unoccupied.
3. There is no **3D block catalog for video** (product turntables, camera rigs, lighting presets, GLTF clip players).
4. There is no **3D-aware lint/validate loop** (asset preload checks, frustum-containment checks, time-purity checks).
5. Headless GPU/WebGPU capture is an industry-wide open problem — solving it is a moat.

---

## 3. Three.js technical foundation (r184, 2026-04)

### 3.1 Version/docs status
- Current release **r184** (npm `three@0.184.0`). Release cadence slowed from monthly → 6–8 weeks.
- WebGL1 support removed in r163. `three/webgpu`, `three/tsl` entries since r167. WebGPURenderer is not yet the default (WebGL2 fallback built in).
- **`THREE.Clock` deprecated in r183** (→ `Timer`). Our pipeline bypasses both and uses `t = frame/fps` as a pure input.
- **Official llms.txt exists** (r183+): `threejs.org/docs/llms.txt` (5KB, with LLM guidance — import maps, version pinning, WebGL vs WebGPU choice), `llms-full.txt` (126KB). Every API page is served as markdown at `.html.md`. Indexed by Context7. → directly usable for building an agent skill.
- LLM three.js code failure mode = **version churn** (r152 color management, r155 lighting units, `examples/js`→`jsm`→`three/addons` path mixing, removed `Geometry`). Mitigation: pin the version + system-prompt cheat sheet + don't let the model choose import paths.

### 3.2 Time control (the heart of the seekFrame implementation)
- **AnimationMixer.setTime(t)** = "reset everything to 0, then update(t) once". Idempotent for ordinary looping clips. But:
  - `fadeIn/fadeOut/crossFadeTo/warp` are interpolants anchored to absolute mixer time, so they break on backward seeks → **set weights explicitly every frame via `setEffectiveWeight(f(t))`**.
  - `LoopOnce`+`clampWhenFinished` becomes paused/disabled past the end and won't revive on later seeks → `reset()` or restore paused/enabled before each seek.
  - A `paused` action snaps to its first frame after setTime → don't use `paused` in a seek pipeline.
  - timeScale is applied twice to the seek value → pin all to 1 and bake speed into t.
  - r184 includes "Fix timeScale reversal jump" — pinning r184+ recommended. Last frame: `min(t, duration-1e-6)`.
- **GSAP**: `gsap.ticker.remove(gsap.updateRoot)` then `gsap.updateRoot(t)`, or `tl.seek(t, false)` on a paused timeline — fully deterministic. **GSAP is fully free since 2025-04** (Webflow acquisition).
- **TSL/WebGPU pitfall**: the built-in `time`/`deltaTime` nodes are `performance.now()`-based (NodeFrame) and can't be overridden → make your own `uniform(0)` and set `u.value = t`.
- **Shaders**: a conventional `uTime` uniform is inherently seekable. EffectComposer **must** be called as `composer.render(1/fps)` (omitting the arg uses an internal wall-clock Clock).

### 3.3 Capture & encoding
- Pixel readback: `preserveDrawingBuffer` is unnecessary — capture **synchronously in the same task** as render. The precise path is `WebGLRenderTarget` + `readRenderTargetPixelsAsync` (r165+, async PBO+fence, raw RGBA/alpha; note row flip).
- In-browser encoding: WebCodecs `VideoEncoder` (Chrome 94+/FF 130+/Safari 26+) + **mediabunny** (the unified library that replaced mp4-muxer/webm-muxer, `CanvasSource.add(timestamp)` pattern). But **alpha is effectively non-encodable** (no H.264 alpha, VP9 alpha encode unsupported in most) → transparent video needs raw RGBA → ffmpeg (`yuva420p` VP9 / ProRes 4444). Encoder bitstreams aren't reproducible across machines → determinism is guaranteed to "frame pixels", with encoding pinned via ffmpeg.
- CDP capture (Hyperframes/Remotion approach): `Page.captureScreenshot` (simple, PNG alpha) or `HeadlessExperimental.beginFrame` (strongest determinism, but **chrome-headless-shell only, Linux/Windows; unstable on macOS**).

### 3.4 Headless & cross-machine determinism
- **No GPU path is bit-identical across machines** (the GL spec permits cross-implementation variation: MSAA sample positions, texture-filter precision, FMA fusion, rasterization tolerances).
- Practical recipe = same as Hyperframes Docker mode: **fixed linux/amd64 image + pinned chrome-headless-shell + SwiftShader** (`--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`) + `--deterministic-mode --enable-begin-frame-control --run-all-compositor-stages-before-draw`. Caution: **Chrome 137+ removed the automatic SwiftShader fallback** — explicit flags required. Bit-identity across architectures (x86 vs ARM) is not guaranteed (the Reactor JIT emits different code for SSE/NEON/FMA).
- The industry-standard compromise is dual-track: local dev = GPU-accelerated (fast, approximate determinism) / CI·production = SwiftShader Docker (bit-identical).
- headless-gl (npm `gl`) revived as v9 (ANGLE-based, experimental WebGL2) but has no DOM — a secondary path. Headless WebGPU (Dawn-node) is unreliable as of mid-2026.

### 3.5 Determinism checklist (the source of the lint rules)
1. All state a pure function of `t = frame/fps`; no `Date.now`/`performance.now`/rAF timestamps.
2. Load everything before frame 0: `loadAsync` + `LoadingManager.onLoad` + **`renderer.compileAsync(scene, camera)`** + await troika `sync()`, bundle fonts locally (troika's default font fetches from a CDN!).
3. `Math.random` → mulberry32 seed patch (per-frame `seed = base ^ frame` for seekability). `MathUtils.seededRandom` is already Mulberry32 (bit-exact).
4. Forbid/isolate sequential-state passes: AfterimagePass, TAA (accumulate), FilmPass accumulation, GlitchPass (internal Math.random + frame counter). Safe: **SSAARenderPass** (in-frame jitter, stateless), UnrealBloom, FXAA/SMAA.
5. `antialias: false` + SSAA/FXAA (context MSAA is driver-dependent), anisotropy 1; KTX2 picks a device-dependent transcode target so it breaks cross-machine determinism — force a target or avoid.
6. Video textures: `video.currentTime` seek is not frame-accurate → WebCodecs decode → canvas texture (Remotion's `useOffthreadVideoTexture` pattern).
7. Physics: **Rapier** `@dimforge/rapier3d-deterministic` (WASM, cross-platform deterministic) + fixed `world.timestep = 1/fps`. Simulation is inherently sequential → **bake** (run the whole sim once → record per-frame transforms) and drive from seekable data. Same for particles: start with stateless analytic particles (`pos = f(seed_i, t)` in the vertex shader).
8. Pin versions of three.js/Chrome/ffmpeg/fonts.

---

## 4. AI-friendly 3D representation (authoring format design)

### 4.1 Format candidate evaluation
- **Token efficiency / diffability / LLM fluency**: custom HTML-attribute DSL ≈ A-Frame > R3F JSX > .usda > raw three.js code > three.js JSON format 4 > glTF JSON > KHR_interactivity graphs.
- glTF/GLB = an **asset** format (official validator exists), not an authoring format (geometry is binary). USD is inspiration (prim hierarchy, layers/overrides, time samples) but has no browser runtime. three.js JSON format 4 lets LLMs break referential integrity via UUID cross-references.
- A-Frame proves it: LLMs write HTML entity-component well. But A-Frame itself bundles a runtime (render loop) so it can't be used directly — **borrow only the markup pattern** and interpret it with a seekable runtime of our own.
- A consistent lesson from the literature: **"the LLM proposes semantics/constraints; a deterministic solver/runtime does the math"** (SceneCraft, Holodeck, LLMR, 3D-GPT).

### 4.2 Animation altitude
- The answer is two-layer: **semantic verbs + parameters + named easing** ("orbit camera around #hero, radius 5, 3s, power2.inOut" / "bounce-in #logo at 1.2s") compiled deterministically to GSAP timelines/keyframes. Keep a raw `tl.to()` escape hatch.
- Evidence: MoVer (a GSAP motion-graphics verification DSL) — first-pass generation accuracy 58.8% → **93.6%** with a verify-and-fix loop. LAMP — compiles cinematography verbs (pan/tilt/truck/orbit/zoom) deterministically into 3D trajectories. Keyframer — iterative natural-language refinement + per-property decomposed prompting preferred.
- Raw keyframe JSON is for storage/diffing, not authoring.

### 4.3 Agent verification loop (measured effect)
1. **Execute + traceback feedback**: executability 70.2% → 97.4% (3DCodeBench).
2. **Scene-graph assertions** (programmatic, no render needed): `Box3.setFromObject` (bounds/intersection/floating objects), `Frustum.intersectsBox` ("is X on screen"), raycast occlusion, light/material/NaN checks. → the core of `stereoframe lint`.
3. **MoVer-style temporal assertions**: declarative predicates like "at t=3s #logo is in frame, scale=1" evaluated per frame. 58.8→93.6%.
4. **Screenshot→VLM critique loop**: submit 3–4 canonical angles + the actual shot camera render to a VLM. Cheap automatic proxy: SigLIP-2 similarity (r=0.964 with human preference).
5. The renderer doubles as the verifier: with a deterministic capture pipeline, **the validation renderer = the production renderer** (architectural saving).
6. AST-based API-existence lint (against the pinned three.js type declarations) blocks hallucinated APIs.

### 4.4 Asset strategy
- First choice **procedural**: three.js primitives + Extrude/Lathe/Tube + `three-bvh-csg`. Covers most motion-graphics needs, zero asset pipeline.
- **Poly Haven API** (CC0, api.polyhaven.com): HDRIs are the highest-leverage "instant look upgrade" asset. Agent-fetchable directly.
- Generative 3D (2026): Meshy (API/enterprise), Tripo (speed), TRELLIS 2 (open-source quality), Hunyuan3D (self-hosting). All output GLB. **The Sketchfab API is banned due to the Fab transition.** Kenney CC0 as a curated local library.
- Normalize all external assets to GLB + check with glTF-Validator + force preload before render.

---

## 5. Architecture proposal

### Strategy choice: build on Hyperframes, or go standalone

**Recommendation: stage 1 a Hyperframes extension layer, decide on standalone in stage 2.**

Rationale: Hyperframes is Apache-2.0 and already provides the hardest infrastructure (BeginFrame deterministic capture, Docker parity, ffmpeg/audio/HDR, the CLI/Studio/lint skeleton). The Frame Adapter v0 contract (`seekFrame`) is exactly the integration point we need. The differentiating value is not reinventing infrastructure but **3D vocabulary + 3D lint + 3D blocks**.

> Note: the project later went standalone in stage 2 (see the historical note at the top).

### Proposed stack (stereoframe)

```
┌─ Authoring layer: declarative 3D markup (A-Frame pattern, our own interpretation)
│   <sf-scene environment="studio" camera-fov="35">
│     <sf-model src="product.glb" position="0 0 0" data-start="0"/>
│     <sf-camera-move verb="orbit" target="#product" radius="4"
│                     from="0deg" to="270deg" data-start="30" data-duration="90"
│                     ease="power2.inOut"/>
│     <sf-text value="Introducing" anchor="top" data-start="15" enter="bounce-in"/>
│   </sf-scene>
│
├─ Compile layer: markup → three.js scene graph + GSAP master timeline
│   · verb library (orbit/dolly/truck/reveal/turntable/bounce-in …)
│   · easing vocabulary = GSAP named easing as-is
│   · escape hatch: <script type="sf-timeline"> raw GSAP/three.js
│
├─ Runtime layer: implement the Hyperframes Frame Adapter
│   seekFrame(frame): t = frame/fps →
│     gsap.updateRoot(t) → mixer.setTime(t) (explicit weights) →
│     uniforms.uTime.value = t → composer.render(1/fps)
│   · preload gate (loadAsync + compileAsync + troika sync)
│   · seeded RNG (mulberry32, frame-keyed)
│   · physics/particles only baked or stateless-analytic
│
├─ Validation layer: stereoframe lint / validate
│   · static: API existence (AST), markup schema, asset existence/GLB validator
│   · runtime: preload complete, NaN transforms, Box3/Frustum assertions,
│     MoVer-style temporal predicates, time purity (wall-clock call detection)
│   · visual: canonical-angle screenshots → VLM critique (optional)
│
├─ Render layer: Hyperframes engine/producer as-is
│   (chrome-headless-shell BeginFrame, SwiftShader Docker, ffmpeg)
│
└─ Agent layer: llms.txt + skill + block catalog
    · reuse three.js official llms.txt/.html.md, version-pin cheat sheet
    · 3D blocks: product turntable, device mockup, logo reveal, camera rig,
      lighting presets (studio/sunset/neon), particle presets, GLTF clip player
    · natural-language→config vocabulary table (Hyperframes prompting-guide pattern)
```

### Pinning policy (the foundation of reproducibility)
- three.js **r184+** (includes the animation-seek fix), pinned chrome-headless-shell version, pinned ffmpeg, bundled fonts, linux/amd64 Docker.
- WebGLRenderer first (headless WebGPU immature as of mid-2026; track TSL as secondary, premised on a custom time uniform).

### Priorities the measured numbers imply
1. Execution-feedback loop (70→97%) — CLI validate returns structured tracebacks.
2. Temporal/spatial assertions (59→94%) — MoVer-style predicates built into lint.
3. Semantic verb layer — let the LLM write intent, not keyframe math.
4. Block catalog — the proven driver of Hyperframes' growth.

---

## 6. Risks

- **The Hyperframes Frame Adapter is v0 (experimental)** — breaking changes possible before v1. Keep the adapter boundary thin to isolate it.
- **HeyGen could promote 3D to first-class itself** — the HTML-in-Canvas guide is a signal in that direction. Move fast; also consider an upstream-contribution strategy.
- BeginFrame is unstable on local macOS → local in screenshot mode, CI in Docker (same compromise as Hyperframes).
- Alpha video is impossible via WebCodecs — keep the raw RGBA → ffmpeg path.
- Cross-machine bit-identity is limited to the same architecture (force amd64 emulation when mixing Apple Silicon vs x86).

## 7. Key sources

- Hyperframes: https://hyperframes.mintlify.app (frame-adapters, determinism, prompting, rendering, hyperframes-vs-remotion), https://github.com/heygen-com/hyperframes
- three.js: https://threejs.org/docs/llms.txt, Migration Guide (wiki), r183/r184 release notes, AnimationMixer.setTime PR #17504, NodeFrame.js (TSL time)
- Remotion: remotion.dev/docs/three, /gl-options, /ai/system-prompt, /license
- Deterministic capture: alexey-pelykh.com (puppeteer-capture), replit.com/blog/browsers-dont-want-to-be-cameras, CDP HeadlessExperimental/Emulation, Chromium SwiftShader docs, SwiftShader fallback removal (Chrome 137)
- Research: MoVer (2502.13372), LAMP (2512.03619), 3DCodeBench (2606.01057), SceneCraft, Holodeck, LLMR, Keyframer
- Tools: mediabunny.dev, rapier.rs/determinism, troika-three-text, three-bvh-csg, api.polyhaven.com
