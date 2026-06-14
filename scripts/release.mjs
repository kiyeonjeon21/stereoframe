#!/usr/bin/env bun
/**
 * Lock-step release: gate on `bun run check`, bump both packages to the same next
 * version, then commit/tag/push. **Publishing happens in CI** — the `release.yml`
 * workflow re-runs `check` on the pushed `v*` tag and only then runs
 * `scripts/publish.mjs`, so npm can never receive a version GitHub hasn't verified
 * green. The workflow also creates a GitHub Release with generated notes.
 * No NPM_TOKEN needed locally.
 *
 *   bun run release            # patch (default)
 *   bun run release minor      # breaking change
 *   bun run release major      # cut 1.0.0
 *
 * See VERSIONING.md for when to use which.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/runtime", "packages/cli"];

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

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

// 1. Run the FULL CI check suite on current code first — the same `bun run check`
//    CI runs, so a release can never publish something CI would reject (build +
//    unit tests + examples lint/validate + render smoke). Fail-fast.
run("bun run check");

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

// 4. Commit, tag, push. The `release.yml` workflow takes over from the tag:
//    it re-runs `check` and publishes to npm only if green (scripts/publish.mjs).
run("git add -A");
run(`git commit -m "release: v${next}"`);
run(`git tag v${next}`);
run("git push");
run("git push --tags");

console.log(`\n✓ pushed v${next} — CI will publish to npm once the release workflow is green.`);
console.log(`  watch: gh run watch --exit-status $(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')`);
