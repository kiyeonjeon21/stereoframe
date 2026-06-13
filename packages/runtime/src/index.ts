import { boot } from "./boot";

// Top-level await intentionally blocks DOMContentLoaded until all 3D assets
// are loaded and shaders are compiled. See boot.ts for why this gates the
// HyperFrames capture pipeline.
await boot();

export { boot };
