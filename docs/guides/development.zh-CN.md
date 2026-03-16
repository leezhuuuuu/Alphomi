# 开发指南

[English](development.md) | 简体中文

## 推荐启动方式

```bash
pnpm bootstrap
pnpm doctor
pnpm dev
```

如果缺少 `config.yaml`，`pnpm bootstrap` 会基于 `config.example.yaml` 自动创建。

## 聚焦式工作流

### 只跑 Desktop

```bash
pnpm dev:desktop
```

### 只跑 Driver

```bash
pnpm dev:driver
```

### 只跑 Brain

```bash
pnpm dev:brain
```

## 验证循环

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

共享层检查已经纳入仓库级验证流程，包括：

- `packages/contracts` 中的 JSON schema 校验
- `packages/config` 中的配置模板同步检查

## 配置

- 根目录便捷模板：`config.example.yaml`
- 配置真实来源：`packages/config/defaults/config.example.yaml`
- 参考文档：[配置指南](configuration.zh-CN.md)
