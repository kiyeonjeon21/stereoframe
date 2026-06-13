/**
 * Shared headless page session: serve the project, launch Chrome, wait for
 * the runtime's ready protocol, read composition info. Used by both
 * `render` and `validate`.
 */
import puppeteer, { type Page } from "puppeteer";
import { serveProject, type ServeHandle } from "./serve";

export interface CompositionInfo {
  duration: number;
  width: number;
  height: number;
}

export interface PageSession {
  page: Page;
  info: CompositionInfo;
  /** Console errors + uncaught page exceptions collected since load. */
  errors: string[];
  close: () => Promise<void>;
}

export async function openSession(
  projectDir: string,
  opts: { echoErrors?: boolean } = {},
): Promise<PageSession> {
  const handle: ServeHandle = await serveProject(projectDir);
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      // GPU-less environments (CI runners): Chrome 137+ disabled the automatic
      // SwiftShader WebGL fallback; this flag re-enables software rendering.
      "--enable-unsafe-swiftshader",
      // Ubuntu 24 runners block unprivileged user namespaces (AppArmor), which
      // crashes Chrome's sandbox. Compositions are local files, so dropping
      // the sandbox on CI is acceptable.
      ...(process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
    ],
  });

  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const record = (msg: string) => {
      errors.push(msg);
      if (opts.echoErrors) console.error("[page]", msg);
    };
    page.on("pageerror", (err) => record(err instanceof Error ? err.message : String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") record(msg.text());
    });

    await page.goto(handle.url, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(
        "window.__stereoframe && window.__stereoframe.ready === true",
        { timeout: 120_000, polling: 100 },
      );
    } catch (err) {
      const state = await page
        .evaluate(
          `({ hasProtocol: !!window.__stereoframe, ready: window.__stereoframe?.ready ?? null })`,
        )
        .catch(() => null);
      throw new Error(
        `runtime never became ready (${JSON.stringify(state)}). ` +
          `Check that index.html imports assets/stereoframe.js and that all assets load.` +
          (errors.length ? `\npage errors:\n  ${errors.join("\n  ")}` : ""),
      );
    }

    const info = (await page.evaluate(`({
      duration: window.__stereoframe.duration,
      width: window.__stereoframe.width,
      height: window.__stereoframe.height,
    })`)) as CompositionInfo;
    await page.setViewport({ width: info.width, height: info.height, deviceScaleFactor: 1 });

    return {
      page,
      info,
      errors,
      close: async () => {
        await browser.close();
        await handle.close();
      },
    };
  } catch (err) {
    await browser.close();
    await handle.close();
    throw err;
  }
}
