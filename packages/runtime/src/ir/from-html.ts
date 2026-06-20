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
import { Box3, Light, Mesh, MeshStandardMaterial, Vector3, type Object3D } from "three";
import { collectParts, resolvePartIndex } from "../animate";
import { parseAngleDeg, parseColorString, parseNumber, parseRotationRad, parseScale, parseSeconds, parseVec3 } from "../parse";
import type { CompiledScene } from "../scene";
import { VERB_DEFAULT_DURATION } from "../vocab";
import type { Behavior, Driver, LightState, MaterialState, NodeBase, SceneIR, StateOverride, TimelineIR, Vec3 } from "./types";

/** First standard material under an object → its base color/roughness/metalness. */
function baseMaterialOf(obj: Object3D, nameFilter?: string): MaterialState | undefined {
  let found: MeshStandardMaterial | undefined;
  obj.traverse((child) => {
    if (found) return;
    const m = (child as Mesh).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (mat instanceof MeshStandardMaterial && (!nameFilter || mat.name === nameFilter)) {
        found = mat;
        break;
      }
    }
  });
  return found ? { color: `#${found.color.getHexString()}`, roughness: found.roughness, metalness: found.metalness } : undefined;
}

/** A light's base intensity + color (for threading light-state `from`). */
function baseLightOf(obj: Object3D): LightState | undefined {
  if (!(obj instanceof Light)) return undefined;
  return { intensity: obj.intensity, color: `#${obj.color.getHexString()}` };
}

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
  const variantEls: Element[] = [];
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
      case "bounce-in": {
        // Scale-in entrance (whole object). Default ease back.out, like legacy.
        const ease2 = el.getAttribute("ease") ?? "back.out";
        clips.push(placeAt(start, { kind: "clip", driver: { kind: "bounce-in", target: targetId }, duration: durOf(el, verb), ease: ease2 }));
        break;
      }
      case "fade-in": {
        // Opacity 0→1 entrance on a 3D object (DOM-target fade-in stays in legacy).
        clips.push(placeAt(start, { kind: "clip", driver: { kind: "fade-in", target: targetId }, duration: durOf(el, verb), ease }));
        break;
      }
      case "variant":
        variantEls.push(el); // chained after the loop (from = previous link's to)
        break;
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

  // Variant chains: group by target + material filter, capture the base material
  // from three.js, then thread links so each one's `from` is the previous `to`
  // (continuous configurator transitions). The held model gives "latest active
  // wins, base before the first" for free.
  const variantGroups = new Map<string, Element[]>();
  for (const el of variantEls) {
    const key = `${el.getAttribute("target") ?? ""}|${el.getAttribute("material") ?? "*"}`;
    const list = variantGroups.get(key);
    if (list) list.push(el);
    else variantGroups.set(key, [el]);
  }
  for (const els of variantGroups.values()) {
    const targetSpec = els[0]!.getAttribute("target");
    if (!targetSpec || !targetSpec.startsWith("#")) continue;
    const targetId = targetSpec.slice(1);
    const obj = compiled.objectsById.get(targetId);
    if (!obj) continue;
    const nameFilter = els[0]!.getAttribute("material") ?? undefined;
    let baseMat: MeshStandardMaterial | undefined;
    obj.traverse((child) => {
      if (baseMat) return;
      const m = (child as Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        if (mat instanceof MeshStandardMaterial && (!nameFilter || mat.name === nameFilter)) {
          baseMat = mat;
          break;
        }
      }
    });
    if (!baseMat) continue;
    let from: MaterialState = {
      color: `#${baseMat.color.getHexString()}`,
      roughness: baseMat.roughness,
      metalness: baseMat.metalness,
    };
    const sorted = [...els].sort(
      (a, b) => parseSeconds(a.getAttribute("start"), 0) - parseSeconds(b.getAttribute("start"), 0),
    );
    for (const el of sorted) {
      const to: MaterialState = {
        color: el.getAttribute("color") ? parseColorString(el.getAttribute("color"), "#ffffff") : from.color,
        roughness: el.getAttribute("roughness") != null ? parseNumber(el.getAttribute("roughness"), 0.5) : from.roughness,
        metalness: el.getAttribute("metalness") != null ? parseNumber(el.getAttribute("metalness"), 0) : from.metalness,
      };
      const driver: Driver = { kind: "variant", target: targetId, ...(nameFilter ? { materialName: nameFilter } : {}), from, to };
      clips.push(
        placeAt(parseSeconds(el.getAttribute("start"), 0), {
          kind: "clip",
          driver,
          duration: durOf(el, "variant"),
          ease: el.getAttribute("ease") ?? undefined,
        }),
      );
      from = to;
    }
  }

  // Named states: <sf-state name><sf-set target …/></sf-state> declare sparse
  // per-node overrides; `initial` + each `to` transition chain (from = previous
  // state's value), lowered to per-channel tween (transform) + variant (material)
  // segments that the held model resolves ("latest active state wins").
  const stateDefs = new Map<string, Map<string, StateOverride>>();
  for (const stateEl of Array.from(compiled.host.querySelectorAll("sf-state"))) {
    const name = stateEl.getAttribute("name");
    if (!name) continue;
    const overrides = new Map<string, StateOverride>();
    for (const setEl of Array.from(stateEl.querySelectorAll("sf-set"))) {
      const t = setEl.getAttribute("target");
      if (!t || !t.startsWith("#")) continue;
      const o: StateOverride = overrides.get(t.slice(1)) ?? {};
      if (setEl.getAttribute("position")) o.position = parseVec3(setEl.getAttribute("position"), [0, 0, 0]);
      if (setEl.getAttribute("rotation")) o.rotation = parseRotationRad(setEl.getAttribute("rotation"));
      if (setEl.getAttribute("scale")) o.scale = parseScale(setEl.getAttribute("scale"));
      if (setEl.getAttribute("color")) o.color = parseColorString(setEl.getAttribute("color"), "#ffffff");
      if (setEl.getAttribute("roughness")) o.roughness = parseNumber(setEl.getAttribute("roughness"), 0.5);
      if (setEl.getAttribute("metalness")) o.metalness = parseNumber(setEl.getAttribute("metalness"), 0);
      if (setEl.getAttribute("intensity")) o.intensity = parseNumber(setEl.getAttribute("intensity"), 1);
      overrides.set(t.slice(1), o);
    }
    stateDefs.set(name, overrides);
  }

  if (stateDefs.size) {
    // Transition sequence: an instant set to `initial` at t=0 (if any), then each
    // `to` transition sorted by start.
    const transitions: Array<{ t: number; dur: number; ease?: string; state: string }> = [];
    const initial = compiled.host.getAttribute("initial");
    if (initial && stateDefs.has(initial)) transitions.push({ t: 0, dur: 0, state: initial });
    for (const el of Array.from(compiled.host.querySelectorAll('sf-animate[verb="to"]'))) {
      const state = el.getAttribute("state");
      if (!state || !stateDefs.has(state)) continue;
      transitions.push({ t: parseSeconds(el.getAttribute("start"), 0), dur: durOf(el, "to"), ease: el.getAttribute("ease") ?? undefined, state });
    }
    transitions.sort((a, b) => a.t - b.t);

    // Per-node current value of each channel (rest until a state sets it).
    const cur = new Map<string, StateOverride>();
    for (const tr of transitions) {
      const ov = stateDefs.get(tr.state)!;
      for (const [id, o] of ov) {
        const obj = objectMap.get(id);
        if (!obj) continue;
        const c = cur.get(id) ?? {};
        const rest = trsOf(obj);
        for (const ch of ["position", "rotation", "scale"] as const) {
          const to = o[ch];
          if (!to) continue;
          const from = c[ch] ?? rest[ch];
          clips.push(placeAt(tr.t, { kind: "clip", driver: { kind: "tween", target: id, channel: ch, from, to }, duration: tr.dur, ease: tr.ease }));
          c[ch] = to;
        }
        if (obj instanceof Light) {
          // Light state (intensity/color) → light-tween, chained via `cur`.
          if (o.intensity != null || o.color != null) {
            const base = baseLightOf(obj) ?? {};
            const from: LightState = { intensity: c.intensity ?? base.intensity, color: c.color ?? base.color };
            const to: LightState = { intensity: o.intensity ?? from.intensity, color: o.color ?? from.color };
            clips.push(placeAt(tr.t, { kind: "clip", driver: { kind: "light-tween", target: id, from, to }, duration: tr.dur, ease: tr.ease }));
            c.intensity = to.intensity;
            c.color = to.color;
          }
        } else if (o.color != null || o.roughness != null || o.metalness != null) {
          const baseMat = baseMaterialOf(obj) ?? {};
          const from: MaterialState = { color: c.color ?? baseMat.color, roughness: c.roughness ?? baseMat.roughness, metalness: c.metalness ?? baseMat.metalness };
          const to: MaterialState = { color: o.color ?? from.color, roughness: o.roughness ?? from.roughness, metalness: o.metalness ?? from.metalness };
          clips.push(placeAt(tr.t, { kind: "clip", driver: { kind: "variant", target: id, from, to }, duration: tr.dur, ease: tr.ease }));
          c.color = to.color;
          c.roughness = to.roughness;
          c.metalness = to.metalness;
        }
        cur.set(id, c);
      }
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
