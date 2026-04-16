# God-file LOC policy

> **Status:** Proposal (2026-04-16). Not ratified. Intended as input for a decision on whether and
> how to tighten max-lines enforcement.
>
> **Snapshot warning:** the LOC figures below are mixed: some come from the original review
> snapshot, while some rows were remeasured later as files changed. Several cited splits and
> extractions have already landed since then, so remeasure the files before using these numbers as
> policy input.

## Problem

The repository-wide rule is `max-lines: { max: 500 }` in `eslint.config.mjs`. Several hot-path
files are currently over that limit. The files most in need of the rule are the ones waived from
it, which makes the limit effectively unenforced in the hotspots.

Two waiver mechanisms are in use today, with no consistent policy for choosing between them:

1. **File-level pragma:** `/* eslint-disable max-lines -- <reason> */` at the top of the file.
   Opaque at review time, not visible from `eslint.config.mjs`, and sets no concrete ceiling —
   the file can grow without bound.
2. **Per-file config override** in `eslint.config.mjs` with a raised `max` value. Visible in the
   config, sets a concrete ceiling, but currently carries no recorded justification.

## Current state

### Files with a file-level `/* eslint-disable max-lines */` pragma

| File | Current LOC |
|------|-------------|
| `app.ts` | 938 (still has a config override at 750; the pragma is now the main waiver) |
| `lib/core/deviceManager.ts` | 894 |
| `lib/plan/planBuilder.ts` | 888 |
| `lib/plan/planService.ts` | 763 |
| `lib/plan/planReasons.ts` | 683 |
| `lib/plan/planShedding.ts` | 650 |
| `lib/plan/planRestore.ts` | 505 (currently at threshold; no pragma) |
| `lib/plan/planRestoreHelpers.ts` | 492 (at threshold; no pragma) |
| `lib/dailyBudget/dailyBudgetManager.ts` | 504 (at threshold; no pragma) |
| `lib/diagnostics/deviceDiagnosticsService.ts` | 1135 |
| `lib/core/deviceManagerObservation.ts` | 735 |
| `lib/app/appPowerHelpers.ts` | 898 |
| `lib/app/appDebugHelpers.ts` | 732 |
| `flowCards/registerFlowCards.ts` | 608 |

### Files with a config-level override in `eslint.config.mjs`

| File | Raised `max` | Justification in config |
|------|--------------|-------------------------|
| `app.ts` | 750 | (none) |
| `drivers/pels_insights/device.ts` | 575 | (none) |
| `lib/price/priceLowestFlowEvaluator.ts` | 525 | (none) |
| `lib/price/priceService.ts` | 560 | (none) |
| `packages/settings-ui/src/ui/power.ts` | 650 | (none) |

## Proposed policy

### 1. Replace every file-level pragma with an explicit decision

Each currently-oversized file lands in one of two buckets:

- **Bucket A — must shrink to ≤500 LOC.** No override, no pragma. The file is in breach because
  it accumulated accidentally, not because the underlying concept is intrinsically large.
- **Bucket B — documented exception with a concrete raised ceiling.** The file stays over 500 but
  the ceiling is a specific higher number, set as a per-file override in `eslint.config.mjs`, and
  accompanied by a structural justification comment.

No file lives in both buckets. No file gets a blanket waiver.

### 2. Replace file-level pragmas with config overrides for Bucket B

File-level pragmas are banned for `max-lines`. The only approved override mechanism is a per-file
block in `eslint.config.mjs`, e.g.:

```js
{
  // planExecutor dispatches one apply method per device control type. Splitting per action
  // creates >=15 files sharing executor context, which is worse to navigate than the single
  // dispatch table. Target: <=800 after shared-helper extraction (see complexity-cleanup
  // Phase 3).
  files: ['lib/plan/planExecutor.ts'],
  rules: { 'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }] },
},
```

Any future override requires the same justification pattern: a comment citing the structural
reason and a concrete target.

### 3. New files start at the default

Any new file must land under 500 LOC. A PR that creates a new file over 500 needs an up-front
override in `eslint.config.mjs` with justification. Default stance in review: ask whether the
file can be split before accepting the override.

## Classification

### Bucket A — must shrink to ≤500

| File | Current | Shrink path |
|------|---------|-------------|
| `app.ts` | 938 | Phases 4, 10, 11 (helper extractions partly landed; remaining work is delegate/timer/context cleanup). Remove the 750 config override once under 500. |
| `lib/app/appPowerHelpers.ts` | 898 | Phase 8 (split into three focused modules). |
| `lib/plan/planService.ts` | 763 | Phase 5 (snapshot-write extraction landed; rebuild-metrics remains). |
| `lib/plan/planBuilder.ts` | 888 | Extract phase helpers (context/shedding/restore/overshoot) so builder becomes orchestrator at ~300. |
| `lib/plan/planShedding.ts` | 650 | Candidate split by shed-action kind; scope during Phase 2 reason cleanup. |
| `lib/plan/planReasons.ts` | 683 | Phase 2 (decision/presentation split) plus category split (shedding / restore / price). |
| `lib/plan/planRestore.ts` | 505 | Phase 6 (collapse redundant gates) will bring this under 500. |
| `lib/plan/planRestoreHelpers.ts` | 492 | Already at threshold. Do not merge `planRestoreSupport.ts` into it; route that into `planRestoreSwap.ts` instead. |
| `lib/dailyBudget/dailyBudgetManager.ts` | 504 | Redistribute into `dailyBudgetManagerPlan.ts` / `dailyBudgetManagerSnapshot.ts` (sibling files already exist). |
| `lib/app/appDebugHelpers.ts` | 732 | Inline single-caller exports; keep the two actually-shared helpers. |
| `lib/core/deviceManagerObservation.ts` | 735 | Recent move-only split from `deviceManager.ts`. Follow up by separating retained observation/freshness merge logic from debug-source capture helpers instead of adding a new override. |

### Bucket B — documented exception with a concrete ceiling

| File | Current | Target ceiling | Structural reason |
|------|---------|----------------|-------------------|
| `lib/plan/planExecutor.ts` | 782 | 800 | The control-type split has landed, but the remaining binary-control dispatch remains a single cohesive table to avoid the cognitive load of splitting into >=10 action files. |
| `lib/core/deviceManager.ts` | 894 | 800 | Parsing / observation / settle extraction has already landed. Re-measure after follow-up cleanup to decide whether the override should target 800 or be dropped. |
| `lib/diagnostics/deviceDiagnosticsService.ts` | 1135 | 1200 | Stateful starvation diagnostics orchestration. Revisit after the `notes/starvation/` rollout finishes the remaining flow/insights/UI follow-up, which may split this naturally. |
| `flowCards/registerFlowCards.ts` | 608 | 600 | Procedural flow-card registration remains a single low-churn app-surface module; keep one central registry unless it starts accumulating deeper behavioral branches. |

The existing config overrides in `eslint.config.mjs` (`app.ts` 750, `drivers/pels_insights/device.ts`
575, the two `lib/price/` files, `packages/settings-ui/src/ui/power.ts` 650) are Bucket B today by
default; they need justification comments added. `app.ts`'s override can be dropped outright once
Phases 4/10/11 finish.

## Migration sequence

1. **Add justification comments to every existing `eslint.config.mjs` override.** No behavior
   change, ~1 PR, pure documentation. This establishes the pattern.
2. **For each Bucket B file:** add/update the config override with the target ceiling and
   justification. Remove the file-level pragma. Target ceiling should be reachable within one
   phase of the cleanup plan.
3. **For each Bucket A file:** leave the pragma in place until the planned phase lands, then
   delete the pragma in the same PR as the shrink. A Bucket A file with a pragma in `main` is a
   TODO; a Bucket A file still over 500 after its shrinking phase is a regression.
4. **Flip the rule from `warn` to `error`** once the above is done. The files list in
   `eslint.config.mjs` becomes authoritative: if you're not in the override list, you're under
   500.

## Rules for reviewing future overrides

When a PR adds or raises an override:

- Is the file in Bucket A material? Push back: shrink instead.
- Is the override target raised *because the file grew*? Push back: the override should drive the
  file toward its target, not follow it.
- Is there a justification comment? If not, block review.

## Open questions

- Should the pragma be outright banned via a lint rule (e.g.
  `no-warning-comments` targeting `eslint-disable max-lines`), or left to review discipline?
- `skipBlankLines: true, skipComments: true` means the effective LOC count is lower than `wc -l`.
  Worth recording the effective counts for each Bucket A/B file as a baseline before the cleanup
  starts, so regression detection is well-defined.
