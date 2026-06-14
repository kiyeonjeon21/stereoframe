/**
 * `stereoframe bake <dir> --target <id>` — freeze a live/forward simulation into
 * a seekable asset.
 *
 * Drives the project the same way `render` does (open session, step
 * `seek(frame/fps)` monotonically so a forward sim advances) but instead of
 * screenshotting, it reads the target InstancedMesh's `instanceMatrix` each
 * frame and writes a frame-major Float32 cache (`<id>.bake.bin`) plus a `.json`
 * manifest. An `<sf-baked src="...">` then replays it as a pure function of t —
 * so a sim authored with `mode="forward"` becomes random-access seekable and
 * usable in multi-shot compositions.
 *
 * MVP scope: per-frame instance matrices (mat4) only, nearest-frame ("step")
 * sampling at playback. Endianness follows the host (LE on x86/arm), matching
 * the browser's Float32Array reader.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openSession } from "./session";

export interface BakeOptions {
  projectDir: string;
  target: string;
  fps?: number;
  out?: string;
}

const STRIDE = 16; // floats per instance (a mat4)

export async function bakeProject(opts: BakeOptions): Promise<string> {
  const fps = opts.fps ?? 30;
  const projectDir = resolve(opts.projectDir);
  const target = opts.target;

  const session = await openSession(projectDir, { echoErrors: true });
  try {
    const { page, info } = session;
    if (!(info.duration > 0)) {
      throw new Error('composition reported zero duration — set duration="<seconds>" on <sf-scene>');
    }

    const find = (expr: string) =>
      `(() => { for (const s of window.__stereoframe.scenes) { const m = s.objectsById.get(${JSON.stringify(
        target,
      )}); if (m && m.isInstancedMesh) return ${expr}; } return null; })()`;

    const count = (await page.evaluate(find("m.count"))) as number | null;
    if (count == null) {
      throw new Error(
        `bake target "${target}" not found as an InstancedMesh — give your instanced sim an id (e.g. sf.objects.set("${target}", mesh)).`,
      );
    }

    const frames = Math.max(1, Math.round(info.duration * fps));
    const buf = new Float32Array(frames * count * STRIDE);
    process.stderr.write(`baking "${target}" — ${count} instances × ${frames} frames @ ${fps}fps\n`);
    for (let f = 0; f < frames; f++) {
      await page.evaluate(`window.__stereoframe.seek(${f / fps})`);
      const arr = (await page.evaluate(find("Array.from(m.instanceMatrix.array)"))) as number[] | null;
      if (!arr) throw new Error(`bake target "${target}" vanished at frame ${f}`);
      buf.set(arr, f * count * STRIDE);
      if (f % Math.max(1, Math.floor(frames / 10)) === 0) {
        process.stderr.write(`\r  ${Math.round((f / frames) * 100)}%`);
      }
    }
    process.stderr.write("\r  100%\n");

    const assetsDir = join(projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const binName = opts.out ?? `${target}.bake.bin`;
    writeFileSync(join(assetsDir, binName), Buffer.from(buf.buffer, 0, buf.byteLength));
    const manifest = {
      version: 1,
      target,
      kind: "instanceMatrix",
      count,
      stride: STRIDE,
      fps,
      frames,
      duration: info.duration,
      bin: binName,
      interpolate: "step",
    };
    const manifestPath = join(assetsDir, `${target}.bake.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const mb = (buf.byteLength / 1e6).toFixed(1);
    return `${manifestPath}  (+ ${binName}, ${mb} MB)`;
  } finally {
    await session.close();
  }
}
