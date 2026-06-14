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
import { homedir } from "node:os";
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

// Auth via the USER ~/.npmrc. npm IGNORES a workspace package's local .npmrc
// ("ignoring workspace config"), and the per-registry token key isn't a valid
// POSIX env-var name (so the env approach is dropped on Linux CI → ENEEDAUTH).
// The user npmrc is always read. Back up + restore so a local run never clobbers
// an existing one. (Token is written to a file, never logged.)
const userRc = join(homedir(), ".npmrc");
const userRcBackup = existsSync(userRc) ? readFileSync(userRc, "utf8") : null;
writeFileSync(userRc, `${userRcBackup ?? ""}\n//registry.npmjs.org/:_authToken=${npmToken()}\n`);

const publishPkg = (dir) => {
  console.log(`$ npm publish --access public${DRY}  (in ${dir})`);
  execSync(`npm publish --access public${DRY}`, { cwd: join(ROOT, dir), stdio: "inherit" });
};

try {
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
} finally {
  // restore the user npmrc (or remove the one we created)
  if (userRcBackup !== null) writeFileSync(userRc, userRcBackup);
  else rmSync(userRc, { force: true });
}
