# PELS Architecture Contract

This document defines dependency boundaries to keep changes local and reduce coupling.
The boundaries are enforced by `dependency-cruiser` (`npm run arch:check`).

## Layers

1. Entry points
- `app.ts`
- `drivers/**`
- `settings/src/script.ts`

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

5. Test code
- `test/**`
- `tests/**`

## Dependency Rules (Current)

- No circular dependencies.
- Runtime code (`app.ts`, `lib/**`, `flowCards/**`, `drivers/**`, `settings/src/**`) must not import test code.
- Runtime backend code (`app.ts`, `lib/**`, `flowCards/**`, `drivers/**`) must not import settings UI code.
- Non-entry modules must not import `app.ts`.
- Domain modules must not import `lib/app/**`.
- `flowCards/**` must not import `settings/**` or `drivers/**`.
- `drivers/**` must not import `settings/**` or test code.

## Transitional Allowances

These are intentionally allowed for now, and tracked as tightening TODOs:

- `settings/src/**` can import selected modules from `lib/core`, `lib/dailyBudget`, and `lib/price`.
- `lib/utils/**` still has a few imports from `lib/core` and `lib/plan`.

Both are flagged as warnings in architecture checks, with follow-up TODOs in `TODO.md`.
