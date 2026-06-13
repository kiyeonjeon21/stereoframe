/**
 * DOM binding layer for <sf-animate>: parses attributes, resolves targets
 * inside the compiled scene, and registers pure writers from verbs.ts.
 *
 * Verb vocabulary (v0):
 *   turntable  — continuous spin            (rpm, axis)
 *   orbit      — arc around a point/object  (around, radius, from, to, height)
 *   dolly      — move toward a point/object (toward, distance)
 *   bounce-in  — scale-in entrance          (default ease back.out)
 *   fade-in    — material opacity ramp
 *   float      — sinusoidal bob on Y        (amplitude, period)
 */
import {
  Box3,
  CatmullRomCurve3,
  Color,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Vector3,
  type Object3D,
} from "three";
import type { CompiledScene } from "./scene";
import { parseAngleDeg, parseColorString, parseNumber, parseSeconds, parseVec3 } from "./parse";
import * as verbs from "./verbs";
import type { XYZ } from "./verbs";

const _world = new Vector3();

/**
 * The parts of a loaded model to explode: descend through single-child
 * wrapper nodes, then return the shallowest level that branches into
 * multiple children (the natural component boundary).
 */
function collectParts(root: Object3D): Object3D[] {
  let node = root;
  while (node.children.length === 1) node = node.children[0]!;
  return node.children.length > 1 ? [...node.children] : [node];
}

function resolveTarget(compiled: CompiledScene, spec: string | null): Object3D | null {
  if (!spec) return null;
  if (spec === "camera") return compiled.camera;
  if (spec.startsWith("#")) return compiled.objectsById.get(spec.slice(1)) ?? null;
  return null;
}

/** A center/toward spec: "#id" tracks the object, "x y z" is a fixed point. */
function resolvePoint(compiled: CompiledScene, spec: string | null): () => XYZ {
  if (spec && spec.startsWith("#")) {
    const obj = compiled.objectsById.get(spec.slice(1));
    if (obj) {
      return () => {
        obj.getWorldPosition(_world);
        return { x: _world.x, y: _world.y, z: _world.z };
      };
    }
  }
  const fixed = parseVec3(spec, [0, 0, 0]);
  return () => ({ x: fixed[0], y: fixed[1], z: fixed[2] });
}

interface MaterialState {
  material: Material;
  baseOpacity: number;
  baseTransparent: boolean;
}

function makeOpacitySetter(obj: Object3D): (factor: number) => void {
  const states: MaterialState[] = [];
  const seen = new Set<Material>();
  obj.traverse((child) => {
    const material = (child as Mesh).material;
    const list = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of list) {
      if (seen.has(m)) continue;
      seen.add(m);
      states.push({ material: m, baseOpacity: m.opacity, baseTransparent: m.transparent });
    }
  });
  return (factor) => {
    for (const s of states) {
      s.material.opacity = s.baseOpacity * factor;
      s.material.transparent = factor < 1 ? true : s.baseTransparent;
    }
  };
}

export function compileAnimations(compiled: CompiledScene): void {
  const variantEls: Array<{ el: Element; timing: verbs.VerbTiming }> = [];
  for (const el of Array.from(compiled.host.querySelectorAll("sf-animate"))) {
    const verb = (el.getAttribute("verb") ?? "").toLowerCase();

    // Window verbs get a sensible default duration; continuous verbs
    // (turntable, float, follow) stay duration-less.
    const DEFAULT_DURATIONS: Record<string, number> = {
      "orbit": 4,
      "dolly": 1.5,
      "bounce-in": 0.6,
      "fade-in": 0.6,
      "move": 2,
      "crossfade-clip": 0.5,
      "camera-path": 8,
      "variant": 0.8,
      "explode": 2.5,
      "isolate": 0.8,
    };
    // Verb timing uses bare start/duration attributes (seconds) — data-start/
    // data-duration are HyperFrames *clip* timing and would trip its linter.
    const durationAttr = el.getAttribute("duration");
    const timing = verbs.makeTiming({
      start: parseSeconds(el.getAttribute("start"), 0),
      duration: durationAttr
        ? parseSeconds(durationAttr, 0)
        : (DEFAULT_DURATIONS[verb] ?? null),
      ease: el.getAttribute("ease"),
      defaultEase: verb === "bounce-in" ? "back.out" : "power1.out",
    });

    if (verb === "variant") {
      // Collected and compiled as ordered chains after this loop.
      variantEls.push({ el, timing });
      continue;
    }

    const target = resolveTarget(compiled, el.getAttribute("target"));
    if (!target) {
      // DOM fallback: `#id` matching a page element gets entrance verbs
      // driven through inline styles (titles/overlays in standalone mode).
      const spec = el.getAttribute("target") ?? "";
      const domEl = spec.startsWith("#")
        ? document.querySelector<HTMLElement>(spec)
        : null;
      if (domEl && (verb === "fade-in" || verb === "bounce-in")) {
        const rise = parseNumber(el.getAttribute("rise"), 0);
        compiled.seekFns.push(
          verbs.fadeIn((f) => {
            if (verb === "fade-in") {
              domEl.style.opacity = String(f);
              if (rise !== 0) domEl.style.transform = `translateY(${(1 - f) * rise}px)`;
            } else {
              domEl.style.opacity = f > 0 ? "1" : "0";
              domEl.style.transform = `scale(${f})`;
            }
          }, timing),
        );
      }
      continue;
    }

    if (verb === "turntable") {
      compiled.seekFns.push(
        verbs.turntable(target, timing, {
          rpm: parseNumber(el.getAttribute("rpm"), 6),
          axis: (el.getAttribute("axis") ?? "y") as "x" | "y" | "z",
        }),
      );
    } else if (verb === "orbit") {
      const center = resolvePoint(compiled, el.getAttribute("around"));
      const c = center();
      const dx = target.position.x - c.x;
      const dz = target.position.z - c.z;
      const initialRadius = Math.sqrt(dx * dx + dz * dz);
      const initialAzimuthDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
      const fromDeg = parseAngleDeg(el.getAttribute("from"), initialAzimuthDeg);
      compiled.seekFns.push(
        verbs.orbit(target, timing, {
          center,
          radius: parseNumber(el.getAttribute("radius"), initialRadius || 5),
          fromDeg,
          toDeg: parseAngleDeg(el.getAttribute("to"), fromDeg + 360),
          height: parseNumber(el.getAttribute("height"), target.position.y - c.y),
        }),
      );
    } else if (verb === "dolly") {
      compiled.seekFns.push(
        verbs.dolly(target, timing, {
          toward: resolvePoint(compiled, el.getAttribute("toward")),
          distance: parseNumber(el.getAttribute("distance"), 1),
        }),
      );
    } else if (verb === "move") {
      const toAttr = el.getAttribute("to");
      if (!toAttr) continue;
      const to = parseVec3(toAttr, [0, 0, 0]);
      const fromAttr = el.getAttribute("from");
      const from = fromAttr ? parseVec3(fromAttr, [0, 0, 0]) : null;
      compiled.seekFns.push(
        verbs.move(target, timing, {
          from: from ? { x: from[0], y: from[1], z: from[2] } : undefined,
          to: { x: to[0], y: to[1], z: to[2] },
        }),
      );
    } else if (verb === "follow") {
      const subject = resolvePoint(compiled, el.getAttribute("subject"));
      const offsetAttr = el.getAttribute("offset");
      let offset: { x: number; y: number; z: number };
      if (offsetAttr) {
        const o = parseVec3(offsetAttr, [0, 2, 5]);
        offset = { x: o[0], y: o[1], z: o[2] };
      } else {
        const s = subject();
        offset = {
          x: target.position.x - s.x,
          y: target.position.y - s.y,
          z: target.position.z - s.z,
        };
      }
      // Late pass: the subject's own writers must run first each seek.
      compiled.lateSeekFns.push(verbs.follow(target, { subject, offset }));
    } else if (verb === "camera-path") {
      // Catmull-Rom flythrough. `points` = comma-separated "x y z" waypoints.
      // look="ahead" (default) aims along the path; "none" leaves aiming to
      // sf-camera's look-at. Arc-length parameterized → constant speed in
      // space, eased in time. Runs in the late pass so it wins over other
      // position writers.
      const waypoints = (el.getAttribute("points") ?? "")
        .split(",")
        .map((chunk) => parseVec3(chunk.trim(), [Number.NaN, Number.NaN, Number.NaN]))
        .filter((p) => p.every(Number.isFinite))
        .map((p) => new Vector3(p[0], p[1], p[2]));
      if (waypoints.length < 2) continue;
      const curve = new CatmullRomCurve3(waypoints, false, "centripetal");
      const lookMode = (el.getAttribute("look") ?? "ahead").toLowerCase();
      const pos = new Vector3();
      const ahead = new Vector3();
      compiled.lateSeekFns.push((t) => {
        const p = verbs.easedProgress(t, timing);
        curve.getPointAt(Math.min(1, Math.max(0, p)), pos);
        target.position.set(pos.x, pos.y, pos.z);
        if (lookMode === "ahead") {
          curve.getPointAt(Math.min(1, Math.max(0, p) + 0.02), ahead);
          // At the path's very end, keep looking forward along the last segment.
          if (ahead.distanceToSquared(pos) < 1e-9) {
            curve.getPointAt(Math.max(0, p - 0.02), ahead);
            ahead.lerpVectors(ahead, pos, 2);
          }
          (target as Object3D).lookAt(ahead);
        }
      });
    } else if (verb === "crossfade-clip") {
      const actions = compiled.actionsByObject.get(target);
      const fromName = el.getAttribute("from");
      const toName = el.getAttribute("to");
      if (!actions || !fromName || !toName) continue;
      const fromAction = actions.get(fromName);
      const toAction = actions.get(toName);
      if (!fromAction || !toAction) continue;
      compiled.seekFns.push(
        verbs.crossfadeClips((fw, tw) => {
          fromAction.setEffectiveWeight(fw);
          toAction.setEffectiveWeight(tw);
        }, timing),
      );
    } else if (verb === "bounce-in") {
      compiled.seekFns.push(verbs.bounceIn(target, timing));
    } else if (verb === "fade-in") {
      compiled.seekFns.push(verbs.fadeIn(makeOpacitySetter(target), timing));
    } else if (verb === "float") {
      compiled.seekFns.push(
        verbs.float(target, timing, {
          amplitude: parseNumber(el.getAttribute("amplitude"), 0.1),
          period: parseNumber(el.getAttribute("period"), 4),
        }),
      );
    } else if (verb === "sway") {
      compiled.seekFns.push(
        verbs.sway(target, timing, {
          amount: (parseNumber(el.getAttribute("amount"), 6) * Math.PI) / 180,
          period: parseNumber(el.getAttribute("period"), 5),
        }),
      );
    } else if (verb === "explode") {
      // Separate a loaded model's parts outward from its center — the
      // classic exploded-view product reveal. Runs after assets are ready
      // (compileAnimations is called post-load), so the GLB's child nodes
      // exist. Parts move along their direction-from-center as a pure
      // function of t. Needs a multi-part model (single-mesh = no effect).
      const parts = collectParts(target);
      if (parts.length <= 1) continue; // single-mesh model — nothing to explode
      const modelCenter = new Box3().setFromObject(target).getCenter(new Vector3());
      const distance = parseNumber(el.getAttribute("distance"), 1.5);
      const movers = parts.map((part) => {
        const base = part.position.clone();
        const dir = new Box3().setFromObject(part).getCenter(new Vector3()).sub(modelCenter);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        return { part, base, dir: dir.normalize() };
      });
      const tmp = new Vector3();
      compiled.seekFns.push((t) => {
        const p = verbs.easedProgress(t, timing);
        for (const m of movers) {
          m.part.position.copy(m.base).add(tmp.copy(m.dir).multiplyScalar(distance * p));
        }
      });
    } else if (verb === "isolate") {
      // Feature highlight: dim every part except the chosen one, so the eye
      // goes to it (the "detail section" beat). Needs a multi-part model.
      const parts = collectParts(target);
      if (parts.length <= 1) continue;
      const targetIdx = Math.max(
        0,
        Math.min(parts.length - 1, Math.round(parseNumber(el.getAttribute("part"), 0))),
      );
      // `dim=1` fully blacks out the rest. Default 0.85 leaves a faint ghost.
      const dim = Math.min(1, parseNumber(el.getAttribute("dim"), 0.85));
      interface DimState {
        mat: MeshStandardMaterial;
        color: Color;
        env: number;
        emissive: Color | null;
        emissiveIntensity: number;
        // MeshPhysicalMaterial extras: sheen (fabric) and specular reflect
        // independently of base color, so dimming `color` alone leaves a lit
        // ghost (e.g. ToyCar's sheen-red cloth). Capture them when present.
        phys: MeshPhysicalMaterial | null;
        sheen: number;
        sheenColor: Color | null;
        specularIntensity: number;
        specularColor: Color | null;
        clearcoat: number;
      }
      const mats: DimState[] = [];
      const seen = new Set<Material>();
      parts.forEach((part, i) => {
        if (i === targetIdx) return;
        part.traverse((o) => {
          const m = (o as Mesh).material;
          for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
            if (seen.has(mat) || !(mat instanceof MeshStandardMaterial)) continue;
            seen.add(mat);
            const phys = mat instanceof MeshPhysicalMaterial ? mat : null;
            mats.push({
              mat,
              color: mat.color.clone(),
              env: mat.envMapIntensity,
              emissive: mat.emissive ? mat.emissive.clone() : null,
              emissiveIntensity: mat.emissiveIntensity,
              phys,
              sheen: phys ? phys.sheen : 0,
              sheenColor: phys?.sheenColor ? phys.sheenColor.clone() : null,
              specularIntensity: phys ? phys.specularIntensity : 0,
              specularColor: phys?.specularColor ? phys.specularColor.clone() : null,
              clearcoat: phys ? phys.clearcoat : 0,
            });
          }
        });
      });
      compiled.seekFns.push((t) => {
        // Drive every light-contributing channel toward black together —
        // opacity is deliberately untouched (toggling `transparent` changes
        // render sorting and breaks seek-idempotency). Pure function of t.
        const k = Math.max(0, 1 - dim * verbs.easedProgress(t, timing));
        for (const e of mats) {
          e.mat.color.copy(e.color).multiplyScalar(k);
          e.mat.envMapIntensity = e.env * k;
          if (e.emissive) {
            e.mat.emissive.copy(e.emissive).multiplyScalar(k);
            e.mat.emissiveIntensity = e.emissiveIntensity * k;
          }
          if (e.phys) {
            e.phys.sheen = e.sheen * k;
            if (e.sheenColor) e.phys.sheenColor.copy(e.sheenColor).multiplyScalar(k);
            e.phys.specularIntensity = e.specularIntensity * k;
            if (e.specularColor) e.phys.specularColor.copy(e.specularColor).multiplyScalar(k);
            e.phys.clearcoat = e.clearcoat * k;
          }
        }
      });
    }
  }

  compileVariantChains(compiled, variantEls);
}

interface VariantState {
  color: Color;
  roughness: number | null;
  metalness: number | null;
}

type LitMaterial = MeshStandardMaterial | MeshPhysicalMaterial;

/**
 * `variant` — material colorway transitions (configurator-style).
 *
 * Variants on the same target (and material filter) form a chain in start
 * order: each one's from-state is the previous one's to-state, resolved at
 * compile time so every writer stays a pure function of t. A base writer
 * restores the original state first; each variant only writes once its
 * window has begun — so the latest active variant wins, and seeking
 * backwards past every variant lands on the base look.
 */
function compileVariantChains(
  compiled: CompiledScene,
  variantEls: Array<{ el: Element; timing: verbs.VerbTiming }>,
): void {
  const groups = new Map<string, Array<{ el: Element; timing: verbs.VerbTiming }>>();
  for (const entry of variantEls) {
    const key = `${entry.el.getAttribute("target") ?? ""}|${entry.el.getAttribute("material") ?? "*"}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(entry);
  }

  const tmp = new Color();
  for (const entries of groups.values()) {
    const first = entries[0]!;
    const target = resolveTarget(compiled, first.el.getAttribute("target"));
    if (!target) continue;
    const nameFilter = first.el.getAttribute("material");

    const materials: LitMaterial[] = [];
    const seen = new Set<Material>();
    target.traverse((child) => {
      const m = (child as Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        if (!(mat instanceof MeshStandardMaterial)) continue; // Physical extends Standard
        if (nameFilter && mat.name !== nameFilter) continue;
        materials.push(mat);
      }
    });
    if (materials.length === 0) continue;

    // Base state from the first material (variants drive the group uniformly).
    const base: VariantState = {
      color: materials[0]!.color.clone(),
      roughness: materials[0]!.roughness,
      metalness: materials[0]!.metalness,
    };
    compiled.seekFns.push(() => {
      for (const mat of materials) {
        mat.color.copy(base.color);
        if (base.roughness !== null) mat.roughness = base.roughness;
        if (base.metalness !== null) mat.metalness = base.metalness;
      }
    });

    entries.sort((a, b) => a.timing.start - b.timing.start);
    let from = base;
    for (const { el, timing } of entries) {
      const to: VariantState = {
        color: el.getAttribute("color")
          ? new Color(parseColorString(el.getAttribute("color"), "#ffffff"))
          : from.color.clone(),
        roughness: el.getAttribute("roughness")
          ? parseNumber(el.getAttribute("roughness"), 0.5)
          : from.roughness,
        metalness: el.getAttribute("metalness")
          ? parseNumber(el.getAttribute("metalness"), 0)
          : from.metalness,
      };
      const fromState = from;
      compiled.seekFns.push((t) => {
        if (t < timing.start) return; // earlier writers own this range
        const p = verbs.easedProgress(t, timing);
        tmp.lerpColors(fromState.color, to.color, p);
        for (const mat of materials) {
          mat.color.copy(tmp);
          if (to.roughness !== null && fromState.roughness !== null) {
            mat.roughness = fromState.roughness + (to.roughness - fromState.roughness) * p;
          }
          if (to.metalness !== null && fromState.metalness !== null) {
            mat.metalness = fromState.metalness + (to.metalness - fromState.metalness) * p;
          }
        }
      });
      from = to;
    }
  }
}
