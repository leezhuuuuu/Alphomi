# 测试指南

[English](testing.md) | 简体中文

## 快速验证

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

`pnpm smoke` 是推荐的 PR 前验证路径，因为它会覆盖跨应用工作流，而不只是单个 package 内部检查。

## 各命令覆盖范围

- `pnpm typecheck`
  验证 Electron Desktop、Playwright Driver 与 Python Brain 的源码都能正常通过类型或语义检查。
- `pnpm test`
  运行 monorepo 中定义的 package 级测试与校验。
- `pnpm smoke`
  运行跨应用 smoke 测试，在需要时自动启动本地 Driver，并执行可选的 LLM 文件编辑 E2E。
- `pnpm validate`
  运行完整的本地预发布路径：typecheck、test、smoke、Brain 二进制构建和应用构建。

`pnpm validate` 会跳过 `pnpm smoke` 内部重复的 workspace test，因此它比简单串联 `pnpm test` 和 `pnpm smoke` 更完整，同时避免重复工作。

## 可选的 LLM 集成测试

`test/llm_apply_patch_e2e.py` 需要一个有效的 `LLM_BASE_URL`，并且该地址要指向兼容 OpenAI 的 `http(s)` 接口。

你可以通过 `config.yaml` 或环境变量提供它：

```bash
export LLM_BASE_URL="https://your-provider.example/v1/chat/completions"
export LLM_API_KEY="your-api-key"
python3 test/llm_apply_patch_e2e.py
```

如果没有配置 `LLM_BASE_URL`，脚本会输出跳过说明，而不是用低信号的网络错误直接失败。

## 基于 Driver 的 Smoke 测试

`test/driver-storage-smoke.mjs` 会调用 Driver 的 REST API。

- 如果 Driver 已经在运行，它会复用 `DRIVER_URL` 或默认的 `http://127.0.0.1:13000`
- 如果你运行 `pnpm smoke`，仓库会为你临时启动本地 Driver
- 如果你直接运行脚本但本地没有 Driver，它默认会给出清晰的跳过提示

如果你希望在 CI 或本地自动化里强制失败，可以设置：

```bash
export REQUIRE_DRIVER_SMOKE=1
export REQUIRE_LLM_E2E=1
```

只有在环境明确会提供所需服务或凭据时，才建议打开这些开关。
