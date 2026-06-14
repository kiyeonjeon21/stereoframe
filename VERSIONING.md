# Versioning

The two published packages — `stereoframe` (CLI) and `stereoframe-runtime` —
are released **lock-step**: they always share the same version number, and the
CLI pins its runtime dependency to that exact version. So `npx stereoframe@X`
always ships runtime `X` — no drift, deterministic by construction.

## When to bump which number (while `0.x`)

The bias is toward **patch (z)** — releases are frequent and the public surface
(the markup vocabulary + CLI) is still pre-1.0, so additive changes don't need
a minor bump.

| change | bump |
|---|---|
| new verb / block / element / attribute (additive — existing compositions render unchanged) | **patch** `z` |
| bug fix, performance, default tuning that does not change existing renders | **patch** `z` |
| docs / examples / CI / internal refactor | **patch** `z` (or no release if docs-only) |
| **breaking**: remove or rename a verb/element/attribute; change a default that alters existing renders; change a CLI command/flag/output contract | **minor** `y` |
| declare the markup + CLI stable | **major** → `1.0.0` |

After `1.0.0`, switch to standard semver (patch = fix, minor = additive,
major = breaking).

> One-time note: the CLI was historically published on the `0.1.x` line while
> the runtime was on `0.2.x`. The first lock-step release reconciles both to
> `0.2.2`, so the CLI version jumps `0.1.3 → 0.2.2` once. This also corrects a
> distribution bug where the published CLI pinned a stale runtime (`0.1.0`),
> shipping users a runtime without the `variant` verb and `sf-metaball` block.

## How to release

```bash
bun run release            # patch (default) — the common case
bun run release minor      # only for a breaking change
bun run release major      # only to cut 1.0.0
```

The script (`scripts/release.mjs`) runs the full check suite, bumps both
package.json versions in lock-step, commits the version bump, tags (`vX.Y.Z`),
and pushes. The `release.yml` workflow then re-runs the full check suite on the
tagged commit, publishes both packages to npm, and creates a GitHub Release with
generated release notes. `NPM_TOKEN` lives in GitHub Actions secrets.
