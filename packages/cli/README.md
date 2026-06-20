# stereoframe

[![npm](https://img.shields.io/npm/v/stereoframe?logo=npm)](https://www.npmjs.com/package/stereoframe) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/kiyeonjeon21/stereoframe/blob/main/LICENSE)

**CI for generated 3D assets — inspect, score, compare, and render GLBs as reproducible evidence.**

```bash
npx stereoframe evaluate meshy.glb rodin.glb tripo.glb --frames --render
# → quality reports, comparison frames, a standardized MP4, and REPORT.md
```

AI 3D generation is useful, but output quality varies wildly. stereoframe treats generated GLBs as **candidate assets to evaluate**, not guaranteed finished products: inspect geometry, flag defects, compare providers/models under one rig, capture evidence frames, and render reproducible previews. Once an asset is accepted, the same deterministic runtime can stage it into spec sheets, teardown explainers, or custom 3D video.

```html
<sf-scene environment="room" background="#0b0f17" ground="contact-shadow" light-sweep="0.1">
  <sf-camera fov="33" position="0 1 5" look-at="#product"></sf-camera>
  <sf-model id="product" src="assets/helmet.glb" fit="2.6" fit-ground></sf-model>
  <sf-light preset="studio"></sf-light>
  <sf-animate target="#product" verb="turntable" rpm="5"></sf-animate>
  <sf-animate target="camera" verb="orbit" around="#product" from="0deg" to="35deg"
              duration="8" ease="sine.inOut"></sf-animate>
</sf-scene>
```

## Commands

```bash
stereoframe evaluate <a.glb> [b.glb…]           # quality reports + comparison scene/frames/video
stereoframe evaluate <model.glb> --audit        # animated GLB audit report + parts evidence
stereoframe stage <model.glb> --preset <name>   # stage an accepted GLB into a preview/film
stereoframe inspect <model.glb>                 # segment + tag a GLB's parts (name/material/where/size)
stereoframe gen "<prompt>"                       # labs: text/image-to-3D candidate GLB
stereoframe init <name>                          # scaffold a project
stereoframe lint | validate                      # static + headless verification
stereoframe render [--draft]                     # → renders/render_<ts>.mp4
stereoframe frame --t <s>                         # one frame → PNG (inspect a moment without a full render)
stereoframe preview                              # looping playback in the browser
```

**Evaluate candidates** with `evaluate`: one or more generated/production GLBs → `reports/summary.json`, per-asset `*.quality.json`, `REPORT.md`, a standardized `index.html`, optional `frames/`, and optional `renders/evaluation.mp4`. For one GLB, add `--audit` to generate `report.html`, `reports/parts.json`, part-isolation/exploded-view evidence when the asset is separable, evidence timestamps for selected-part thumbnails, honest single-mesh limitation warnings when it is not, and optional `renders/report.mp4`.

**Generate candidate assets** with `gen`: text-to-3D, `--image`/`--images` for image-to-3D, or `--via-image` (text → reference image → 3D). Defaults to [Meshy](https://www.meshy.ai) (free test mode; set `MESHY_API_KEY` for real generations); `--provider fal` routes any [fal.ai](https://fal.ai/models?categories=3d) 3D model instead (Tripo, Hyper3D/Rodin, Hunyuan3D…) via `FAL_KEY` + `--fal-model`. Generated GLBs should be inspected/evaluated before you rely on them.

**Presets:** `reveal` (dramatic spiral-in), `hero-orbit` (clean studio orbit), `turntable` (pedestal), `exploded-view` (parts fly apart), **`spec`** (grounded preview with auto-placed material callouts), **`teardown`** (exploded breakdown with a tracked label on each part), **`cinematic`** (multi-shot reveal/macro/hero preview). `stage` auto-frames the model, so a fixed preset frames any accepted GLB consistently — then hand-edit the generated `index.html` to taste.

## How it works

Every frame is a pure function of `t = frame / fps`: the CLI drives `window.__stereoframe.seek(t)` in headless Chrome and screenshots each frame into ffmpeg. No wall clock, no accumulated state — random-access seekable within a render. `inspect` reads a GLB through the real runtime so reported part names/indices match exactly what `isolate`/`explode`/`sf-callout` target.

Requires Node ≥ 20 and ffmpeg.

## Full documentation

See the [GitHub repository](https://github.com/kiyeonjeon21/stereoframe) — markup spec ([docs/format.md](https://github.com/kiyeonjeon21/stereoframe/blob/main/docs/format.md)), the agent authoring guide ([SKILL.md](https://github.com/kiyeonjeon21/stereoframe/blob/main/skills/stereoframe/SKILL.md)), and runnable [examples](https://github.com/kiyeonjeon21/stereoframe/tree/main/examples).

## License

MIT.
