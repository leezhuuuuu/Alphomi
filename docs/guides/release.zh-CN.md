# 发布指南

[English](release.md) | 简体中文

## 目标

在保持源码开发开放、模块化的前提下，产出一个统一的桌面安装包。

## 构建流程

1. 构建 Python Brain 二进制
2. 构建 Desktop 与 Driver 应用产物
3. 使用 Electron 将 Driver 资源和 Brain 二进制打包成桌面产品

## 命令

```bash
pnpm run build:brain
pnpm run build
pnpm run dist:mac
```

如果只是做本地 dry run，不需要签名安装包，也可以构建解包版本：

```bash
pnpm run package:mac:dir
```

## 发布产物

- macOS DMG
- Windows NSIS 安装包
- Linux AppImage

## 注意事项

- 仓库里仍然保留基于源码的 Brain 开发方式
- 正式发布构建应优先走内置 Brain 二进制路径
- macOS notarization 和平台签名应由维护者在正式发布流程中补上
- 保持 `config.example.yaml` 与打包产物兼容，因为安装包会把它作为默认运行时配置嵌入
- 根级 `build` 脚本有意排除了 Brain 二进制；正式打包时应组合使用 `build:brain` 与 `build`
