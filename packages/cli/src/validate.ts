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

    for (const t of [...sampleTimes].sort((a, b) => a - b)) {
      const all = (await page.evaluate(
        `window.__stereoframe.diagnostics(${t})`,
      )) as SceneDiagnosticsWire[];
      for (let i = 0; i < all.length; i++) {
        const d = all[i]!;
        if (!d.visible) continue;
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
      }
    }

    // Seek-idempotency probe: seek mid → elsewhere → mid. The frame must be a
    // pure function of t WITHIN a render — that's the seekability contract,
    // and what makes frame-by-frame capture coherent. Same t = same draw
    // calls = same pixels, so rich shaders / high poly / sin-noise all pass;
    // only genuine history-dependence (accumulated state, trails, unseeded
    // randomness) breaks it. Cross-RUN bit-identity is NOT required.
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
