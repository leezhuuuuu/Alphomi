# Configuration Guide

English | [简体中文](configuration.zh-CN.md)

## Precedence

Alphomi resolves configuration in this order:

1. environment variables
2. `config.yaml`
3. `config.example.yaml` as the starting template for local setup

`pnpm bootstrap` creates `config.yaml` automatically from `config.example.yaml` if it does not exist yet.

The package copy in `packages/config/defaults/config.example.yaml` is the source of truth. If you need to refresh the root copy, run `pnpm sync:config-template`.

## Main Sections

### `driver`

Controls the Playwright execution service.

Common settings:

- `PORT`
- `HEADLESS`
- `NEW_TAB_URL`
- `DESKTOP_CONTROL_URL`
- snapshot and visual inspection tuning

### `user_data`

Controls cookies and localStorage persistence.

Common settings:

- `enabled`
- `mode`
- `storage_path`
- `save_interval_sec`
- `local_storage_scope`

### `brain`

Controls the agent runtime and LLM integration.

Common settings:

- `PORT`
- `WORKFLOW_MODE`
- `CONTEXT_COMPRESSION_THRESHOLD_RATIO`
- `PRAS_URL`
- `LLM_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_ENDPOINT_MODE`
- trace and logging directories

### `desktop`

Controls Electron-shell-specific behavior.

Common settings:

- `DESKTOP_CONTROL_PORT`
- `NEW_TAB_URL`
- `ELECTRON_RENDERER_URL`
- `VITE_THEME_MODE`

## Tool Toggles

Tool enablement is intentionally not stored in `config.yaml`.

- The Settings page persists tool toggles in the Desktop app settings file.
- The Desktop process mirrors the tool-state subset into a shared runtime file so the Driver and Brain can react without maintaining separate sources of truth.
- In development, that shared file lives at `temp/tool-settings.json`.
- In packaged builds, the Desktop process passes an app-specific path to the Driver and Brain through `ALPHOMI_TOOL_SETTINGS_PATH`.

Behavioral impact:

- Disabled tools are removed from the Driver's default `/tools` discovery response.
- Disabled tools remain blocked at execution time even if a stale client still tries to call them.
- The Brain filters disabled tools out of the runtime tool schema and also trims prompt guidance so it does not keep recommending unavailable tools.
- Changes apply to new turns immediately, and an in-flight tool call is still rejected if it targets a tool that was disabled mid-run.

### `skills`

Controls the optional skills registry integration used by the Brain.

Common settings:

- `REGISTRY_URL`
- `INSTALL_DIR`

## LLM Configuration

The Brain expects an OpenAI-compatible endpoint. `LLM_BASE_URL` can be either:

- a base URL like `https://provider.example/v1`
- a full endpoint like `https://provider.example/v1/chat/completions`
- a full responses endpoint like `https://provider.example/v1/responses`

`LLM_ENDPOINT_MODE` accepts:

- `auto`
- `chat_completions`
- `responses`

The Desktop app now owns user-managed LLM provider profiles. The effective runtime precedence for LLM fields is:

1. explicit environment variables
2. Desktop user settings stored by the Electron shell
3. `config.yaml`
4. built-in defaults

Persistence model:

- non-secret profile fields are stored in the Desktop user-data directory in `llm-settings.json`
- API keys are stored separately in `llm-secrets.json`
- when `safeStorage` is available, the Desktop encrypts those secrets before writing them to disk

Runtime behavior:

- the Desktop exposes local LLM settings APIs over IPC and the local control service
- when the effective provider comes from `config.yaml` or environment overrides, the Settings page shows that runtime-derived profile directly instead of leaving the editor blank
- saving unrelated settings does not persist that derived profile; it only becomes a user override after the user edits and saves the LLM fields
- the Brain resolves the effective LLM configuration at request time, so new turns pick up provider changes without requiring an app restart
- if the Desktop is unavailable, the Brain falls back to environment variables and `config.yaml`

If the optional LLM E2E test is run without a valid `LLM_BASE_URL`, the test skips with an explanatory message.

## Recommended Local Defaults

- Keep `HEADLESS: true` for smoke tests and CI.
- Keep `user_data.enabled: false` for deterministic debugging unless you are actively testing persistence.
- Enable `SAVE_LLM_TRACES` only when debugging model behavior, because traces can grow quickly.
- Prefer `CONTEXT_COMPRESSION_THRESHOLD_RATIO: 0.8` unless you have a strong reason to tune memory pressure.
