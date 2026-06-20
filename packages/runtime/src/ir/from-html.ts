/**
 * Lowering front-end: a compiled three.js scene + its <sf-*> markup → SceneIR.
 *
 * Browser-side (reads three.js objects to resolve base poses and part pivots),
 * but emits pure-data SceneIR. Rest poses are read from the objects that
 * `compileScene` already built, so the IR base matches the static scene exactly
 * (including model `fit`). Part pivots are baked to plain numbers here, keeping
 * `evaluate` three.js-free.
 *
 * Phase 1 covers the verbs the de-risk example needs: turntable/float/sway
 * (behaviors) and orbit/move/dolly/zoom (timeline drivers), incl. per-part spin.
 */
import { Box3, Vector3, type Object3D } from "three";
import { collectParts, resolvePartIndex } from "../animate";
import { parseAngleDeg, parseNumber, parseSeconds, parseVec3 } from "../parse";
import type { CompiledScene } from "../scene";
import { VERB_DEFAULT_DURATION } from "../vocab";
import type { Behavior, Driver, NodeBase, SceneIR, TimelineIR, Vec3 } from "./types";

/** Window duration: the `duration` attr, else the verb's shared default. */
function durOf(el: Element, verb: string): number {
  const a = el.getAttribute("duration");
  const def = VERB_DEFAULT_DURATION[verb] ?? 0;
  return a != null && a !== "" ? parseSeconds(a, def) : def;
}

function trsOf(obj: Object3D): Pick<NodeBase, "position" | "rotation" | "scale"> {
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}

/** Center as concrete numbers (for computing orbit/dolly defaults). */
function centerVec(spec: string | null, compiled: CompiledScene): Vec3 {
  if (spec && spec.startsWith("#")) {
    const obj = compiled.objectsById.get(spec.slice(1));
    if (obj) return [obj.position.x, obj.position.y, obj.position.z];
  }
  const v = parseVec3(spec, [0, 0, 0]);
  return [v[0], v[1], v[2]];
}

/** Center as an IR reference (node id for tracking, or a literal point). */
function centerRef(spec: string | null): string | Vec3 {
  if (spec && spec.startsWith("#")) return spec.slice(1);
  const v = parseVec3(spec, [0, 0, 0]);
  return [v[0], v[1], v[2]];
}

/** Place a windowed clip at its authored start: lead with a wait when start>0. */
function placeAt(start: number, clip: TimelineIR): TimelineIR {
  return start > 0 ? { kind: "seq", children: [{ kind: "wait", duration: start }, clip] } : clip;
}

export interface Lowered {
  scene: SceneIR;
  /** id → three.js object the backend writes (camera handled separately). */
  objectMap: Map<string, Object3D>;
}

export function lowerScene(compiled: CompiledScene): Lowered {
  const nodes: NodeBase[] = [];
  const objectMap = new Map<string, Object3D>();

  nodes.push({ id: "camera", kind: "camera", ...trsOf(compiled.camera), fov: compiled.camera.fov });
  for (const [id, obj] of compiled.objectsById) {
    nodes.push({ id, kind: "model", ...trsOf(obj) });
    objectMap.set(id, obj);
  }

  const behaviors: Behavior[] = [];
  const clips: TimelineIR[] = [];
  let partCounter = 0;

  for (const el of Array.from(compiled.host.querySelectorAll("sf-animate"))) {
    const verb = (el.getAttribute("verb") ?? "").toLowerCase();
    const targetSpec = el.getAttribute("target");

    let targetId: string | null = null;
    let targetObj: Object3D | null = null;
    if (targetSpec === "camera") {
      targetId = "camera";
      targetObj = compiled.camera;
    } else if (targetSpec && targetSpec.startsWith("#")) {
      const id = targetSpec.slice(1);
      const obj = compiled.objectsById.get(id);
      if (obj) {
        targetId = id;
        targetObj = obj;
      }
    }
    if (!targetId || !targetObj) continue; // DOM-target verbs (titles) are Phase 2

    const start = parseSeconds(el.getAttribute("start"), 0);
    const ease = el.getAttribute("ease") ?? undefined;

    // Per-part: redirect motion to a synthetic node bound to a child object.
    let motionId = targetId;
    let pivot: Vec3 | undefined;
    const partAttr = el.getAttribute("part");
    if (partAttr !== null && (verb === "turntable" || verb === "sway" || verb === "float" || verb === "move")) {
      const parts = collectParts(targetObj);
      const partObj = parts[resolvePartIndex(parts, partAttr, 0)] ?? targetObj;
      if (partObj !== targetObj) {
        const pid = `${targetId}::part${partCounter++}`;
        nodes.push({ id: pid, kind: "mesh", ...trsOf(partObj) });
        objectMap.set(pid, partObj);
        motionId = pid;
        if (verb === "turntable") {
          partObj.updateWorldMatrix(true, true);
          const box = new Box3().setFromObject(partObj);
          if (!box.isEmpty()) {
            const cw = box.getCenter(new Vector3());
            if (partObj.parent) partObj.parent.worldToLocal(cw);
            pivot = [cw.x, cw.y, cw.z];
          }
        }
      }
    }

    switch (verb) {
      case "turntable":
        behaviors.push({
          kind: "turntable",
          target: motionId,
          rpm: parseNumber(el.getAttribute("rpm"), 6),
          axis: (el.getAttribute("axis") ?? "y") as "x" | "y" | "z",
          pivot,
        });
        break;
      case "float":
        behaviors.push({
          kind: "float",
          target: motionId,
          amplitude: parseNumber(el.getAttribute("amplitude"), 0.1),
          period: parseNumber(el.getAttribute("period"), 4),
        });
        break;
      case "sway":
        behaviors.push({
          kind: "sway",
          target: motionId,
          amount: (parseNumber(el.getAttribute("amount"), 6) * Math.PI) / 180,
          period: parseNumber(el.getAttribute("period"), 5),
        });
        break;
      case "orbit": {
        const duration = durOf(el, verb);
        const c = centerVec(el.getAttribute("around"), compiled);
        const cam = compiled.camera.position;
        const dx = cam.x - c[0];
        const dz = cam.z - c[2];
        const initialRadius = Math.sqrt(dx * dx + dz * dz);
        const fromDeg = parseAngleDeg(el.getAttribute("from"), (Math.atan2(dx, dz) * 180) / Math.PI);
        const driver: Driver = {
          kind: "orbit",
          target: targetId,
          around: centerRef(el.getAttribute("around")),
          radius: parseNumber(el.getAttribute("radius"), initialRadius || 5),
          fromDeg,
          toDeg: parseAngleDeg(el.getAttribute("to"), fromDeg + 360),
          height: parseNumber(el.getAttribute("height"), cam.y - c[1]),
        };
        clips.push(placeAt(start, { kind: "clip", driver, duration, ease }));
        break;
      }
      case "dolly": {
        const duration = durOf(el, verb);
        const driver: Driver = {
          kind: "dolly",
          target: targetId,
          toward: centerRef(el.getAttribute("toward")),
          distance: parseNumber(el.getAttribute("distance"), 1),
        };
        clips.push(placeAt(start, { kind: "clip", driver, duration, ease }));
        break;
      }
      case "zoom": {
        if (targetId !== "camera") break;
        const duration = durOf(el, verb);
        const fov = compiled.camera.fov;
        const driver: Driver = {
          kind: "zoom",
          target: "camera",
          from: parseAngleDeg(el.getAttribute("from"), fov),
          to: parseAngleDeg(el.getAttribute("to"), fov),
        };
        clips.push(placeAt(start, { kind: "clip", driver, duration, ease }));
        break;
      }
      case "move": {
        const toAttr = el.getAttribute("to");
        if (!toAttr) break;
        const to = parseVec3(toAttr, [0, 0, 0]);
        const fromAttr = el.getAttribute("from");
        const from = fromAttr ? parseVec3(fromAttr, [0, 0, 0]) : null;
        const duration = durOf(el, verb);
        const driver: Driver = {
          kind: "move",
          target: motionId,
          to: [to[0], to[1], to[2]],
          ...(from ? { from: [from[0], from[1], from[2]] as Vec3 } : {}),
        };
        clips.push(placeAt(start, { kind: "clip", driver, duration, ease }));
        break;
      }
      case "follow": {
        const subjSpec = el.getAttribute("subject");
        if (!subjSpec || !subjSpec.startsWith("#")) break;
        const subject = subjSpec.slice(1);
        const offAttr = el.getAttribute("offset");
        let offset: Vec3;
        if (offAttr) {
          const o = parseVec3(offAttr, [0, 2, 5]);
          offset = [o[0], o[1], o[2]];
        } else {
          // Default to the target's current offset from the subject (rest poses).
          const s = centerVec(subjSpec, compiled);
          offset = [targetObj.position.x - s[0], targetObj.position.y - s[1], targetObj.position.z - s[2]];
        }
        // Continuous: held from start for the whole shot (progress is ignored).
        clips.push(placeAt(start, { kind: "clip", driver: { kind: "follow", target: targetId, subject, offset }, duration: compiled.shot.duration }));
        break;
      }
      default:
        break; // bounce-in / path / material+clip verbs lower in Phase 2b
    }
  }

  const scene: SceneIR = {
    nodes,
    behaviors,
    duration: compiled.shot.duration,
    ...(clips.length ? { timeline: { kind: "par", children: clips } as TimelineIR } : {}),
  };
  return { scene, objectMap };
}
