#!/usr/bin/env bun
/**
 * Lock-step release: bump both packages to the same next version, pin the
 * CLI's runtime dependency to that exact version (so `npx stereoframe@X`
 * always ships runtime X), build, test, publish, then commit/tag/push.
 *
 *   bun run release            # patch (default)
 *   bun run release minor      # breaking change
 *   bun run release major      # cut 1.0.0
 *
 * See VERSIONING.md for when to use which. Reads NPM_TOKEN from .env.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Runtime first — the CLI depends on it at publish time.
const PACKAGES = ["packages/runtime", "packages/cli"];
const RUNTIME_DEP = "stereoframe-runtime";

const bumpType = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("usage: bun run release [patch|minor|major]  (default patch)");
  process.exit(1);
}

const pkgPath = (dir) => join(ROOT, dir, "package.json");
const readPkg = (dir) => JSON.parse(readFileSync(pkgPath(dir), "utf8"));
const writePkg = (dir, pkg) => writeFileSync(pkgPath(dir), JSON.stringify(pkg, null, 2) + "\n");

function parseVer(v) {
  return v.split(".").map(Number);
}
function maxVer(versions) {
  return versions.reduce((best, v) => {
    const [a, b, c] = parseVer(v);
    const [x, y, z] = parseVer(best);
    return a > x || (a === x && (b > y || (b === y && c > z))) ? v : best;
  });
}
function bump([x, y, z], type) {
  if (type === "major") return `${x + 1}.0.0`;
  if (type === "minor") return `${x}.${y + 1}.0`;
  return `${x}.${y}.${z + 1}`;
}

function loadNpmToken() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) throw new Error(".env not found — NPM_TOKEN required to publish");
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith("NPM_TOKEN="));
  const token = line?.slice("NPM_TOKEN=".length).trim();
  if (!token) throw new Error("NPM_TOKEN missing/empty in .env");
  return token;
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

// 1. Build + test on current code first (fail fast, version-independent).
run("bun run build");
run("bun run --cwd packages/runtime test");
run("bun run --cwd packages/cli test");

// 2. Compute the shared next version (lock-step: bump the max of both).
const current = PACKAGES.map((d) => readPkg(d).version);
const next = bump(parseVer(maxVer(current)), bumpType);
console.log(`\nreleasing ${current.join(" / ")} → ${next} (${bumpType})\n`);

// 3. Write both versions (repo keeps `workspace:*` for local linking).
for (const dir of PACKAGES) {
  const pkg = readPkg(dir);
  pkg.version = next;
  writePkg(dir, pkg);
}
run("bun install"); // sync the lockfile to the new versions

// 4. Publish (runtime before CLI). Pin the CLI's runtime dep to the exact
//    version only for the published artifact, then restore `workspace:*` —
//    bun's workspace-protocol conversion has shipped stale versions before,
//    so we write the exact version explicitly to guarantee `npx stereoframe@X`
//    ships runtime X.
const token = loadNpmToken();
const publishEnv = { ...process.env, NPM_CONFIG_TOKEN: token };
const cliDir = "packages/cli";
const cliOriginal = readPkg(cliDir);

run("bun publish --access public", { cwd: join(ROOT, "packages/runtime"), env: publishEnv });

const cliPinned = structuredClone(cliOriginal);
if (cliPinned.dependencies?.[RUNTIME_DEP]) cliPinned.dependencies[RUNTIME_DEP] = next;
writePkg(cliDir, cliPinned);
try {
  run("bun publish --access public", { cwd: join(ROOT, cliDir), env: publishEnv });
} finally {
  writePkg(cliDir, cliOriginal); // restore workspace:* for the commit
}

// 5. Commit, tag, push.
run("git add -A");
run(`git commit -m "release: v${next}"`);
run(`git tag v${next}`);
run("git push");
run("git push --tags");

console.log(`\n✓ released v${next}`);
