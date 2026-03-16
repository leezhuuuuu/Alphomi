# Contributing to Alphomi

Thanks for helping build Alphomi.

## Before You Start

- Read [README.md](README.md) for architecture and setup.
- Read [docs/guides/development.md](docs/guides/development.md) and [docs/guides/testing.md](docs/guides/testing.md).
- For architecture-level changes, check the ADRs in `docs/adr/`.

## Contribution Paths

- Desktop contributors can focus on `apps/desktop`
- Browser automation contributors can focus on `apps/driver`
- Agent workflow contributors can focus on `apps/brain`
- Tooling and release contributors can focus on `packages/`, `tools/`, and `docs/`

## Setup

```bash
pnpm bootstrap
pnpm doctor
pnpm dev
```

`pnpm bootstrap` creates `config.yaml` automatically if it does not exist yet.

## Workflow

1. Keep changes scoped to one layer when possible
2. Update docs with behavior or architecture changes
3. Run the narrowest relevant checks first
4. Run cross-app smoke checks before packaging changes land
5. Prefer additive changes over hidden repo-level magic
6. If you change a protocol or public contract, update `packages/contracts` and docs in the same PR

## Validation Commands

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

Run extra focused checks when you are working inside a single app:

```bash
pnpm --filter @alphomi/desktop typecheck
pnpm --filter @alphomi/driver build
pnpm --filter @alphomi/brain typecheck
```

## Pull Request Expectations

- Explain the user-facing change and the architectural impact.
- Call out config changes, protocol changes, or packaging changes explicitly.
- Add or update docs when behavior, setup, or contributor workflow changes.
- Avoid unrelated refactors unless they directly unblock the change.

## Architecture and Design Changes

- Add a new ADR in `docs/adr/` for changes that affect app boundaries, release packaging, protocol ownership, or long-term maintenance tradeoffs.
- Add a plan document in `docs/plans/` for large migrations or multi-step work.

## Documentation Rules

- Record architecture-level changes in `docs/adr/`
- Record major implementation plans in `docs/plans/`
- Keep contributor setup instructions in `docs/guides/`

## Security

Please do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) instead.
