# God-File LOC Policy

> **Status:** Proposal. Not ratified. Intended as input for tightening `max-lines` enforcement.

## Problem

The repository-wide rule is `max-lines: { max: 500 }` in `eslint.config.mjs`. Several hot-path
files are still over that limit, and some use file-level `/* eslint-disable max-lines */` pragmas.
Those pragmas hide the most important files from the rule and set no concrete ceiling.

Config-level overrides are better because they are visible in one place and can carry a target
ceiling plus a short structural justification. Several overrides now have those comments; the
remaining cleanup is to remove broad file-level pragmas or classify them as explicit exceptions.

## Policy Proposal

Each oversized file should land in one of two buckets:

- **Bucket A - must shrink to <=500 LOC.** The file accumulated accidentally. Keep the TODO until
  the planned shrink lands, then remove the pragma or override.
- **Bucket B - documented exception with a concrete raised ceiling.** The file stays over 500
  because the concept is intentionally centralized. The exception lives in `eslint.config.mjs`
  with a comment and a target ceiling.

No file should have both a blanket pragma and a config-level ceiling indefinitely.

## Current State Snapshot

The full list of oversized files churns constantly, so it is not frozen here. Regenerate the
current set on demand:

```bash
find lib setup flowCards drivers widgets packages/*/src app.ts api.ts \
  -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.spec.ts' \
  -exec wc -l {} + | awk '$1>500 && $2!="total"' | sort -rn
```

As of 2026-05-30 roughly 50 source files exceed the 500-LOC rule. Most are Bucket A (accidental
growth — shrink when next touched) and need no per-file note. Effective ESLint counts run lower
than `wc -l` because the rule skips blank lines and comments.

The rows worth tracking are the **Bucket B documented exceptions** — files intentionally over the
limit because the concept is centralized. These are the entries that belong in `eslint.config.mjs`
with a ceiling and rationale:

| File | LOC (2026-05-30) | Why it stays a documented exception |
|---|---:|---|
| `lib/device/deviceTransport.ts` | 2299 | Centralized device transport; only split on a clear subsystem boundary. (Renamed from `lib/device/manager.ts` in the observer/transport split; grew with binarySettle ops + observedStateDispatcher wiring.) |
| `lib/diagnostics/deviceDiagnosticsService.ts` | 1270 | Holds until starvation flows/insights split out naturally. |
| `flowCards/registerFlowCards.ts` | 1146 | Flat registration surface; only split if registration gains deeper behavior. |
| `lib/executor/planExecutor.ts` | 822 | Remaining dispatch is intentionally centralized. |
| `lib/executor/steppedLoadExecutor.ts` | 788 | Stepped execution sequencing stays local. |
| `lib/objectives/profiles.ts` | 590 | One cohesive objective-profiling store. |
| `lib/executor/targetExecutor.ts` | 575 | Target-command sequencing stays local. |
| `packages/settings-ui/src/ui/components.ts` | 573 | Shared UI primitives unless it keeps growing. |
| `lib/price/priceService.ts` | 531 | Spot/grid orchestration remains local. |

Everything else over 500 is Bucket A: shrink and drop the file-level pragma when the file is next
touched. Use the regen command above rather than maintaining a frozen Bucket A list here.

## Migration Sequence

1. Add or keep justification comments for config-level overrides that are intentionally Bucket B.
2. For Bucket A files, shrink first and remove the file-level pragma in the same PR.
3. For Bucket B files, move any remaining blanket pragma into `eslint.config.mjs` with a concrete
   ceiling and rationale.
4. Consider flipping `max-lines` from warning to error only after the override list is authoritative.

## Review Rules

When a PR adds or raises an override:

- Is this Bucket A material? Prefer shrinking instead.
- Is the target being raised only because the file grew? Push back.
- Is there a structural justification comment? If not, block the override.
