/**
 * The single source of truth for "is this build releasable" — run by BOTH the CI
 * workflow (.github/workflows/ci.yml) AND `bun run release` (before it publishes).
 *
 * Keeping one script means local releases and CI can never diverge: if these
 * checks pass locally the release publishes; if they'd fail in CI, the release
 * fails first and nothing reaches npm.
 *
 *   bun run check   (or: bun scripts/check.mjs)
 *
 * Requires Chrome (Puppeteer) + ffmpeg on PATH for validate/render.
 */
import { execSync } from "node:child_process";

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" }); // throws (non-zero exit) → check fails
};

// Build + unit tests.
run("bun run build");
run("bun run --cwd packages/runtime test");
run("bun run --cwd packages/cli test");

// Examples: lint + headless validate each (the integration coverage).
const EXAMPLES = [
  "hello-standalone",
  "character-run-standalone",
  "ocean-flythrough",
  "glass-hero",
  "paper-swarm",
  "multi-shot",
  "variant-demo",
  "day-night",
  "metaball",
];
for (const d of EXAMPLES) {
  run(`node packages/cli/dist/cli.js update examples/${d}`);
  run(`node packages/cli/dist/cli.js lint examples/${d}`);
  run(`node packages/cli/dist/cli.js validate examples/${d}`);
}

// Render smoke test (end-to-end: headless capture → ffmpeg).
run("node packages/cli/dist/cli.js render examples/hello-standalone --draft --out /tmp/sf-smoke.mp4");

console.log("\n✓ all checks passed");
