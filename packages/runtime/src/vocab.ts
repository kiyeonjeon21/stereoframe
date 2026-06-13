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
  "sf-animate",
] as const;

export const VERB_NAMES = [
  "turntable",
  "orbit",
  "dolly",
  "move",
  "follow",
  "crossfade-clip",
  "camera-path",
  "bounce-in",
  "fade-in",
  "float",
] as const;

/** sf-* attributes whose value is a local asset path the renderer fetches. */
export const ASSET_ATTRS = ["src", "environment", "normals"] as const;
