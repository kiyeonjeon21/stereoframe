/**
 * Canonical vocabulary — the single source the CLI linter imports (via the
 * `@stereoframe/runtime/vocab` Node-safe entry; the main bundle top-level
 * awaits and touches `window`, so it can't be imported outside a browser).
 *
 * Keep in sync with: scene.ts tag handling, animate.ts verb dispatch.
 */
export { EASE_NAMES } from "./ease";

export const ELEMENT_NAMES = [
  "sf-scene",
  "sf-camera",
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
  turntable: ["rpm", "axis", "part"],
  orbit: ["around", "radius", "from", "to", "height"],
  dolly: ["toward", "distance"],
  zoom: ["from", "to"],
  move: ["to", "from", "part"],
  follow: ["subject", "offset"],
  "crossfade-clip": ["from", "to"],
  "camera-path": ["points", "look"],
  "bounce-in": [],
  "fade-in": ["rise"],
  float: ["amplitude", "period", "part"],
  sway: ["amount", "period", "part"],
  path: ["points", "orient", "closed"],
  morph: ["index", "from", "to"],
  deform: ["amount", "frequency", "speed"],
  explode: ["distance"],
  isolate: ["part", "dim"],
  variant: [],
};

/** `stereoframe stage --preset` values. */
export const STAGE_PRESETS = [
  "reveal", "hero-orbit", "turntable", "exploded-view", "spec", "teardown", "cinematic",
] as const;

/** `stereoframe gen --provider` backends. */
export const GEN_PROVIDERS = ["meshy", "fal"] as const;
