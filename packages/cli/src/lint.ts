/**
 * `stereoframe lint` — static composition checks, no browser required.
 *
 * Regex tag scanning (the HyperFrames lint approach) keeps this dependency-
 * free; `lintHtml` is pure (filesystem access injected) so every rule is
 * unit-testable against fixture strings.
 */
import { ASSET_ATTRS, EASE_NAMES, ELEMENT_NAMES, VERB_NAMES } from "stereoframe-runtime/vocab";

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
  const tags = sfTags(html);
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
      const id = target.slice(1);
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

  return findings;
}
