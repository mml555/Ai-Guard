<!-- Keep this concise. Delete sections that don't apply. -->

## What & why

<!-- What does this change and what problem does it solve? Link issues: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (note it in CHANGELOG under ⚠ Breaking)
- [ ] Docs / examples only
- [ ] Chore / infra / CI

## Version impact

<!-- See docs/versioning.md — patch-by-default. Do NOT bump version surfaces here;
     releasing is a separate step (docs/releasing.md). -->

- [ ] Patch — fix / docs / small or gap-filling addition (default)
- [ ] Minor — a substantial, announced capability milestone
- [ ] Major — breaking change to the API / SDK / config schema
- [ ] None — no release on its own; entry sits under `[Unreleased]`

## Checklist

- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] Tests pass (`bash scripts/test-with-db.sh`) and I added/updated tests for this change
- [ ] If routes changed: OpenAPI spec regenerated (`/openapi-refresh`)
- [ ] If config schema changed: docs and `.env.*.example` updated
- [ ] If a DB migration was added: it's expand/contract-safe (see docs/upgrades.md)
- [ ] Docs updated in this PR (no stale docs left behind)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (with a ⚠ Breaking note if applicable)
- [ ] Commit subjects follow Conventional Commits (see CONTRIBUTING.md)

## Notes for reviewers

<!-- Anything non-obvious: tradeoffs, follow-ups, things you deliberately left out. -->
