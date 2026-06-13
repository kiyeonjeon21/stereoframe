# stereoframe

[![npm](https://img.shields.io/npm/v/stereoframe?logo=npm)](https://www.npmjs.com/package/stereoframe) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/kiyeonjeon21/stereoframe/blob/main/LICENSE)

**The auto-director for 3D motion graphics — drop in a GLB, get a cinematic reveal.**

```bash
npx stereoframe stage product.glb --preset spec --title "Product"
cd product-spec && npx stereoframe render   # → a grounded, annotated product film, zero hand-tuning
```

Asset generation (Meshy/Tripo/Rodin) is a solved, crowded space. The underserved layer is **directing** a model — camera, lighting, timing, easing, staging. stereoframe auto-frames any GLB and applies a director preset, all deterministic (every frame is a pure function of `t`, frame-hash-identical across runs) and agent-drivable. Underneath it's a full declarative 3D-video framework: describe a three.js scene in plain HTML custom elements and render it frame-perfectly to MP4.

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
stereoframe stage <model.glb> --preset <name>   # auto-direct a GLB into a film
stereoframe inspect <model.glb>                 # segment + tag a GLB's parts (name/material/where/size)
stereoframe gen "<prompt>"                       # text-to-3D → textured GLB (via Meshy)
stereoframe init <name>                          # scaffold a project
stereoframe lint | validate                      # static + headless verification
stereoframe render [--draft]                     # → renders/render_<ts>.mp4
stereoframe preview                              # looping playback in the browser
```

**Presets:** `reveal` (dramatic spiral-in), `hero-orbit` (clean studio orbit), `turntable` (pedestal), `exploded-view` (parts fly apart), **`spec`** (grounded film with auto-placed material callouts), **`teardown`** (exploded breakdown with a tracked label on each part). `stage` auto-frames the model, so a fixed preset frames any GLB correctly — then hand-edit the generated `index.html` to taste.

## How it works

Every frame is a pure function of `t = frame / fps`: the CLI drives `window.__stereoframe.seek(t)` in headless Chrome and screenshots each frame into ffmpeg. No wall clock, no accumulated state — random-access seekable and reproducible. `inspect` reads a GLB through the real runtime so reported part names/indices match exactly what `isolate`/`explode`/`sf-callout` target.

Requires Node ≥ 20 and ffmpeg.

## Full documentation

See the [GitHub repository](https://github.com/kiyeonjeon21/stereoframe) — markup spec ([docs/format.md](https://github.com/kiyeonjeon21/stereoframe/blob/main/docs/format.md)), the agent authoring guide ([SKILL.md](https://github.com/kiyeonjeon21/stereoframe/blob/main/skills/stereoframe/SKILL.md)), and runnable [examples](https://github.com/kiyeonjeon21/stereoframe/tree/main/examples).

## License

MIT.
