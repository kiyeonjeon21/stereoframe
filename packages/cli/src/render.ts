/**
 * Deterministic frame-by-frame renderer.
 *
 * Drives the runtime's own protocol — `window.__stereoframe` exposes
 * { ready, duration, width, height, seek } and `ready` only flips true after
 * every GLB/HDRI is loaded and shaders are compiled, so the first captured
 * frame can never be half-loaded. Each frame: seek(t = frame/fps)
 * synchronously re-renders, then a CDP screenshot captures the composited
 * page (WebGL canvas + DOM overlays), piped straight into ffmpeg.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openSession } from "./session";

export interface RenderOptions {
  projectDir: string;
  out?: string;
  fps?: number;
  crf?: number;
  draft?: boolean;
}

export async function renderProject(opts: RenderOptions): Promise<string> {
  const fps = opts.fps ?? 30;
  const crf = opts.draft ? 28 : (opts.crf ?? 18);
  const preset = opts.draft ? "veryfast" : "medium";
  const projectDir = resolve(opts.projectDir);
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const out = resolve(projectDir, opts.out ?? `renders/render_${stamp}.mp4`);
  mkdirSync(dirname(out), { recursive: true });

  const session = await openSession(projectDir, { echoErrors: true });
  try {
    const { page, info } = session;
    if (!(info.duration > 0)) {
      throw new Error('composition reported zero duration — set duration="<seconds>" on <sf-scene>');
    }

    const totalFrames = Math.max(1, Math.round(info.duration * fps));
    console.error(
      `rendering ${totalFrames} frames @ ${fps}fps (${info.width}x${info.height}, ${info.duration}s) → ${out}`,
    );

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel", "error",
        "-f", "image2pipe",
        "-framerate", String(fps),
        "-c:v", "png",
        "-i", "-",
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", String(crf),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const ffmpegDone = new Promise<void>((resolveDone, rejectDone) => {
      ffmpeg.on("error", (err) =>
        rejectDone(
          err.message.includes("ENOENT")
            ? new Error("ffmpeg not found on PATH — install it (e.g. `brew install ffmpeg`)")
            : err,
        ),
      );
      ffmpeg.on("close", (code) =>
        code === 0 ? resolveDone() : rejectDone(new Error(`ffmpeg exited with code ${code}`)),
      );
    });

    const cdp = await page.createCDPSession();
    const started = Date.now();
    for (let frame = 0; frame < totalFrames; frame++) {
      await page.evaluate(`window.__stereoframe.seek(${frame / fps})`);
      const shot = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        optimizeForSpeed: true,
      })) as { data: string };
      const ok = ffmpeg.stdin.write(Buffer.from(shot.data, "base64"));
      if (!ok) await new Promise((r) => ffmpeg.stdin.once("drain", r));
      if (frame % Math.max(1, Math.floor(totalFrames / 10)) === 0) {
        const pct = Math.round((frame / totalFrames) * 100);
        process.stderr.write(`\r  ${pct}% (frame ${frame}/${totalFrames})`);
      }
    }
    ffmpeg.stdin.end();
    await ffmpegDone;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(`\r  100% (${totalFrames} frames in ${secs}s)\n`);
    return out;
  } finally {
    await session.close();
  }
}
