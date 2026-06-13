# stereoframe — Claude Code

The full agent guide (repo layout, build/test, conventions) is in AGENTS.md:

@AGENTS.md

## Authoring skill

When authoring stereoframe compositions (writing `<sf-*>` markup, running
`stage`/`inspect`, building product videos), use the **stereoframe** skill at
`.claude/skills/stereoframe/SKILL.md` — invoke it before writing markup. It
covers the `stage` presets, the full vocabulary, the finish attributes, recipes,
and the determinism rules.

## Reminders

- **feat-then-release:** commit the change as its own `feat:`/`fix:` commit, then run `bun run release` (it makes the version-bump commit). Don't bundle them.
- **Always `lint` → `validate` before `render`**; `bun test` must stay green.
- Secrets are in `.env` (gitignored): `NPM_TOKEN`, `MESHY_API_KEY`. Never commit them.
