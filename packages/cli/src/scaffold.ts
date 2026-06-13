/**
 * `stereoframe init <name>` — scaffolds a standalone composition project:
 * an index.html with sf-markup and the bundled runtime copied into assets/.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      body { font-family: ui-sans-serif, system-ui, sans-serif; }
      sf-scene { position: absolute; inset: 0; }
      #title {
        position: absolute; bottom: 100px; width: 100%; text-align: center;
        font-size: 64px; font-weight: 700; color: #f4f4f5; letter-spacing: 0.04em;
      }
    </style>
  </head>
  <body>
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
  </body>
</html>
`;

export function resolveRuntimeBundle(): string {
  const require = createRequire(import.meta.url);
  // package main points at dist/stereoframe.js
  return require.resolve("stereoframe-runtime");
}

export function scaffoldProject(name: string, cwd = process.cwd()): string {
  const dir = resolve(cwd, name);
  if (existsSync(join(dir, "index.html"))) {
    throw new Error(`refusing to overwrite existing project at ${dir}`);
  }
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), TEMPLATE);
  writeFileSync(join(dir, ".gitignore"), "renders/\n");
  copyFileSync(resolveRuntimeBundle(), join(dir, "assets", "stereoframe.js"));
  return dir;
}

/** `stereoframe update` — refresh the runtime bundle in an existing project. */
export function updateRuntime(projectDir: string): string {
  if (!existsSync(join(resolve(projectDir), "index.html"))) {
    throw new Error(`no index.html in ${projectDir} — not a stereoframe project`);
  }
  const target = join(resolve(projectDir), "assets", "stereoframe.js");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolveRuntimeBundle(), target);
  return target;
}
