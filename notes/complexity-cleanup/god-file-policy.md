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

Remeasured with `wc -l` on 2026-05-13. Effective ESLint line counts may differ because the rule
skips blank lines and comments.

| File | LOC | Current direction |
|---|---:|---|
| `lib/core/deviceManager.ts` | 1993 | Bucket B for now; only split further on a clear subsystem boundary. |
| `app.ts` | 1635 | Bucket A: continue lifecycle/context shrink. |
| `lib/diagnostics/deviceDiagnosticsService.ts` | 1294 | Bucket B until starvation flows/insights split naturally. |
| `lib/plan/planRestore.ts` | 1287 | Bucket A: reduce repeated restore gates/wrappers. |
| `flowCards/registerFlowCards.ts` | 1148 | Bucket B unless registration gains deeper behavior. |
| `lib/plan/planBuilder.ts` | 1102 | Bucket A: keep extracting focused builder helpers as ownership clarifies. |
| `lib/plan/planReasons.ts` | 1027 | Bucket A: continue decision/render boundary cleanup. |
| `lib/core/deviceManagerObservation.ts` | 978 | Bucket A: separate observation/freshness merge from debug-source capture if still useful. |
| `lib/plan/planService.ts` | 860 | Bucket A: extract rebuild metrics/tracing. |
| `lib/executor/planExecutor.ts` | 833 | Bucket B for now: remaining dispatch is intentionally centralized. |
| `packages/settings-ui/src/ui/views/BudgetOverview.tsx` | 808 | Bucket A: split per-surface view logic once Budget UI settles. |
| `lib/executor/steppedLoadExecutor.ts` | 774 | Bucket B for now: stepped execution sequencing stays local. |
| `lib/app/appDebugHelpers.ts` | 756 | Bucket A: inline single-caller debug dump helpers. |
| `lib/plan/planRestoreHelpers.ts` | 736 | Bucket A: shrink alongside restore wrapper/gate cleanup. |
| `packages/settings-ui/src/ui/views/DeadlinePlan.tsx` | 682 | Bucket A: split chart/view helpers when adding usage-history follow-up. |
| `lib/app/appPowerRebuildScheduler.ts` | 651 | Bucket A: finish post-unification scheduler cleanup. |
| `lib/price/priceService.ts` | 607 | Bucket B while spot/grid orchestration remains local. |
| `lib/plan/planActivationBackoff.ts` | 576 | Bucket A: revisit after restore admission cleanup. |
| `packages/settings-ui/src/ui/components.ts` | 570 | Bucket B for shared UI primitives unless it keeps growing. |
| `packages/settings-ui/src/ui/power.ts` | 566 | Bucket B while the page remains one cohesive screen module. |
| `packages/settings-ui/src/ui/budgetRedesign.ts` | 563 | Bucket A: move per-surface resolvers out. |
| `lib/executor/targetExecutor.ts` | 555 | Bucket B for target-command sequencing. |
| `packages/settings-ui/src/ui/deadlinePlan.ts` | 550 | Bucket A: split route/read-model helpers when deadline UI grows again. |
| `lib/dailyBudget/dailyBudgetService.ts` | 549 | Bucket A: extract snapshot/seeding helpers. |
| `lib/dailyBudget/dailyBudgetConfidence.ts` | 549 | Bucket A: audit whether the scoring affects decisions. |
| `packages/settings-ui/src/ui/priceConfig.ts` | 537 | Bucket A: split price-source and threshold UI helpers if touched. |
| `packages/settings-ui/src/ui/dailyBudgetChartEcharts.ts` | 533 | Bucket B while ECharts wiring stays isolated. |
| `packages/settings-ui/src/ui/advanced.ts` | 529 | Bucket A: split advanced surfaces by destination. |
| `packages/settings-ui/src/ui/dailyBudget.ts` | 526 | Bucket A: shrink after Budget redesign settles. |
| `packages/settings-ui/src/ui/deviceDetail/index.ts` | 525 | Bucket A: continue device-detail ownership split. |
| `lib/core/objectiveProfiles.ts` | 519 | Bucket B while objective profiling remains one cohesive store. |
| `packages/settings-ui/src/ui/budgetRedesignChart.ts` | 516 | Bucket A: split chart scale/series helpers if touched. |
| `lib/app/appInit.ts` | 516 | Bucket A: delete or inline once remaining adapter value is gone. |
| `lib/core/powerTracker.ts` | 512 | Bucket A: normalize persisted/runtime state boundaries. |
| `lib/app/appDeviceControlHelpers.ts` | 510 | Bucket A: trim or split by control surface. |
| `lib/core/deviceManagerParseDevice.ts` | 501 | Bucket A: keep under default after next helper extraction. |
| `lib/app/appPowerHelpers.ts` | 15 | No longer a god file; old Phase 8 split has landed. |

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
