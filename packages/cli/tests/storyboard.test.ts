import { describe, expect, test } from "bun:test";
import {
  compileStoryboard,
  computeTimeline,
  validateStoryboard,
  type ResolvedShot,
  type Shot,
  type Storyboard,
} from "../src/storyboard";
import { lintHtml } from "../src/lint";

const shot = (p: Partial<Shot>): Shot => ({
  duration: 2,
  camera: { type: "static", position: "0 1 5", lookAt: "0 1 0" },
  ...p,
});

const resolvedFor = (plan: Storyboard): ResolvedShot[] =>
  plan.shots.map(() => ({ modelBasename: "model.glb", metalRig: false }));

describe("computeTimeline", () => {
  test("cut chain is cumulative", () => {
    const t = computeTimeline([
      shot({ duration: 2, transition: "cut" }),
      shot({ duration: 3, transition: "cut" }),
      shot({ duration: 1, transition: "cut" }),
    ]);
    expect(t.map((w) => w.start)).toEqual([0, 2, 5]);
    expect(t.map((w) => w.end)).toEqual([2, 5, 6]);
  });

  test("crossfade chain reproduces the v4 cinematic [0, 2.0, 4.5, 6.5]/9.5", () => {
    const t = computeTimeline([
      shot({ duration: 2.5 }), // shot 1 — transition ignored (cut)
      shot({ duration: 3.0, transitionDuration: 0.5 }),
      shot({ duration: 2.5, transitionDuration: 0.5 }),
      shot({ duration: 3.0, transitionDuration: 0.5 }),
    ]);
    expect(t.map((w) => w.start)).toEqual([0, 2.0, 4.5, 6.5]);
    expect(Math.max(...t.map((w) => w.end))).toBe(9.5);
  });

  test("first shot is always a cut, overlap 0", () => {
    const t = computeTimeline([shot({ transition: "crossfade", transitionDuration: 0.5 }), shot({})]);
    expect(t[0]!.transition).toBe("cut");
    expect(t[0]!.start).toBe(0);
  });

  test("coverage invariant: prevEnd >= start_i + transitionDuration for crossfades", () => {
    const shots = [shot({ duration: 4 }), shot({ duration: 3, transitionDuration: 0.6 }), shot({ duration: 5, transitionDuration: 0.4 })];
    const t = computeTimeline(shots);
    for (let i = 1; i < t.length; i++) {
      if (t[i]!.transition === "crossfade") {
        expect(t[i - 1]!.end).toBeGreaterThanOrEqual(t[i]!.start + t[i]!.transitionDuration - 1e-9);
      }
    }
  });
});

describe("validateStoryboard", () => {
  test("valid plan yields no errors", () => {
    const plan: Storyboard = { model: "m.glb", shots: [shot({}), shot({ camera: { type: "orbit", radius: 5, from: 30, to: -8 } })] };
    expect(validateStoryboard(plan)).toEqual([]);
  });

  test("empty shots is an error", () => {
    expect(validateStoryboard({ shots: [] } as Storyboard).length).toBeGreaterThan(0);
  });

  test("missing model (no top-level, no per-shot) is an error", () => {
    const errs = validateStoryboard({ shots: [shot({})] } as Storyboard);
    expect(errs.some((e) => /no model/.test(e))).toBe(true);
  });

  test("duration <= 0 is an error", () => {
    const errs = validateStoryboard({ model: "m.glb", shots: [shot({ duration: 0 })] });
    expect(errs.some((e) => /duration/.test(e))).toBe(true);
  });

  test("transitionDuration longer than a neighbouring shot is an error", () => {
    const errs = validateStoryboard({
      model: "m.glb",
      shots: [shot({ duration: 2 }), shot({ duration: 1, transitionDuration: 1.5 })],
    });
    expect(errs.some((e) => /transitionDuration/.test(e))).toBe(true);
  });

  test("malformed pose is an error (shot and defaults); valid/absent pose is fine", () => {
    expect(validateStoryboard({ model: "m.glb", shots: [shot({ pose: "90 0" })] }).some((e) => /pose/.test(e))).toBe(true);
    expect(validateStoryboard({ model: "m.glb", shots: [shot({ pose: "a b c" })] }).some((e) => /pose/.test(e))).toBe(true);
    expect(validateStoryboard({ model: "m.glb", defaults: { pose: "1 2" }, shots: [shot({})] }).some((e) => /pose/.test(e))).toBe(true);
    expect(validateStoryboard({ model: "m.glb", defaults: { pose: "90 0 90" }, shots: [shot({ pose: "0 45 0" })] })).toEqual([]);
  });

  test("bad camera type and unknown ease are errors", () => {
    const errs = validateStoryboard({
      model: "m.glb",
      // @ts-expect-error intentionally invalid
      shots: [shot({ camera: { type: "zoom" } }), shot({ camera: { type: "orbit", radius: 5, from: 0, to: 1, ease: "nope" } })],
    });
    expect(errs.some((e) => /camera.type/.test(e))).toBe(true);
    expect(errs.some((e) => /ease/.test(e))).toBe(true);
  });
});

describe("compileStoryboard", () => {
  const plan: Storyboard = {
    title: "Test Film",
    model: "m.glb",
    defaults: { bg: "#0a0a0e", environment: "room", finish: { exposure: 0.9, samples: 2, bloom: 0.2 } },
    shots: [
      shot({ name: "establish", duration: 2.5, camera: { type: "static", position: "0 1 6", lookAt: "0 1 0" }, text: { title: "HELLO", subtitle: "a film" } }),
      shot({ name: "orbit", duration: 3, transitionDuration: 0.5, camera: { type: "orbit", radius: 5, from: 30, to: -20, height: 0.4 }, spin: 2 }),
      shot({ name: "push", duration: 2.5, transitionDuration: 0.5, camera: { type: "push-in", position: "0 1 6", lookAt: "0 1 0", distance: 0.6 }, explode: { distance: 0.8 } }),
      shot({ name: "fly", duration: 3, transitionDuration: 0.5, camera: { type: "path", points: "0 2 6, 2 1 4, 0 1 3" } }),
    ],
  };
  const html = compileStoryboard(plan, resolvedFor(plan));

  test("emits one sf-scene per shot with the computed start/duration", () => {
    expect((html.match(/<sf-scene/g) ?? []).length).toBe(4);
    expect(html).toContain('start="0" duration="2.50"');
    expect(html).toContain('start="2"'); // shot 2 starts at 2.0
  });

  test("camera verbs map correctly", () => {
    expect(html).toContain('verb="orbit"');
    expect(html).toContain('verb="dolly"'); // push-in
    expect(html).toContain('verb="camera-path"');
  });

  test("camera-path emits no look-at on its scene's camera (lint conflict)", () => {
    const flyScene = html.slice(html.indexOf("shot 4"));
    expect(flyScene).toContain('verb="camera-path"');
    // the path camera tag itself must not carry look-at
    const camTag = flyScene.slice(flyScene.indexOf("<sf-camera"), flyScene.indexOf("</sf-camera>"));
    expect(camTag).not.toContain("look-at");
  });

  test("each shot targets its own #m{n} model id", () => {
    expect(html).toContain('id="m1"');
    expect(html).toContain('id="m4"');
  });

  test("crossfade transitions are emitted on shots 2..n", () => {
    expect((html.match(/transition="crossfade"/g) ?? []).length).toBe(3);
  });

  test("lints with zero error-severity findings", () => {
    const findings = lintHtml(html, { fileExists: () => true });
    const errors = findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  test("metalRig clamps exposure and swaps in the metal rig", () => {
    const resolved = resolvedFor(plan).map((r, i) => (i === 1 ? { ...r, metalRig: true } : r));
    const out = compileStoryboard(plan, resolved);
    expect(out).toContain('color="#2a3040"'); // METAL_RIG hemisphere
  });

  test("no pose → no rotation attr on sf-model", () => {
    expect(html).not.toContain("rotation=");
  });

  test("defaults.pose is inherited; a per-shot pose overrides it", () => {
    const posed: Storyboard = {
      model: "m.glb",
      defaults: { pose: "90 0 90" },
      shots: [shot({}), shot({ pose: "0 45 0", camera: { type: "static", position: "0 1 5" } })],
    };
    const out = compileStoryboard(posed, resolvedFor(posed));
    expect(out).toContain('rotation="90 0 90"'); // shot 1 inherits defaults
    expect(out).toContain('rotation="0 45 0"'); // shot 2 overrides
    expect(lintHtml(out, { fileExists: () => true }).filter((f) => f.severity === "error")).toEqual([]);
  });
});
