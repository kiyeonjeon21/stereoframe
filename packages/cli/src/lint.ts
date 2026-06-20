/**
 * `stereoframe lint` — static composition checks, no browser required.
 *
 * Regex tag scanning (the HyperFrames lint approach) keeps this dependency-
 * free; `lintHtml` is pure (filesystem access injected) so every rule is
 * unit-testable against fixture strings.
 */
import {
  ASSET_ATTRS,
  EASE_NAMES,
  ELEMENT_NAMES,
  IR_VERB_CHANNEL,
  VERB_DEFAULT_DURATION,
  VERB_NAMES,
  VERB_REF_ATTR,
} from "stereoframe-runtime/vocab";

export interface Finding {
  rule: string;
  severity: "error" | "warning";
  message: string;
  fixHint?: string;
}

export interface LintOptions {
  /** Resolves a relative asset path against the project dir. */
  fileExists: (relPath: string) => boolean;
}

interface Tag {
  name: string;
  attrs: string;
}

function readAttr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1]! : null;
}

function sfTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const re = /<(sf-[a-z-]+)((?:\s[^>]*)?)>/gi;
  for (const m of html.matchAll(re)) {
    tags.push({ name: m[1]!.toLowerCase(), attrs: m[2] ?? "" });
  }
  return tags;
}

function inlineScripts(html: string): Array<{ attrs: string; content: string }> {
  const scripts: Array<{ attrs: string; content: string }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    scripts.push({ attrs: m[1] ?? "", content: m[2] ?? "" });
  }
  return scripts;
}

const IMPURE_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bDate\.now\s*\(/, what: "Date.now()" },
  { pattern: /\bperformance\.now\s*\(/, what: "performance.now()" },
  { pattern: /\bMath\.random\s*\(/, what: "Math.random()" },
  { pattern: /\brequestAnimationFrame\s*\(/, what: "requestAnimationFrame()" },
];

export function lintHtml(html: string, opts: LintOptions): Finding[] {
  const findings: Finding[] = [];
  // Scan markup with HTML comments removed, so `<sf-scene>` etc. mentioned inside
  // <!-- ... --> (doc comments) don't register as real elements (false positives).
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const tags = sfTags(markup);
  const scenes = tags.filter((t) => t.name === "sf-scene");
  const embed = /data-composition-id\s*=/.test(html);

  // missing_scene
  if (scenes.length === 0) {
    findings.push({
      rule: "missing_scene",
      severity: "error",
      message: "no <sf-scene> found — nothing to render.",
      fixHint: "Add an <sf-scene duration=\"<seconds>\"> root with content elements inside.",
    });
  }

  // missing_duration
  for (const scene of scenes) {
    if (!readAttr(scene.attrs, "duration") && !embed) {
      findings.push({
        rule: "missing_duration",
        severity: "error",
        message: "<sf-scene> has no duration attribute — the runtime will fall back to 5s.",
        fixHint: 'Add duration="<seconds>" to every <sf-scene>.',
      });
    }
  }

  // unknown_element
  const knownElements = new Set<string>(ELEMENT_NAMES);
  for (const tag of tags) {
    if (!knownElements.has(tag.name)) {
      findings.push({
        rule: "unknown_element",
        severity: "warning",
        message: `<${tag.name}> is not a stereoframe element (typo?).`,
        fixHint: `Known elements: ${ELEMENT_NAMES.join(", ")}.`,
      });
    }
  }

  // asset_not_found / remote_asset
  for (const tag of tags) {
    for (const attr of ASSET_ATTRS) {
      const value = readAttr(tag.attrs, attr);
      if (!value) continue;
      // `environment="room"|"studio"` are procedural, not files.
      if (attr === "environment" && (value === "room" || value === "studio")) continue;
      if (/^https?:\/\//i.test(value)) {
        findings.push({
          rule: "remote_asset",
          severity: "error",
          message: `<${tag.name} ${attr}="${value}"> fetches a remote asset — renders must be network-free.`,
          fixHint: "Download the asset into assets/ and reference it relatively.",
        });
      } else if (!value.startsWith("data:") && !opts.fileExists(value)) {
        findings.push({
          rule: "asset_not_found",
          severity: "error",
          message: `<${tag.name} ${attr}="${value}">: file not found in the project.`,
          fixHint: "Check the path, or install block assets with `stereoframe add <block>`.",
        });
      }
    }
  }

  // missing_runtime_import (standalone only — hyperframes injects its own runtime)
  if (!embed) {
    const hasImport =
      /import\s+["'][^"']*stereoframe(?:\.js)?["']/.test(html) ||
      /<script[^>]*src="[^"]*stereoframe\.js"/.test(html);
    if (!hasImport) {
      findings.push({
        rule: "missing_runtime_import",
        severity: "error",
        message: "the stereoframe runtime is never loaded — the scene will not render.",
        fixHint: 'Add <script type="module">import "./assets/stereoframe.js";</script> before </body>.',
      });
    }
  }

  // time_impurity (inline scripts incl. <script type="stereoframe">)
  for (const script of inlineScripts(html)) {
    if (/\bsrc\s*=/.test(script.attrs)) continue;
    for (const { pattern, what } of IMPURE_PATTERNS) {
      if (pattern.test(script.content)) {
        findings.push({
          rule: "time_impurity",
          severity: "error",
          message: `inline script uses ${what} — output would differ between runs/frames.`,
          fixHint:
            "Derive everything from seek time: use sf.onSeek((t) => …) and seeded data (sf-particles seed=…).",
        });
      }
    }
  }

  // sf-animate rules
  const knownVerbs = new Set<string>(VERB_NAMES);
  const knownEases = new Set<string>(EASE_NAMES);
  const animates = tags.filter((t) => t.name === "sf-animate");
  for (const el of animates) {
    const verb = (readAttr(el.attrs, "verb") ?? "").toLowerCase();
    if (verb && !knownVerbs.has(verb)) {
      findings.push({
        rule: "unknown_verb",
        severity: "error",
        message: `sf-animate verb="${verb}" is not a known verb.`,
        fixHint: `Known verbs: ${VERB_NAMES.join(", ")}.`,
      });
    }
    const ease = readAttr(el.attrs, "ease");
    if (ease && !knownEases.has(ease.trim())) {
      findings.push({
        rule: "unknown_ease",
        severity: "warning",
        message: `ease="${ease}" is not a known easing name — it will fall back to the default.`,
        fixHint: "Use GSAP-style names like power2.inOut, back.out, sine.inOut, linear.",
      });
    }
    const target = readAttr(el.attrs, "target");
    if (target?.startsWith("#")) {
      // `#model/part` paths: validate the model id (pre-`/`); the part name can't be
      // checked render-free (it lives inside the GLB).
      const id = target.slice(1).split("/")[0]!;
      if (!new RegExp(`\\bid\\s*=\\s*"${id}"`).test(html)) {
        findings.push({
          rule: "verb_target_missing",
          severity: "error",
          message: `sf-animate target="${target}" matches no element id in the document.`,
        });
      }
    }
  }

  // camera_path_lookat_conflict — scoped per scene (each sf-scene is a shot
  // with its own camera; a look-at in another shot is not a conflict).
  const sceneBlocks = html.match(/<sf-scene\b[^>]*>[\s\S]*?<\/sf-scene>/gi) ?? [];
  for (const block of sceneBlocks) {
    const blockTags = sfTags(block);
    const ahead = blockTags.some(
      (t) =>
        t.name === "sf-animate" &&
        (readAttr(t.attrs, "verb") ?? "").toLowerCase() === "camera-path" &&
        (readAttr(t.attrs, "look") ?? "ahead") !== "none",
    );
    const lookAt = blockTags.some(
      (t) => t.name === "sf-camera" && readAttr(t.attrs, "look-at") !== null,
    );
    if (ahead && lookAt) {
      findings.push({
        rule: "camera_path_lookat_conflict",
        severity: "warning",
        message:
          'camera-path look="ahead" is overridden by sf-camera look-at in the same scene (look-at is applied after path aiming).',
        fixHint: 'Remove look-at from that sf-camera, or set look="none" on the camera-path.',
      });
    }
  }

  // dom_clip_missing_class — non-sf tags with clip timing but no clip class
  const clipRe = /<(?!sf-)([a-z][a-z0-9]*)\b([^>]*\bdata-start\s*=[^>]*)>/gi;
  for (const m of html.matchAll(clipRe)) {
    const attrs = m[2] ?? "";
    const cls = readAttr(attrs, "class") ?? "";
    if (!cls.split(/\s+/).includes("clip")) {
      findings.push({
        rule: "dom_clip_missing_class",
        severity: "warning",
        message: `<${m[1]}> has data-start but no class="clip" — its visibility window will be ignored.`,
        fixHint: 'Add class="clip" so the runtime drives its visibility from seek time.',
      });
    }
  }

  // transition_gap — crossfade shots need the earlier shots to cover the fade
  const shots = scenes.map((s) => ({
    start: Number(readAttr(s.attrs, "start") ?? 0) || 0,
    duration: Number(readAttr(s.attrs, "duration") ?? 5) || 5,
    transition: (readAttr(s.attrs, "transition") ?? "cut").toLowerCase(),
    transitionDuration: Number(readAttr(s.attrs, "transition-duration") ?? 0.6) || 0.6,
  }));
  for (let i = 1; i < shots.length; i++) {
    const shot = shots[i]!;
    if (shot.transition !== "crossfade") continue;
    const priorEnd = Math.max(...shots.slice(0, i).map((p) => p.start + p.duration));
    if (priorEnd < shot.start + shot.transitionDuration - 1e-6) {
      findings.push({
        rule: "transition_gap",
        severity: "warning",
        message: `shot ${i + 1} crossfades until t=${(shot.start + shot.transitionDuration).toFixed(2)} but the previous shot ends at t=${priorEnd.toFixed(2)} — the fade will show the page background.`,
        fixHint: "Extend the previous shot's duration to cover start + transition-duration.",
      });
    }
  }

  // ── IR structural/temporal checks (the core="ir" model; render-free) ──
  // Built from the shared IR verb tables, scoped per shot, so they hold for any
  // composition. These catch authoring mistakes a render would only reveal late.
  for (const block of sceneBlocks) {
    const sceneAttrs = block.match(/<sf-scene\b([^>]*)>/i)?.[1] ?? "";
    const durAttr = readAttr(sceneAttrs, "duration");
    const sceneDur = durAttr != null ? Number(durAttr) : null;
    const channelStarts = new Map<string, number[]>(); // "target.channel" → starts

    for (const el of sfTags(block).filter((t) => t.name === "sf-animate")) {
      const verb = (readAttr(el.attrs, "verb") ?? "").toLowerCase();
      const target = readAttr(el.attrs, "target");
      const start = Number(readAttr(el.attrs, "start") ?? 0) || 0;
      const durationAttr = readAttr(el.attrs, "duration");

      // ir_dangling_ref — around/toward/subject pointing at a missing #id.
      const refAttr = VERB_REF_ATTR[verb];
      if (refAttr) {
        const ref = readAttr(el.attrs, refAttr);
        const refId = ref?.startsWith("#") ? ref.slice(1).split("/")[0]! : null;
        if (refId && !new RegExp(`\\bid\\s*=\\s*"${refId}"`).test(html)) {
          findings.push({
            rule: "ir_dangling_ref",
            severity: "warning",
            message: `sf-animate verb="${verb}" ${refAttr}="${ref}" references no element id — it resolves to the origin.`,
            fixHint: `Point ${refAttr} at an existing #id, or use explicit "x y z" coordinates.`,
          });
        }
      }

      // ir_zero_duration — a windowed verb given a non-positive duration snaps.
      const windowed = verb in VERB_DEFAULT_DURATION;
      if (windowed && durationAttr != null && Number(durationAttr) <= 0) {
        findings.push({
          rule: "ir_zero_duration",
          severity: "warning",
          message: `sf-animate verb="${verb}" duration="${durationAttr}" is not positive — it snaps instantly.`,
          fixHint: "Give the windowed verb a positive duration (seconds).",
        });
      }

      // ir_unreachable — a verb that starts at/after the shot ends never runs.
      if (sceneDur != null && sceneDur > 0 && start >= sceneDur) {
        findings.push({
          rule: "ir_unreachable",
          severity: "warning",
          message: `sf-animate verb="${verb}" start="${start}" is at/after the scene duration (${sceneDur}s) — it never runs.`,
          fixHint: "Lower start, or extend the sf-scene duration.",
        });
      }

      const channel = IR_VERB_CHANNEL[verb];
      if (channel && target) {
        const key = `${target}.${channel}`;
        const list = channelStarts.get(key);
        if (list) list.push(start);
        else channelStarts.set(key, [start]);
      }
    }

    // ir_channel_conflict — two drivers starting together on one channel are
    // order-ambiguous (the later-declared one silently wins each frame).
    for (const [key, starts] of channelStarts) {
      const seen = new Set<number>();
      const clash = starts.some((s) => (seen.has(s) ? true : (seen.add(s), false)));
      if (clash) {
        findings.push({
          rule: "ir_channel_conflict",
          severity: "warning",
          message: `two sf-animate drivers start at the same time on ${key} — their order is ambiguous.`,
          fixHint: "Stagger the starts, or target different channels/nodes.",
        });
      }
    }
  }

  // ── IR named-state checks ──
  const stateNames = new Set<string>();
  for (const m of markup.matchAll(/<sf-state\b([^>]*)>/gi)) {
    const name = readAttr(m[1] ?? "", "name");
    if (name) stateNames.add(name);
  }
  // ir_state_requires_core — <sf-state> is inert unless the scene opts into core="ir".
  for (const block of sceneBlocks) {
    if (!/<sf-state\b/i.test(block)) continue;
    const sceneAttrs = block.match(/<sf-scene\b([^>]*)>/i)?.[1] ?? "";
    if (readAttr(sceneAttrs, "core") !== "ir") {
      findings.push({
        rule: "ir_state_requires_core",
        severity: "warning",
        message: '<sf-state> is ignored by the legacy path — its <sf-scene> needs core="ir".',
        fixHint: 'Add core="ir" to the <sf-scene>.',
      });
    }
  }
  // ir_unknown_state — `to` targeting a state that was never declared.
  for (const el of animates) {
    if ((readAttr(el.attrs, "verb") ?? "").toLowerCase() !== "to") continue;
    const state = readAttr(el.attrs, "state");
    if (state && !stateNames.has(state)) {
      findings.push({
        rule: "ir_unknown_state",
        severity: "warning",
        message: `sf-animate verb="to" state="${state}" has no matching <sf-state name="${state}">.`,
        fixHint: "Define the state, or fix the name.",
      });
    }
  }

  return findings;
}
