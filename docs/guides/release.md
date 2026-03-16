# Release Guide

## Goal

Ship one desktop installer while keeping source development open and modular.

## Build Flow

1. Build the Python brain binary
2. Build the desktop and driver apps
3. Package the Electron product with embedded driver assets and brain binary

## Commands

```bash
pnpm run build:brain
pnpm run build
pnpm run dist:mac
```

For local dry runs without a signed installer, you can also build the unpacked app:

```bash
pnpm run package:mac:dir
```

## Release Artifacts

- macOS DMG
- Windows NSIS installer
- Linux AppImage

## Notes

- Brain source-based development remains available in the repo
- Release builds should prefer the bundled brain binary path
- macOS notarization and platform signing should be layered on by maintainers during formal release work
- Keep `config.example.yaml` compatible with the bundled app, because the packaged product embeds it as the default runtime config
- The root `build` script excludes the Brain binary on purpose; packaged releases should use `build:brain` plus `build`
