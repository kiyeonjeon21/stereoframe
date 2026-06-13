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

describe("rich schema (backdrop / atmosphere / secondaryMotion / flythrough / text tiers)", () => {
  const richShot = (p: Partial<Shot>): Shot => shot(p);

  test("backdrop emits a tinted fullscreen shader; 'none' and absent emit none", () => {
    const withBd: Storyboard = { model: "m.glb", shots: [richShot({ backdrop: { coldGlow: "#0a3550", warmGlow: "#2a0a1e" } })] };
    const out = compileStoryboard(withBd, resolvedFor(withBd));
    expect(out).toContain("<sf-shader fullscreen");
    expect(out).toContain('u-cold-glow="#0a3550"');
    expect(out).toContain('u-warm-glow="#2a0a1e"');

    const none: Storyboard = { model: "m.glb", shots: [richShot({ backdrop: "none" })] };
    expect(compileStoryboard(none, resolvedFor(none))).not.toContain("<sf-shader");

    const absent: Storyboard = { model: "m.glb", shots: [richShot({})] };
    expect(compileStoryboard(absent, resolvedFor(absent))).not.toContain("<sf-shader");
  });

  test("atmosphere emits particles, and is DROPPED (with a warning) on a crossfade-outgoing shot", () => {
    // shot 1 is followed by a crossfade → it's the outgoing half → drop + warn.
    const plan: Storyboard = {
      model: "m.glb",
      shots: [
        richShot({ atmosphere: "dust" }),
        richShot({ atmosphere: "dust", transition: "crossfade", camera: { type: "static", position: "0 1 5" } }),
      ],
    };
    const warnings: string[] = [];
    const out = compileStoryboard(plan, resolvedFor(plan), { warn: (m) => warnings.push(m) });
    // shot 2 is the last shot → particles kept; shot 1 → dropped.
    expect((out.match(/<sf-particles/g) ?? []).length).toBe(1);
    expect(warnings.some((w) => /atmosphere dropped/.test(w))).toBe(true);
  });

  test("secondaryMotion layers turntable + sway + float on the model", () => {
    const plan: Storyboard = { model: "m.glb", shots: [richShot({ secondaryMotion: { spin: 2, sway: 1.5, float: 0.1 } })] };
    const out = compileStoryboard(plan, resolvedFor(plan));
    expect(out).toContain('verb="turntable" rpm="2"');
    expect(out).toContain('verb="sway" amount="1.50"');
    expect(out).toContain('verb="float" amplitude="0.10"');
  });

  test("flythrough camera emits camera-path look=none + a locked sf-camera look-at, lint-clean", () => {
    const plan: Storyboard = {
      model: "m.glb",
      shots: [richShot({ camera: { type: "flythrough", points: "2 1 3, 0 1 3, -2 1 2", lookAt: "0 0.5 0" } })],
    };
    const out = compileStoryboard(plan, resolvedFor(plan));
    expect(out).toContain('verb="camera-path" look="none"');
    expect(out).toContain('look-at="0 0.5 0"');
    expect(lintHtml(out, { fileExists: () => true }).filter((f) => f.severity === "error")).toEqual([]);
  });

  test("three text tiers (title/subtitle/spec) emit three staggered clips", () => {
    const plan: Storyboard = {
      model: "m.glb",
      shots: [richShot({ duration: 4, text: { title: "APEX", subtitle: "in motion", spec: "1020 bhp" } })],
    };
    const out = compileStoryboard(plan, resolvedFor(plan));
    expect(out).toContain(">APEX</div>");
    expect(out).toContain(">in motion</div>");
    expect(out).toContain(">1020 bhp</div>");
    expect((out.match(/class="clip"/g) ?? []).length).toBe(3);
  });

  test("flythrough/dust validation: flythrough needs points; bad atmosphere errors", () => {
    expect(validateStoryboard({ model: "m.glb", shots: [shot({ camera: { type: "flythrough" } })] }).some((e) => /needs points/.test(e))).toBe(true);
    // @ts-expect-error intentionally invalid
    expect(validateStoryboard({ model: "m.glb", shots: [shot({ atmosphere: "fog" })] }).some((e) => /atmosphere/.test(e))).toBe(true);
  });

  test("a fully-loaded rich plan compiles with zero lint errors", () => {
    const plan: Storyboard = {
      model: "m.glb",
      defaults: { backdrop: { coldGlow: "#0a3550", warmGlow: "#2a0a1e" }, secondaryMotion: { spin: 1.5, sway: 1 }, finish: { samples: 2, ground: "contact-shadow" } },
      shots: [
        richShot({ name: "open", duration: 3, atmosphere: "dust", camera: { type: "push-in", position: "3 0.5 3.5", lookAt: "0 0.4 0", toward: "0 0.4 0", distance: 0.5 } }),
        richShot({ name: "fly", duration: 3, camera: { type: "flythrough", points: "2.8 0.4 2.8, 0 0.5 3.2, -2.6 0.6 1.6", lookAt: "0 0.45 0" } }),
        richShot({ name: "hero", duration: 4, transition: "crossfade", atmosphere: "dust", camera: { type: "hero", radius: 5, from: 18, to: -14, height: 0.2 }, text: { title: "APEX", subtitle: "in motion", spec: "1020 bhp" } }),
      ],
    };
    const out = compileStoryboard(plan, resolvedFor(plan));
    expect(lintHtml(out, { fileExists: () => true }).filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("floor", () => {
  test('floor "road" emits a flat dark ground plane; "none"/absent emit none', () => {
    const road: Storyboard = { model: "m.glb", shots: [shot({ floor: "road" })] };
    const out = compileStoryboard(road, resolvedFor(road));
    expect(out).toContain('<sf-mesh geometry="plane"');
    expect(out).toContain('rotation="-90 0 0"');
    expect(lintHtml(out, { fileExists: () => true }).filter((f) => f.severity === "error")).toEqual([]);

    const none: Storyboard = { model: "m.glb", shots: [shot({ floor: "none" })] };
    expect(compileStoryboard(none, resolvedFor(none))).not.toContain('geometry="plane"');
    const absent: Storyboard = { model: "m.glb", shots: [shot({})] };
    expect(compileStoryboard(absent, resolvedFor(absent))).not.toContain('geometry="plane"');
  });

  test("bad floor string is a validation error", () => {
    // @ts-expect-error intentionally invalid
    expect(validateStoryboard({ model: "m.glb", shots: [shot({ floor: "grass" })] }).some((e) => /floor/.test(e))).toBe(true);
  });
});
