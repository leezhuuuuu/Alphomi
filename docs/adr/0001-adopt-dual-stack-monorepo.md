# ADR-0001: Adopt a Dual-Stack Monorepo for Alphomi

## Status
Accepted

## Context

Alphomi needs to keep the current project's functional surface area while becoming easier to contribute to and package as an open-source project. The product naturally has three bounded contexts:

- Electron desktop shell and UI
- Playwright browser execution driver
- Python brain service for orchestration and workflows

A pure single-language rewrite would delay delivery and destabilize existing features. A loose multi-repo split would add versioning and coordination overhead too early.

## Decision

Adopt a dual-stack monorepo with:

- `apps/desktop` for Electron + React
- `apps/driver` for TypeScript + Playwright
- `apps/brain` for Python + FastAPI
- `packages/contracts` for shared protocol references
- `packages/config` for shared configuration defaults and docs
- `tools/` for evaluation and operational tooling

## Consequences

### Positive

- Preserves the proven product architecture
- Keeps developer responsibilities clear by layer
- Makes open-source setup explicit instead of hiding Python work inside Node install hooks
- Allows one release artifact while keeping contributor workflows modular

### Negative

- Two toolchains remain in the repository
- CI and packaging remain more complex than a single-language app
- Contract drift still requires discipline

### Neutral

- Root orchestration becomes more important than before
- Shared contracts start as docs and schema references before deeper generation is added

## Alternatives Considered

**Full TypeScript rewrite**
- Rejected for now because it increases delivery risk and delays open-source readiness

**Split into multiple repositories**
- Rejected for now because it adds release coordination overhead too early

## References

- `docs/plans/2026-03-16-alphomi-clean-monorepo.md`
