# Maintainer Guide

## Repository Health Checklist

Before merging changes that affect multiple layers:

- run `pnpm typecheck`
- run `pnpm test`
- run `pnpm smoke`
- update docs and contracts if protocol or setup changed
- add an ADR if architecture or packaging changed

## Release Checklist

1. Verify `pnpm validate`
2. Verify the platform packaging command for the release target
3. Confirm the bundled Brain binary is present in the build output
4. Confirm `config.example.yaml` still matches the expected runtime shape
5. Review docs for setup, release, and breaking changes

For a publish-ready list, see `docs/guides/release-checklist.md`.

## PR Review Heuristics

- Favor bugs, regressions, hidden coupling, and missing tests over style feedback.
- Watch for cross-language protocol drift between Desktop, Driver, and Brain.
- Watch for hidden setup side effects that make onboarding harder.
- Keep root tooling orchestration-focused; avoid moving app runtime dependencies back to the root without a strong reason.

## When to Write an ADR

Write an ADR when a change affects:

- app boundaries
- release packaging
- protocol ownership
- contributor workflow at the repo level
- long-term maintenance tradeoffs
