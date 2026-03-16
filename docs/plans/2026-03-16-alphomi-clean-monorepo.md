# Alphomi Clean Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a clean Alphomi repository in `/Volumes/apfs_ssd/temp/Alphomi` that preserves the current project's functional capabilities while adopting the agreed dual-stack monorepo architecture.

**Architecture:** Reuse the proven Desktop, Driver, and Brain code paths as the feature baseline, then reorganize the repository around explicit app boundaries, shared contracts/config packages, and open-source-ready documentation. Keep release packaging unified through Electron while making development setup explicit and contributor-friendly.

**Tech Stack:** Electron, React, TypeScript, Playwright, FastAPI, Python, pnpm, turbo, uv, PyInstaller

---

### Task 1: Bootstrap the clean repository shell

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `.gitignore`
- Create: `scripts/bootstrap.sh`

**Step 1:** Define root scripts for bootstrap, dev, build, typecheck, test, and dist.

**Step 2:** Define workspace boundaries for `apps/*` and `packages/*`.

**Step 3:** Remove hidden install side effects and make Python setup explicit.

**Step 4:** Verify the shell is coherent by inspecting `pnpm run`.

### Task 2: Migrate product apps into the new repo layout

**Files:**
- Modify: `apps/desktop/**`
- Modify: `apps/driver/**`
- Modify: `apps/brain/**`
- Modify: `tools/eval-manager/**`

**Step 1:** Copy feature-complete source from the current project without build artifacts.

**Step 2:** Move Brain into a formal Python package layout under `src/alphomi_brain`.

**Step 3:** Rename package names, process paths, and resource paths to the Alphomi layout.

**Step 4:** Verify that Desktop still points at Driver and Brain correctly in dev and dist modes.

### Task 3: Add shared contracts and config packages

**Files:**
- Create: `packages/contracts/**`
- Create: `packages/config/**`
- Modify: `apps/driver/src/common/tools.ts`
- Modify: `apps/brain/src/alphomi_brain/**`

**Step 1:** Create a contracts package for schemas and protocol references.

**Step 2:** Create a config package that owns defaults and config documentation.

**Step 3:** Wire the repository to use the shared config defaults.

**Step 4:** Add docs that explain which contracts are authoritative.

### Task 4: Rebuild the docs for open-source onboarding

**Files:**
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `docs/adr/0001-adopt-dual-stack-monorepo.md`
- Create: `docs/adr/0002-ship-brain-as-bundled-binary.md`
- Create: `docs/guides/development.md`
- Create: `docs/guides/release.md`

**Step 1:** Write the top-level product and repo story.

**Step 2:** Write contributor onboarding and focused dev paths.

**Step 3:** Capture architecture choices as ADRs.

**Step 4:** Document packaging and release expectations.

### Task 5: Validate and iterate

**Files:**
- Modify: `test/**`
- Modify: `apps/**`
- Modify: `scripts/**`

**Step 1:** Install dependencies and bootstrap the repo.

**Step 2:** Run app-specific typechecks and smoke checks.

**Step 3:** Fix import, path, packaging, or environment regressions.

**Step 4:** Run end-to-end sanity checks and leave the repo in a clean, documented state.
