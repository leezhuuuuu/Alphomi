# Changelog

All notable changes to Alphomi should be documented in this file.

The format is intentionally simple and release-friendly.

## Unreleased

### Added

- Clean open-source-ready monorepo structure for Desktop, Driver, and Brain
- Shared `packages/contracts` and `packages/config` references
- Contributor and maintainer documentation
- CI workflow, issue templates, PR template, support files, and community health docs
- Unified `pnpm smoke` workflow with optional LLM integration handling

### Changed

- Desktop Electron version aligned with the runtime APIs used by the app
- Brain formalized as a Python package managed with `pyproject.toml`
- Packaging now embeds the bundled Brain binary and default config resources

### Fixed

- Desktop type mismatches caused by Electron API/version drift
- Hidden setup friction around config generation and smoke-test prerequisites
- Low-signal failures in optional LLM integration tests when no endpoint is configured
