# Testing Guide

## Fast Validation

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

`pnpm smoke` is the recommended pre-PR validation path because it exercises the cross-app workflow instead of only package-local checks.

## What Each Command Covers

- `pnpm typecheck`
  Verifies the Electron desktop, Playwright driver, and Python brain sources compile cleanly.
- `pnpm test`
  Runs the package-level validation suite used by the monorepo.
- `pnpm smoke`
  Runs cross-app smoke tests, starts a local Driver automatically when needed, and executes the optional LLM file-edit E2E.
- `pnpm validate`
  Runs the full local pre-release path: typecheck, test, smoke, Brain binary build, and app builds.

`pnpm validate` skips the duplicate workspace test pass inside `pnpm smoke`, so it stays stricter than `pnpm test` plus `pnpm smoke` while avoiding redundant work.

## Optional LLM Integration

`test/llm_apply_patch_e2e.py` requires a valid `LLM_BASE_URL` that points to an OpenAI-compatible `http(s)` endpoint.

You can provide it through `config.yaml` or environment variables:

```bash
export LLM_BASE_URL="https://your-provider.example/v1/chat/completions"
export LLM_API_KEY="your-api-key"
python3 test/llm_apply_patch_e2e.py
```

If `LLM_BASE_URL` is not configured, the script prints a skip message instead of failing with a low-signal transport error.

## Driver-Backed Smoke Tests

`test/driver-storage-smoke.mjs` talks to the Driver REST API.

- If the Driver is already running, it reuses `DRIVER_URL` or `http://127.0.0.1:13000`.
- If you run `pnpm smoke`, the repository starts a temporary local Driver for you.
- If you run the script directly without a running Driver, it prints a clear skip message by default.

To force failures in CI or local automation, set:

```bash
export REQUIRE_DRIVER_SMOKE=1
export REQUIRE_LLM_E2E=1
```

Use those flags only when your environment is expected to provide the required services or credentials.
