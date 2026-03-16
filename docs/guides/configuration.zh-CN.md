# 配置指南

[English](configuration.md) | 简体中文

## 优先级

Alphomi 按以下顺序解析配置：

1. 环境变量
2. `config.yaml`
3. `config.example.yaml` 作为本地初始化模板

如果本地还没有 `config.yaml`，`pnpm bootstrap` 会自动基于 `config.example.yaml` 创建它。

`packages/config/defaults/config.example.yaml` 是配置模板的真实来源。如果你需要把根目录副本刷新为最新版本，可以运行 `pnpm sync:config-template`。

## 主要配置区块

### `driver`

用于控制 Playwright 执行服务。

常见配置：

- `PORT`
- `HEADLESS`
- `NEW_TAB_URL`
- `DESKTOP_CONTROL_URL`
- 快照与视觉检查相关参数

### `user_data`

用于控制 cookies 与 localStorage 的持久化。

常见配置：

- `enabled`
- `mode`
- `storage_path`
- `save_interval_sec`
- `local_storage_scope`

### `brain`

用于控制 Agent 运行时与 LLM 集成。

常见配置：

- `PORT`
- `WORKFLOW_MODE`
- `CONTEXT_COMPRESSION_THRESHOLD_RATIO`
- `PRAS_URL`
- `LLM_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- trace 与日志目录

### `desktop`

用于控制 Electron 桌面壳相关行为。

常见配置：

- `DESKTOP_CONTROL_PORT`
- `NEW_TAB_URL`
- `ELECTRON_RENDERER_URL`
- `VITE_THEME_MODE`

### `skills`

用于控制 Brain 可选的 skills registry 集成。

常见配置：

- `REGISTRY_URL`
- `INSTALL_DIR`

## LLM 配置

Brain 期望连接一个兼容 OpenAI 的接口。`LLM_BASE_URL` 可以是以下任一种形式：

- 基础 URL，例如 `https://provider.example/v1`
- 完整 chat completions 端点，例如 `https://provider.example/v1/chat/completions`
- 完整 responses 端点，例如 `https://provider.example/v1/responses`

如果在没有有效 `LLM_BASE_URL` 的情况下运行可选的 LLM E2E 测试，测试会带解释性信息地跳过。

## 推荐本地默认值

- 对 smoke 测试和 CI，保持 `HEADLESS: true`
- 对需要稳定复现的问题排查，优先保持 `user_data.enabled: false`，除非你正在测试持久化行为
- 只有在排查模型行为时才开启 `SAVE_LLM_TRACES`，因为 trace 文件会增长得很快
- 除非你很明确需要调整内存压力行为，否则优先保持 `CONTEXT_COMPRESSION_THRESHOLD_RATIO: 0.8`
