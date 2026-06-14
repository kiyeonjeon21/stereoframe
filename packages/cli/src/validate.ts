/**
 * `stereoframe validate` — runs the composition headlessly and probes it
 * via the runtime's diagnostics protocol: load errors, per-shot sanity
 * (lights, frustum coverage, NaN transforms, black frames) and a seek
 * idempotency check (the core determinism contract).
 */
import { resolve } from "node:path";
import type { Finding } from "./lint";
import { openSession } from "./session";

interface ShotSpecWire {
  start: number;
  duration: number;
}

export interface ScreenBoundsWire {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  area: number;
}

interface SceneDiagnosticsWire {
  shot: ShotSpecWire;
  visible: boolean;
  meshCount: number;
  litMeshCount: number;
  lightCount: number;
  hasEnvironment: boolean;
  hasNaN: boolean;
  frustumCoverage: number | null;
  meanLuminance: number | null;
  backgroundLuminance: number | null;
  screenBounds: ScreenBoundsWire | null;
}

export interface ScreenMotionSample {
  t: number;
  shot: ShotSpecWire;
  bounds: ScreenBoundsWire;
}

export interface ScreenMotionSummary {
  centerShift: number;
  areaLogChange: number;
}

export function screenMotionSummary(samples: ScreenMotionSample[]): ScreenMotionSummary | null {
  if (samples.length < 2) return null;
  let centerShift = 0;
  let minArea = Number.POSITIVE_INFINITY;
  let maxArea = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!.bounds;
    minArea = Math.min(minArea, Math.max(0, a.area));
    maxArea = Math.max(maxArea, Math.max(0, a.area));
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j]!.bounds;
      centerShift = Math.max(centerShift, Math.hypot(a.cx - b.cx, a.cy - b.cy));
    }
  }
  const areaLogChange = Math.abs(Math.log((maxArea + 1e-5) / (minArea + 1e-5)));
  return { centerShift, areaLogChange };
}

export function staticFramingFinding(sceneIndex: number, samples: ScreenMotionSample[]): Finding | null {
  const first = samples[0];
  if (!first || first.shot.duration < 1.8) return null;
  const summary = screenMotionSummary(samples);
  if (!summary) return null;
  if (summary.centerShift >= 0.035 || summary.areaLogChange >= 0.08) return null;
  return {
    rule: "static_framing",
    severity: "warning",
    message: `scene ${sceneIndex + 1}: subject framing barely changes over this ${first.shot.duration.toFixed(2)}s shot (center shift ${summary.centerShift.toFixed(3)}, size change ${summary.areaLogChange.toFixed(3)}).`,
    fixHint: "Add a camera dolly/orbit/path, subtle secondary motion, or vary FOV/framing so the 3D result feels directed.",
  };
}

export async function validateProject(projectDir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  let session;
  try {
    session = await openSession(resolve(projectDir));
  } catch (err) {
    return [
      {
        rule: "runtime_not_ready",
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  try {
    const { page, info, errors } = session;

    for (const message of errors) {
      findings.push({ rule: "page_error", severity: "error", message });
    }
    if (!(info.duration > 0)) {
      findings.push({
        rule: "zero_duration",
        severity: "error",
        message: "composition reported zero duration.",
        fixHint: 'Set duration="<seconds>" on <sf-scene>.',
      });
      return findings;
    }

    // Sample each shot near its head, middle, and tail.
    const shots = (await page.evaluate(
      "window.__stereoframe.scenes.map(s => ({ start: s.shot.start, duration: s.shot.duration }))",
    )) as ShotSpecWire[];
    const sampleTimes = new Set<number>();
    for (const shot of shots) {
      const end = Math.min(shot.start + shot.duration, info.duration);
      sampleTimes.add(Math.min(shot.start + 0.05, end));
      sampleTimes.add(shot.start + (end - shot.start) / 2);
      sampleTimes.add(Math.max(shot.start, end - 0.05));
    }

    const motionSamples = new Map<number, ScreenMotionSample[]>();
    for (const t of [...sampleTimes].sort((a, b) => a - b)) {
      const all = (await page.evaluate(
        `window.__stereoframe.diagnostics(${t})`,
      )) as SceneDiagnosticsWire[];
      for (let i = 0; i < all.length; i++) {
        const d = all[i]!;
        if (!d.visible) continue;
        if (d.screenBounds) {
          const samples = motionSamples.get(i) ?? [];
          samples.push({ t, shot: d.shot, bounds: d.screenBounds });
          motionSamples.set(i, samples);
        }
        const where = `scene ${i + 1} at t=${t.toFixed(2)}s`;
        if (d.hasNaN) {
          findings.push({
            rule: "nan_transform",
            severity: "error",
            message: `${where}: NaN in object/camera transforms — a verb parameter is probably malformed.`,
          });
        }
        if (d.litMeshCount > 0 && d.lightCount === 0 && !d.hasEnvironment) {
          findings.push({
            rule: "unlit_scene",
            severity: "warning",
            message: `${where}: ${d.litMeshCount} standard-material mesh(es) but no lights and no environment — they will render black.`,
            fixHint: 'Add <sf-light preset="studio"> or an environment HDRI.',
          });
        }
        if (d.frustumCoverage === 0) {
          findings.push({
            rule: "all_offscreen",
            severity: "warning",
            message: `${where}: no object intersects the camera frustum — the frame is empty.`,
            fixHint: "Check camera position/look-at and object positions.",
          });
        }
        if (d.meanLuminance !== null && d.meanLuminance < 0.008 && d.meshCount > 0) {
          findings.push({
            rule: "black_frame",
            severity: "warning",
            message: `${where}: rendered frame is nearly black (mean luminance ${(d.meanLuminance * 255).toFixed(1)}/255).`,
            fixHint: "Likely unlit content, an offscreen subject, or an asset that failed to apply.",
          });
        }
        if (
          d.meanLuminance !== null &&
          d.backgroundLuminance !== null &&
          d.meshCount > 0 &&
          d.meanLuminance > 0.008 && // not the black-frame case
          Math.abs(d.meanLuminance - d.backgroundLuminance) < 0.06
        ) {
          findings.push({
            rule: "subject_bg_low_contrast",
            severity: "warning",
            message: `${where}: subject blends into the background (mean ${(d.meanLuminance * 255).toFixed(0)}/255 vs background ${(d.backgroundLuminance * 255).toFixed(0)}/255) — it may be hard to see.`,
            fixHint:
              "Separate the subject from the background: a rim/back light, more exposure/fill, or a lighter (or darker) background.",
          });
        }
      }
    }
    for (const [i, samples] of motionSamples) {
      const finding = staticFramingFinding(i, samples);
      if (finding) findings.push(finding);
    }

    // Forward-only scenes opt out of seek-idempotency by design (live sim /
    // accumulation). Detect them, warn that random-access seek is waived, and
    // require each to be a solo full-timeline scene (forward + multi-shot is
    // unsupported — bake it instead). The idempotency probe is then skipped.
    const sceneInfo = (await page.evaluate(
      "window.__stereoframe.scenes.map(s => ({ forward: !!s.forward, start: s.shot.start, duration: s.shot.duration }))",
    )) as Array<{ forward: boolean; start: number; duration: number }>;
    const forwardScenes = sceneInfo.filter((s) => s.forward);
    if (forwardScenes.length > 0) {
      findings.push({
        rule: "forward_only_scene",
        severity: "warning",
        message:
          "forward-only scene present — seek-idempotency is intentionally waived; random-access seek/scrub is unavailable and frames are correct only under the monotonic render loop.",
        fixHint: "Bake the sim (`stereoframe bake`) for a seekable, multi-shot-safe asset.",
      });
      for (const f of forwardScenes) {
        const soloFull =
          sceneInfo.length === 1 && f.start <= 0.001 && f.duration >= info.duration - 0.001;
        if (!soloFull) {
          findings.push({
            rule: "forward_multishot_unsupported",
            severity: "error",
            message:
              "a forward-only scene must be the only scene and span the whole timeline (start=0, full duration); forward + multi-shot/windowing isn't supported.",
            fixHint: "Make it the sole scene, or bake the sim and use the seekable result in multi-shot.",
          });
        }
      }
    }

    if (forwardScenes.length === sceneInfo.length && forwardScenes.length > 0) {
      return findings; // all-forward: no meaningful idempotency probe
    }

    // Seek-idempotency probe: seek mid → elsewhere → mid. The frame must be a
    // pure function of t WITHIN a render — that's the seekability contract,
    // and what makes frame-by-frame capture coherent. Same t = same draw
    // calls = same pixels, so rich shaders / high poly / sin-noise all pass;
    // only genuine history-dependence (accumulated state, trails, unseeded
    // randomness) breaks it. Cross-RUN bit-identity is NOT required.
    // (canvasFingerprint skips forward-scene canvases, so mixed scenes still
    // probe their pure scenes.)
    const mid = info.duration / 2;
    const first = await page.evaluate(`window.__stereoframe.fingerprint(${mid})`);
    await page.evaluate(`window.__stereoframe.seek(0)`);
    const second = await page.evaluate(`window.__stereoframe.fingerprint(${mid})`);
    if (first !== second) {
      findings.push({
        rule: "non_idempotent_seek",
        severity: "error",
        message: `seeking t=${mid.toFixed(2)} twice produced a different frame — some state is not a pure function of seek time, so capture would glitch.`,
        fixHint:
          "Look for accumulated state, trails, wall-clock reads, or unseeded randomness in escape-hatch code.",
      });
    }

    return findings;
  } finally {
    await session.close();
  }
}
