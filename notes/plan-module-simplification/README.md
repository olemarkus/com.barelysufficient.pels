# Plan module simplification

## Problem

The `lib/plan/` directory has 43 files (10,091 lines). The per-file size is reasonable (median
~235 lines), but the concept count is high. Tracing a single restore decision requires following
imports across 14 files:

```
planBuilder -> planRestore -> planRestoreTiming -> planTiming -> planConstants
  -> planRestoreGate -> planRestoreDevices -> planRestoreHelpers
  -> planActivationBackoff -> planRestoreSwap -> planSwapState
  -> planObservationPolicy -> planSteppedLoad -> planState
```

Each file is well-structured in isolation. The complexity cost is in the indirection between them,
not in any individual file being too large.

## Merge candidates

Files that serve the same concern, split for no clear benefit. Each merge removes import
boilerplate and one level of indirection with zero logic change.

| File | Lines | Consumers | Merge into |
|------|-------|-----------|------------|
| `planRestoreGate.ts` | 43 | 3 | `planRestoreTiming.ts` |
| `planTiming.ts` | 18 | 1 | `planRestoreTiming.ts` |
| `planSheddingStepped.ts` | 41 | 1 | `planShedding.ts` |
| `planReasonHelpers.ts` | 102 | 1 | `planReasons.ts` |
| `planServiceInternals.ts` | 64 | 2 | `planService.ts` |

Total: ~270 lines of import/export boilerplate eliminated, 5 fewer files.

`timingConstants.ts` (2 lines, 2 consumers) could also go into `planConstants.ts` or be inlined.

## Simplification candidates

### `planActivationBackoff.ts` (424 lines)

Full state machine with penalty levels 0-4, stick windows (10 min), clear windows (30 min),
diagnostic transitions, and a penalty formula using `0.15 * 2^(level-1)` for both percentage
and absolute kW additions. The problem it solves (don't keep retrying a device that fails to
activate) can be handled with a simpler exponential timer per device: block for N minutes after
failure, double N on each subsequent failure, cap at 30 min, reset after sustained success.
~60 lines instead of 424.

The diagnostic transition events are useful for observability but could be emitted from the
simpler model without the full state machine.

### Restore blocking gates in `planRestore.ts`

A device must pass 8 sequential gates before restore is allowed:

1. Inactive check (EV state, unknown power)
2. Gate check (startup / shed cooldown / restore cooldown)
3. Swap block
4. Pending swap block
5. Waiting for other recovery
6. Activation setback
7. Headroom check
8. Swap attempt (fallback)

Gates 3-4 are conceptually one check (is a swap in progress?). Gates 5-6 are both about
"system is unsettled." Collapsing these would reduce the gate count to ~5 without losing any
safety.

### Reason string generation in `planReasons.ts` (468 lines)

Reason strings are presentation concerns currently interleaved with decision logic. Every
restore/shed path carries `reason:` assignments alongside control flow. Consider generating
reasons as a post-pass over the finalized plan: the plan records a machine-readable decision
code, and reason strings are derived at the end. This would decouple the decision paths from
the display layer.

## Non-issues

- `planConstants.ts` (23 lines, 16 exports) — shared constants file, fine as-is.
- `planCandidatePower.ts` (26 lines, 3 consumers) — focused utility, fine as-is.
- `planSort.ts` (24 lines, 2 consumers) — stable sort helpers, fine as-is.
- `planObservationPolicy.ts` (56 lines, 7 consumers) — well-scoped policy, fine as-is.

## Daily budget module note

The `lib/dailyBudget/` directory is 22 files, 5,111 lines. This is more code than many complete
Homey apps. The confidence scoring subsystem alone is 549 lines. Worth auditing whether the
confidence score actually changes any control decision or is purely informational. If
informational, the 549 lines may be observability debt rather than a feature.

## Guiding principle

The goal is not fewer files for its own sake. The goal is that a developer tracing "why didn't
this device restore?" can follow the decision in fewer hops, and that concepts which always
change together live in the same file.
