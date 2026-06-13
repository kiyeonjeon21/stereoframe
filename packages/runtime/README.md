# stereoframe-runtime

[![npm](https://img.shields.io/npm/v/stereoframe-runtime?logo=npm)](https://www.npmjs.com/package/stereoframe-runtime) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/kiyeonjeon21/stereoframe/blob/main/LICENSE)

The browser runtime for **[stereoframe](https://www.npmjs.com/package/stereoframe)** — a bundled three.js (r184) plus the `<sf-*>` declarative custom elements and the deterministic seek protocol that turns markup into frame-perfect 3D video.

Most users don't depend on this package directly: the `stereoframe` CLI copies the built bundle (`dist/stereoframe.js`) into your project's `assets/` and references it from `index.html`. Install it directly only if you're embedding the runtime in your own build.

```html
<sf-scene environment="room" background="#0b0f17">
  <sf-camera position="0 1 5" look-at="#m"></sf-camera>
  <sf-model id="m" src="assets/model.glb" fit="2.6" fit-ground></sf-model>
  <sf-light preset="studio"></sf-light>
  <sf-animate target="#m" verb="turntable" rpm="5"></sf-animate>
</sf-scene>
<script type="module">import "./stereoframe.js";</script>
```

It exposes `window.__stereoframe` (`{ ready, duration, seek(t), … }`): every frame is a pure function of `t`, so any seek order is reproducible. It also auto-detects a HyperFrames composition root and behaves as an `hf-seek` adapter when embedded.

A Node-safe vocabulary entry (`stereoframe-runtime/vocab`) exports the element/verb/easing name lists for tooling (the CLI linter imports it).

## Documentation

See the [stereoframe repository](https://github.com/kiyeonjeon21/stereoframe) and the [markup specification](https://github.com/kiyeonjeon21/stereoframe/blob/main/docs/format.md).

## License

MIT.
