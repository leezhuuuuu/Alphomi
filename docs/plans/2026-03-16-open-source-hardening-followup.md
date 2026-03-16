# Open-Source Hardening Follow-Up

## Goal

Make the repository easier for new contributors to diagnose, validate, and maintain without relying on tribal knowledge.

## Changes Added

- Added `pnpm doctor` for local environment diagnostics
- Added `pnpm sync:config-template` to keep the root config template aligned with the package source of truth
- Added shared-layer validation for `packages/contracts` and `packages/config`
- Added a troubleshooting guide for setup, smoke, config, and packaging issues

## Why This Matters

- New contributors get a single command to diagnose missing tools or files
- Maintainers get a repeatable way to keep the published root config template consistent
- Shared protocols and config docs now fail fast in CI instead of drifting quietly
