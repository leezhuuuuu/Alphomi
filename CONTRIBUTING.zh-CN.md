# 参与贡献 Alphomi

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助构建 Alphomi。

## 开始之前

- 先阅读 [README.zh-CN.md](README.zh-CN.md) 了解项目定位、架构和基本启动方式。
- 阅读 [开发指南](docs/guides/development.zh-CN.md) 和 [测试指南](docs/guides/testing.zh-CN.md)。
- 如果改动涉及架构层决策，请先查看 `docs/adr/` 下的 ADR 文档。

## 贡献方向

- 桌面端贡献者可以聚焦 `apps/desktop`
- 浏览器自动化贡献者可以聚焦 `apps/driver`
- Agent 工作流贡献者可以聚焦 `apps/brain`
- 工具链、发布与文档贡献者可以聚焦 `packages/`、`tools/` 与 `docs/`

## 初始化

```bash
pnpm bootstrap
pnpm doctor
pnpm dev
```

如果本地还没有 `config.yaml`，`pnpm bootstrap` 会自动创建它。

## 开发工作流

1. 尽量把改动控制在单一层级或单一职责内
2. 行为变化或架构变化要同步更新文档
3. 先运行最小范围、最相关的检查命令
4. 涉及跨应用或打包路径的改动在落地前运行 smoke 检查
5. 尽量采用可见、可审阅的增量式改动，避免隐藏式仓库魔法
6. 如果修改协议或公共契约，要在同一个 PR 中同步更新 `packages/contracts` 和相关文档

## 验证命令

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

如果你只在单一应用内工作，也可以先跑更聚焦的命令：

```bash
pnpm --filter @alphomi/desktop typecheck
pnpm --filter @alphomi/driver build
pnpm --filter @alphomi/brain typecheck
```

## Pull Request 预期

- 说明用户可见变化，以及对架构的影响
- 明确标出配置变更、协议变更或打包变更
- 当行为、初始化流程或贡献者工作流改变时，同步更新文档
- 除非能直接解决当前问题，否则避免顺手做无关重构

## 架构与设计改动

- 如果改动会影响应用边界、发布打包、协议归属或长期维护权衡，请在 `docs/adr/` 中新增 ADR
- 如果是大迁移或多步骤工作，请写计划文档，但注意 `docs/plans/` 当前默认不纳入版本控制

## 文档规则

- 架构级变化记录在 `docs/adr/`
- 贡献者初始化与维护说明放在 `docs/guides/`
- 需要双语支持的对外核心文档，优先维护中英文镜像

## 安全

如果你发现疑似安全漏洞，请不要公开提 issue，而是按照 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 中的流程处理。
