/**
 * Single deterministic frame → PNG — the author-facing feedback loop.
 *
 * Renders ONE frame at time `t` (a pure function of t, like every other seek)
 * to a PNG you can actually look at, instead of authoring blind. Reuses the
 * exact same ready-protocol + CDP screenshot path as `render`, so the captured
 * image is byte-for-byte a frame of the final video.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openSession } from "./session";

export interface FrameOptions {
  projectDir: string;
  t?: number;
  out?: string;
}

export interface FrameResult {
  out: string;
  t: number;
  duration: number;
  width: number;
  height: number;
}

export async function captureFrame(opts: FrameOptions): Promise<FrameResult> {
  const projectDir = resolve(opts.projectDir);
  const session = await openSession(projectDir, { echoErrors: true });
  try {
    const { page, info } = session;
    if (!(info.duration > 0)) {
      throw new Error('composition reported zero duration — set duration="<seconds>" on <sf-scene>');
    }
    // Clamp into [0, duration] so an agent guessing a time can't seek off the end.
    const t = Math.min(Math.max(opts.t ?? 0, 0), info.duration);
    const out = resolve(projectDir, opts.out ?? `frames/frame_${t}s.png`);
    mkdirSync(dirname(out), { recursive: true });

    const cdp = await page.createCDPSession();
    await page.evaluate(`window.__stereoframe.seek(${t})`);
    const shot = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: true,
    })) as { data: string };
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.error(`captured t=${t}s of ${info.duration}s (${info.width}x${info.height}) → ${out}`);
    return { out, t, duration: info.duration, width: info.width, height: info.height };
  } finally {
    await session.close();
  }
}
