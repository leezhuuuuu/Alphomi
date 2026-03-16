# Development Guide

English | [简体中文](development.zh-CN.md)

## Preferred Setup

```bash
pnpm bootstrap
pnpm doctor
pnpm dev
```

`pnpm bootstrap` creates `config.yaml` from `config.example.yaml` if it is missing.

## Focused Workflows

### Desktop Only

```bash
pnpm dev:desktop
```

### Driver Only

```bash
pnpm dev:driver
```

### Brain Only

```bash
pnpm dev:brain
```

## Validation Loop

```bash
pnpm doctor
pnpm typecheck
pnpm test
pnpm smoke
pnpm validate
```

Shared-layer checks are included in the workspace validation flow, including:

- JSON schema validation in `packages/contracts`
- config template sync checks in `packages/config`

## Config

- Root convenience template: `config.example.yaml`
- Source of truth: `packages/config/defaults/config.example.yaml`
- Reference: `docs/guides/configuration.md`
