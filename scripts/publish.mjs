#!/usr/bin/env bun
/**
 * Publish both packages to npm — runtime first, then the CLI (with its runtime
 * dependency pinned to the exact version, so `npx stereoframe@X` always ships
 * runtime X). Run BY CI (.github/workflows/release.yml) on a `v*` tag, AFTER the
 * `check` gate passes — so npm can never receive a version CI hasn't verified.
 *
 * The version published is whatever is in the tagged commit's package.json
 * (set by `bun run release`). NPM_TOKEN comes from the GitHub repo secret in CI,
 * or `.env` for a manual local run.
 *
 *   NPM_TOKEN=… bun scripts/publish.mjs     # publish
 *   DRY_RUN=1   bun scripts/publish.mjs     # pack only, no upload (safe to test)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DEP = "stereoframe-runtime";
const DRY = process.env.DRY_RUN ? " --dry-run" : "";

const pkgPath = (dir) => join(ROOT, dir, "package.json");
const readPkg = (dir) => JSON.parse(readFileSync(pkgPath(dir), "utf8"));
const writePkg = (dir, pkg) => writeFileSync(pkgPath(dir), JSON.stringify(pkg, null, 2) + "\n");

function npmToken() {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("NPM_TOKEN="));
    const t = line?.slice("NPM_TOKEN=".length).trim();
    if (t) return t;
  }
  throw new Error("NPM_TOKEN not set (env or .env) — required to publish");
}

const version = readPkg("packages/cli").version;
const token = npmToken();

// Auth via a per-package-dir `.npmrc` (npm reads cwd/.npmrc), NOT an env var:
// the per-registry key `//registry.npmjs.org/:_authToken` is not a valid POSIX
// env-var name, so passing it via env is dropped on Linux CI (ENEEDAUTH). npm
// excludes .npmrc from the tarball, and we delete it after, so it never leaks.
function publishPkg(dir) {
  const rc = join(ROOT, dir, ".npmrc");
  writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`);
  try {
    console.log(`$ npm publish --access public${DRY}  (in ${dir})`);
    execSync(`npm publish --access public${DRY}`, { cwd: join(ROOT, dir), stdio: "inherit" });
  } finally {
    rmSync(rc, { force: true });
  }
}

console.log(`publishing v${version}${DRY ? " (dry-run)" : ""}`);

// 1. runtime first (the CLI depends on it at install time).
publishPkg("packages/runtime");

// 2. CLI with its runtime dep pinned to the exact version for the published
//    artifact, then restore workspace:* so a local run leaves the tree clean.
const cliDir = "packages/cli";
const cliOriginal = readPkg(cliDir);
const cliPinned = structuredClone(cliOriginal);
if (cliPinned.dependencies?.[RUNTIME_DEP]) cliPinned.dependencies[RUNTIME_DEP] = version;
writePkg(cliDir, cliPinned);
try {
  publishPkg(cliDir);
} finally {
  writePkg(cliDir, cliOriginal);
}

console.log(`\n✓ published v${version}${DRY ? " (dry-run)" : ""}`);
