# Shared Persisted-Settings State Machine

## Status

Open design note. No code yet. The bug pattern that motivates this lives in three
places today; consolidating them is the proposed fix.

## Why this note exists

Three modules independently reimplement the same persistence state machine:

- `lib/device/devicePowerCalibrationStore.ts` — calibration snapshot
- `lib/objectives/deferredObjectives/planHistory.ts` — deferred-objective plan-history recorder
- `lib/objectives/deferredObjectives/activePlanRecorder.ts` — deferred-objective active-plan recorder

Each carries roughly the same shape:

- a `dirty` flag flipped on every accepted mutation
- a debounce window so `homey.settings.set` is not called per-mutation
- an abandon-grace window so a single transient corrupt SDK read on startup does
  not wipe persisted history (per `feedback_homey_sdk_unreliable`)
- a "load" path that normalises the persisted value into a typed shape
- a "plausibility" check that decides whether the loaded shape is good enough
  to skip the grace window
- one or more "flush" call sites (shutdown, prune, batch boundary) that need
  variants of the same write-then-mark-clean dance

Calibration accumulated all of this from scratch during PR #710 and produced
~10 bot-review findings across four rounds. Every finding was correct. None of
them touched the calibration math itself — they were all about the persistence
wrapper:

| Round | Finding                                                       |
| ----- | ------------------------------------------------------------- |
| 1     | `takeIfDirty` cleared `dirty` before the settings write       |
| 1     | Plausibility predicate too lax (top-level only)               |
| 1     | Freshness gate bypassed when `dataObservedAtMs` was undefined |
| 3     | `loadPowerTracker` reloaded calibration on every tracker write |
| 3     | `onUninit` did not flush the store                            |
| 4     | Plausibility predicate did not recurse into nested records    |
| 4     | `onUninit` flush bypassed the load-grace window               |
| 4     | Boost gate treated warm-up samples as authoritative           |

The deferred-objective recorders almost certainly have the same bugs in some
form. They have not had bot reviewers staring at them as recently, so the bugs
are latent rather than fixed.

## What a shared helper would carry

A single `PersistedSettingsState<T>` (or `RecorderState<T>`) class encapsulating:

1. **In-memory snapshot** of type `T`, mutated via `update(fn)` which both
   applies the change and flips `dirty`.
2. **Dirty tracking that only clears on successful write** — the write callback
   is the gate, not the read. Pattern: `commit(write)` accepts a sync/async
   writer and only flips `dirty=false` when the writer returns true.
3. **Debounce window** so callers can do `if (state.shouldPersistNow(nowMs)) state.commit(...)`
   without hand-rolling timers.
4. **Abandon-grace window** parameterised on load: when the raw read failed the
   plausibility check, the state refuses to persist for `loadGraceMs` so a
   subsequent recovery read can still rebuild from disk. A separate
   "we've-written-before" marker setting distinguishes a true fresh install
   (no marker, raw absent → no grace; first sample persists immediately) from
   a transient SDK miss (marker set, raw absent → grace engages); a malformed
   raw payload always engages grace regardless of marker. The calibration
   wiring uses `power_calibration_initialized` for this; the shared helper
   should accept a marker-key option.
5. **Plausibility predicate** supplied by the consumer (the schema). Generic
   default rejects only `undefined`/`null`/non-object; consumers tighten via a
   `Strict<T>` validator. Crucially, the strict validator must recurse to match
   whatever the normaliser would silently drop — otherwise nested corruption
   sneaks past plausibility into the persist cycle.
6. **Flush variants** — debounced vs gate-bypassing. Both must still honor
   `loadGraceMs` (the protection grace is the whole point; flush should bypass
   debounce only).
7. **Normalisation** is consumer-provided. The state stays generic; the
   consumer hands in `parse(raw): T | null` and `serialize(value): unknown`.

The contract: every mutation goes through `update`; every write goes through
`commit`; the state's invariant is "the `dirty` flag is `true` iff there are
pending changes that haven't reached `homey.settings.set`."

## Migration plan

1. Build `PersistedSettingsState<T>` in `lib/utils/` or a new `lib/persistence/`
   with the seven properties above and full unit-test coverage of the state
   transitions.
2. Migrate `PowerCalibrationStore` first — it is the freshest module, has the
   most behavioural coverage, and is the cleanest test of the API surface. The
   migration should be near-mechanical: extract calibration-specific logic
   (ingest, prune, query) and let `PersistedSettingsState` own the rest.
3. Migrate `DeferredObjectiveActivePlanRecorder` and
   `DeferredObjectivePlanHistoryRecorder`. Expect this migration to surface
   latent bugs (likely the same shapes as the calibration findings) which the
   shared helper now fixes for free.
4. The migration is invasive but mechanical. Each step is a separate PR; the
   first PR (build the helper + migrate calibration) is the test of the API.

## What the consumer keeps

After migration, a recorder file like `devicePowerCalibrationStore.ts` should
hold only:

- the `T` type (or import it)
- `parse(raw): T | null` — normalise unknown
- `isPlausible(raw): boolean` — strict structural validator
- the domain operations (`ingestDeviceSnapshot`, `prune`, queries)
- a thin wrapper that wires the above into `new PersistedSettingsState<T>(...)`

No `dirty` flag, no debounce timer, no grace window, no flush variants, no
`markPersisted`. All of those move into the shared helper.

## Risk

The pattern is currently divergent in subtle ways across the three recorders:

- Calibration's grace defaults to 5 minutes; the deferred-objective recorders
  use different windows.
- The calibration plausibility predicate is now strict; the recorders are
  more lenient.
- Flush semantics differ — calibration's `Flush` respects grace as of PR #710
  round 4; the recorders' equivalents may not.

The shared helper must surface these as explicit options rather than freezing
one of the variants as the new default. The migration PRs should be careful
to preserve each consumer's existing semantics, then converge in a follow-up.

## Why not just leave it

The bug pattern is now well-validated (~10 finds across four rounds in PR
#710). The same review attention has not been applied to the deferred-objective
recorders since they shipped. The most likely outcome of leaving the
duplication is the same bugs re-emerging in those modules when bot reviewers
next examine them. Centralising the pattern locks in PR #710's fixes for all
three sites.
