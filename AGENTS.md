# stereoframe — agent guide

Canonical guidance for AI agents working in this repository. Tool-specific entry
points point here: `CLAUDE.md` imports it, `.cursor/rules/stereoframe.mdc`
references it, and Codex reads this file directly.

## What this is

A monorepo (bun workspaces) for **stereoframe** — the auto-director for 3D motion
graphics: declarative `<sf-*>` HTML → deterministic 3D video on three.js.

- `packages/runtime/` — `stereoframe-runtime` → `dist/stereoframe.js` (three.js r184 bundled + the `<sf-*>` custom elements + the seek protocol).
- `packages/cli/` — `stereoframe` → the `stereoframe` bin (stage/inspect/init/gen/lint/validate/render/preview/add/update; Puppeteer + ffmpeg).
- `examples/` — runnable compositions. `docs/format.md` — markup spec. `.claude/skills/stereoframe/SKILL.md` — the authoring guide.

## Setup, build, test

```bash
bun install
bun run build                      # builds both packages (runtime bundle + cli)
bun test                           # pure unit tests (no GPU) — keep green
node packages/cli/dist/cli.js …    # run the CLI from source
```

Requires Node ≥ 20, ffmpeg on PATH, and bun (for building). Rendering uses headless Chrome via Puppeteer.

## Authoring videos

For **how to write stereoframe compositions** (presets, the `<sf-*>` vocabulary,
finish attributes, recipes, determinism rules), use the authoring guide:
`.claude/skills/stereoframe/SKILL.md` (a Claude skill; also the markup spec in
`docs/format.md`). Don't duplicate that here — read it before authoring `sf-*` markup.

## Conventions (important)

- **Determinism = seekability.** Every frame must be a pure function of `t` within a render: no wall-clock (`Date.now`/`performance.now`), no unseeded `Math.random()` per frame, no cross-frame accumulation (trails/feedback). Cross-run byte-identity is *best-effort, not required* — rich shaders/high poly are fine. `validate` enforces seek idempotency.
- **feat-then-release, two commits.** Commit feature/fix work as its own `feat:`/`fix:` commit FIRST, then run the release. Never let the implementation land inside the `release: vX` commit. The release script makes its own commit containing only the version bump + lockfile.
- **Releasing is lock-step.** `bun run release [patch|minor|major]` bumps both packages to the same version, **publishes with `npm publish`** (not `bun publish` — bun doesn't set the registry `readme` field), pins the CLI's runtime dep to the exact version, then commits/tags/pushes. See `VERSIONING.md`.
  - Published tarballs only include what's in each package.json `files` array (bun/npm don't auto-add files) — keep `README.md` listed there.
- **Verify before claiming done.** `bun test` for code; for compositions, `stereoframe lint` then `stereoframe validate` (both exit 1 on error). Report failures with output.
- **Secrets live in `.env`** (gitignored, never commit): `NPM_TOKEN` (publish), `MESHY_API_KEY` (`gen`). `refs/` is gitignored too (third-party reference videos — never publish).
- **Match surrounding style**; keep comments at the density of the file you're editing.

## Cross-tool layout

The authoring skill is canonical at `.claude/skills/stereoframe/SKILL.md`; the
root `skills/stereoframe/SKILL.md` is a symlink to it (for `npx skills add`
distribution). "Skills" are Claude-only — Codex and Cursor get the same knowledge
through this file and `docs/format.md`, not a skills folder.
