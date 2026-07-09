# Contributing to Modelgov

Thanks for your interest in improving Modelgov. This guide covers how to file
issues, set up the project, and open a pull request.

## Reporting issues

- **Bugs** and **feature requests**: open an issue and pick the matching form —
  it prompts for the details we need to act quickly.
- **Security vulnerabilities**: do **not** open a public issue. Follow the
  [security policy](SECURITY.md) to disclose privately.
- Search [existing issues](https://github.com/mml555/modelgov/issues) first to
  avoid duplicates.

## Development setup

Requirements: **Node 20+** (the `engines` floor; CI runs Node 22), **pnpm 10**
(via `corepack enable`), Docker (for the integration test database and image
builds).

```bash
corepack enable
pnpm install --frozen-lockfile
```

Common commands:

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | `tsc --noEmit` for every project |
| `bash scripts/test-with-db.sh` | Full test suite against a disposable Postgres |
| `bash scripts/test-with-db.sh --coverage` | …with coverage (ratchet-only thresholds) |
| `pnpm -r build` | Build all packages |

The integration tests need Postgres; `scripts/test-with-db.sh` spins up a
throwaway container for you (no local Postgres required).

## Pull requests

1. Branch off `main` (`main` is protected — direct pushes are blocked; changes
   land via PR).
2. Keep the change focused. Separate unrelated fixes into separate PRs.
3. Make sure lint, typecheck, and tests pass locally before pushing.
4. **Update the docs in the same PR.** If you changed routes, regenerate the
   OpenAPI spec. If you changed the config schema, update the docs and
   `.env.*.example`. If you added a DB migration, keep it expand/contract-safe
   (see [docs/upgrades.md](docs/upgrades.md)). Docs are not a follow-up — a PR
   that leaves a doc stale is incomplete.
5. **Add a `CHANGELOG.md` entry under `[Unreleased]`** for any user-facing change
   (see below), with a **⚠ Breaking** note for anything that breaks a surface.
6. Fill in the PR template — including the **version impact** (patch / minor /
   major / none). CI (test, feature-flags, compose-e2e, terraform, python-sdk)
   must be green and all review threads resolved before merge.

## Commit style — Conventional Commits

Every commit subject follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): imperative subject
```

- **type** — one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`. Use `feat!:` / a `BREAKING CHANGE:` footer for breaking changes.
- **scope** (optional) — the area touched, e.g. `api`, `sdk-typescript`,
  `sdk-python`, `policy-engine`, `cli`, `documents`, `billing`, `docs`.
- **subject** — imperative and specific ("add x-request-id correlation"), not
  "update stuff". Lower-case, no trailing period.
- **body** (optional) — what changed and *why*; wrap at ~72 cols.
- Reference issues in the body/footer with `Closes #123` so they auto-close.
- **Do not add attribution or tooling trailers** (no `Co-Authored-By`,
  `Generated-with`, or similar footers).

Commit `type` maps to version impact (see [versioning](docs/versioning.md)):
`fix`/`docs`/`refactor`/`perf`/`chore` → **patch**; a small/gap-filling `feat` →
**patch**; a `feat` that completes an announced milestone → **minor**; anything
breaking → **major**.

## Changelog discipline

The [CHANGELOG](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/).
Every PR with a user-facing change adds an entry under the top **`[Unreleased]`**
section, in the right category (**Added / Changed / Fixed / Deprecated / Removed
/ Security**). Entries accumulate there and are drained into a dated version
section only when a release is cut — see [docs/releasing.md](docs/releasing.md).
Not every commit is a release; the changelog is kept current per change so a
release is just "date the `[Unreleased]` section."

## Versioning & releases

Modelgov is **patch-by-default**: most changes ship as a PATCH, MINOR is reserved
for announced milestones, and MAJOR only for breaking changes. Never bump a
version surface in a normal feature/fix PR — releasing is a separate, deliberate
step. See [docs/versioning.md](docs/versioning.md) (policy) and
[docs/releasing.md](docs/releasing.md) (mechanics).

## Code of conduct

Be respectful and constructive. Harassment or abuse isn't tolerated in issues,
PRs, or any project space.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
