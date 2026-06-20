/**
 * Canonical vocabulary — the single source the CLI linter imports (via the
 * `@stereoframe/runtime/vocab` Node-safe entry; the main bundle top-level
 * awaits and touches `window`, so it can't be imported outside a browser).
 *
 * Keep in sync with: scene.ts tag handling, animate.ts verb dispatch.
 */
export { EASE_NAMES, isValidEase } from "./ease";

export const ELEMENT_NAMES = [
  "sf-scene",
  "sf-camera",
  "sf-group", // transform container: groups content so a verb on it moves the subtree
  "sf-state", // named state: a set of <sf-set> per-node overrides (core="ir")
  "sf-set", // one per-node override inside <sf-state>
  "sf-model",
  "sf-mesh",
  "sf-light",
  "sf-particles",
  "sf-sky",
  "sf-ocean",
  "sf-swarm",
  "sf-metaball",
  "sf-scatter",
  "sf-baked",
  "sf-shader",
  "sf-vert", // optional vertex-stage child of <sf-shader>
  "sf-frag", // optional fragment-stage child of <sf-shader>
  "sf-animate",
  "sf-callout",
] as const;

export const VERB_NAMES = [
  "turntable",
  "orbit",
  "dolly",
  "zoom",
  "move",
  "follow",
  "crossfade-clip",
  "camera-path",
  "bounce-in",
  "fade-in",
  "float",
  "sway",
  "path",
  "morph",
  "deform",
  "explode",
  "isolate",
  "variant",
  "to", // transition to a named <sf-state> (core="ir")
] as const;

/** sf-* attributes whose value is a local asset path the renderer fetches. */
export const ASSET_ATTRS = ["src", "environment", "normals", "lut"] as const;

// ── Declarative authoring spec (consumed by `lint` + the `schema` command) ──
// Single source of truth so `stereoframe schema` never drifts from the code.

/** `<sf-mesh>`/`<sf-shader>` geometry kinds + their ordered `args` labels. */
export const GEOMETRY_KINDS = [
  { name: "box", args: ["width", "height", "depth"] },
  { name: "sphere", args: ["radius"] },
  { name: "plane", args: ["width", "height", "widthSegments", "heightSegments"] },
  { name: "cylinder", args: ["radiusTop", "radiusBottom", "height"] },
  { name: "torus", args: ["radius", "tube"] },
  { name: "icosahedron", args: ["radius", "detail"] },
  { name: "rounded-box", args: ["width", "height", "depth", "cornerRadius"] },
] as const;

/** `<sf-mesh>`/`<sf-shader>` material kinds. */
export const MATERIAL_KINDS = ["standard", "physical", "glass", "matcap"] as const;

/** `<sf-scene>` finish / grade attributes (post-processing + lighting). */
export const FINISH_ATTRS = [
  "exposure", "tone-mapping", "samples", "msaa",
  "environment", "env-blur", "background",
  "bloom", "bloom-threshold", "bloom-radius",
  "vignette", "contrast", "saturation", "chromatic-aberration", "grain",
  "dof", "dof-focus", "lut", "lut-intensity", "light-sweep",
  "ground", "ground-y", "ground-size", "ground-opacity", "ground-blur", "ground-darkness",
] as const;

/** Attributes every `<sf-animate>` verb honors. */
export const COMMON_VERB_ATTRS = ["target", "start", "duration", "ease"] as const;

/** Per-verb distinctive parameters (keys mirror VERB_NAMES). */
export const VERB_PARAMS: Record<string, readonly string[]> = {
  turntable: ["rpm", "axis", "part", "start", "until", "ramp"],
  orbit: ["around", "radius", "from", "to", "height"],
  dolly: ["toward", "distance"],
  zoom: ["from", "to"],
  move: ["to", "from", "part"],
  follow: ["subject", "offset"],
  "crossfade-clip": ["from", "to"],
  "camera-path": ["points", "look"],
  "bounce-in": [],
  "fade-in": ["rise"],
  float: ["amplitude", "period", "part", "start", "until", "ramp"],
  sway: ["amount", "period", "part", "start", "until", "ramp"],
  path: ["points", "orient", "closed"],
  morph: ["index", "from", "to"],
  deform: ["amount", "frequency", "speed"],
  explode: ["distance"],
  isolate: ["part", "dim"],
  variant: [],
  to: ["state"],
};

/** `stereoframe stage --preset` values. */
export const STAGE_PRESETS = [
  "reveal", "hero-orbit", "turntable", "exploded-view", "spec", "teardown", "cinematic",
] as const;

/** `stereoframe gen --provider` backends. */
export const GEN_PROVIDERS = ["meshy", "fal"] as const;

// ── IR (intermediate representation) vocabulary ──────────────────────────────
// The `core="ir"` pipeline (see ir/). Node-safe so it's shared by the runtime
// lowering (ir/from-html.ts) and the render-free IR lint (cli/src/lint.ts), and
// emitted by `stereoframe schema` so agents see the IR surface.

export const IR_DRIVER_KINDS = ["orbit", "move", "dolly", "zoom", "bounce-in", "fade-in", "variant", "light-tween", "tween", "follow", "path"] as const;
export const IR_BEHAVIOR_KINDS = ["turntable", "float", "sway"] as const;
export const IR_TIMELINE_KINDS = ["seq", "par", "stagger", "beat", "wait", "clip"] as const;
export const IR_CHANNELS = ["position", "rotation", "scale", "fov", "opacity", "material", "light"] as const;

/** Verbs lowered to a continuous, additive IR behavior. */
export const IR_BEHAVIOR_VERBS = ["turntable", "float", "sway"] as const;

/** Windowed verbs the IR models → the transform channel each writes. (Verbs not
 *  here are handled by the legacy fallthrough — see ir/backend.ts IR_VERBS.) */
export const IR_VERB_CHANNEL: Record<string, (typeof IR_CHANNELS)[number]> = {
  orbit: "position",
  move: "position",
  dolly: "position",
  follow: "position",
  "camera-path": "position",
  path: "position",
  zoom: "fov",
  "bounce-in": "scale",
  "fade-in": "opacity",
  variant: "material",
};

/** The node-reference attribute each verb resolves (for dangling-ref checks). */
export const VERB_REF_ATTR: Record<string, string> = {
  orbit: "around",
  dolly: "toward",
  follow: "subject",
};

/** Default window durations (seconds) for windowed verbs — the single source for
 *  the runtime lowering and the IR lint (continuous verbs are absent by design). */
export const VERB_DEFAULT_DURATION: Record<string, number> = {
  orbit: 4,
  dolly: 1.5,
  zoom: 2,
  move: 2,
  "bounce-in": 0.6,
  "fade-in": 0.6,
  "crossfade-clip": 0.5,
  "camera-path": 8,
  path: 8,
  morph: 1,
  variant: 0.8,
  explode: 2.5,
  isolate: 0.8,
  to: 1,
};
