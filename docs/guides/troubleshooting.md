# Troubleshooting Guide

## Bootstrap Problems

### `config.yaml` is missing

Run:

```bash
pnpm bootstrap
```

The bootstrap script creates `config.yaml` automatically from `config.example.yaml`.

### `uv` is not installed

Bootstrap falls back to `python3 -m venv` and `pip`, so this is not fatal. Installing `uv` is still recommended because it makes Brain environment setup and binary builds faster and more reproducible.

### Playwright browser install fails

Retry:

```bash
pnpm --filter @alphomi/driver exec playwright install
```

On Linux CI or fresh Linux environments, you may also need:

```bash
pnpm --filter @alphomi/driver exec playwright install --with-deps chromium
```

## Validation Problems

### `pnpm smoke` cannot reach the Driver

This usually means the Driver is not running yet. `pnpm smoke` will try to start one automatically. If you are running the smoke script directly, either start the Driver first with `pnpm dev:driver` or let `pnpm smoke` orchestrate it for you.

### LLM E2E is skipped

The optional file-edit E2E requires a valid `LLM_BASE_URL` and `LLM_API_KEY`. If those are not configured, the script skips by design.

### Config sync check fails

Run:

```bash
pnpm sync:config-template
```

The package copy in `packages/config/defaults/config.example.yaml` is the source of truth.

## Build Problems

### Brain binary is missing

Run:

```bash
pnpm build:brain
```

### Packaged app build fails after Brain build

Use the root packaging scripts instead of mixing commands manually:

```bash
pnpm package:mac:dir
pnpm dist:mac
```

The repository intentionally separates `build:brain` from the generic root `build` command to avoid duplicate PyInstaller runs.

## Diagnostics

Run:

```bash
pnpm doctor
```

This checks the local environment, core repository files, config presence, and whether the bundled Brain binary already exists.

## Cleaning Generated Files

If you want to remove local build outputs and temporary artifacts, run:

```bash
pnpm clean
```

This removes generated Electron output, Brain build artifacts, cached temp files, and other reproducible local outputs.
