---
title: Architecture Contract
description: Dependency boundaries that keep runtime code, settings UI code, and shared modules from bleeding into each other.
---

# PELS Architecture Contract

This document defines dependency boundaries to keep changes local and reduce coupling.
The boundaries are enforced by `dependency-cruiser` (`npm run arch:check`).

## Layers

1. Entry points
- `app.ts`
- `drivers/**`
- `packages/settings-ui/src/script.ts`

2. App wiring and adapters
- `lib/app/**`
- `flowCards/**`

3. Domain modules
- `lib/core/**`
- `lib/plan/**`
- `lib/price/**`
- `lib/dailyBudget/**`

4. Shared utilities
- `lib/utils/**`
- `packages/contracts/src/**`
- `packages/shared-domain/src/**`

5. Test code
- `test/**`
- `packages/settings-ui/test/**`
- `packages/settings-ui/tests/**`

## Dependency Rules (Current)

- No circular dependencies.
- Runtime code (`app.ts`, `lib/**`, `flowCards/**`, `drivers/**`, `packages/**/src/**`) must not import test code.
- Runtime backend code (`app.ts`, `lib/**`, `flowCards/**`, `drivers/**`) must not import settings UI code.
- Settings UI code must not import runtime backend code directly; it must consume shared contracts and shared-domain modules instead.
- Non-entry modules must not import `app.ts`.
- Domain modules must not import `lib/app/**`.
- `flowCards/**` must not import `packages/settings-ui/**` or `drivers/**`.
- `drivers/**` must not import `packages/settings-ui/**` or test code.

## Transitional Allowances

These are intentionally allowed for now, and tracked as tightening TODOs:

- `lib/utils/**` still has a few imports from `lib/core` and `lib/plan`.

Shared packages are now the only allowed bridge between the settings UI and runtime code.
The remaining `lib/utils/**` layering issue is still tracked in `TODO.md`.
