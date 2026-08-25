# Shared Persisted-Settings State Machine

## Status

Cut as of the 2026-05-31 layering review. Do not build a shared
`PersistedSettingsState<T>` helper from this proposal.

The stores share vocabulary (`dirty`, debounce, flush) but not semantics:
`planHistory.ts` owns objective-run lifecycle finalization, calibration owns its
own data-quality gates, and the active-plan recorder owns commitment/freeze
policy. A generic helper would have to absorb those different policies,
increasing coupling and indirection while removing little. This note remains as
the rationale for not re-raising the refactor.

### Addendum (2026-08-25): first-write recovery and the persist guard

The abandon-grace window alone only *postpones* the destructive reset: nothing
re-read the recoverable value, so the first accepted write after the grace
still overwrote real history with empty-derived state. The calibration store
and the EV car-link store (each per-store, per the ruling above) now add:

- **First-write recovery re-read** — while the boot read was suspect (grace
  engaged), the write path re-reads the persisted value before its first
  `settings.set`. A present value is normalised, pruned, and merged *under*
  the in-memory accepted state (in-memory wins per key — per (device, step)
  for calibration; recovered history fills everything else; the EV store
  deliberately does **not** refill `sessions` from the recovered side, since
  in-memory absence cannot distinguish "never seen" from "cleared by an
  observed session end since boot"). Absent value + no marker writes
  immediately (nothing to recover). Absent value + marker present defers the
  write for a bounded window armed by that arm's **own first deferred
  attempt** — not by boot, and not shared with the thrown arm, so a store
  whose first mutation arrives hours later (or whose reads threw for a long
  stretch before healing into an absent read) still gets its full run of
  spaced re-reads — then treats the value as genuinely gone (writing over an
  absent key destroys nothing). A *thrown* re-read defers with **no**
  deadline: every retry re-reads, so a healed SDK recovers the history,
  whereas abandoning on a clock would overwrite it at exactly the moment the
  SDK heals; past its own deferral window the deferral log escalates to
  `warn` so a permanent read stall is triagable. Recovery attempts are throttled to one
  per persist-debounce window (the ordinary debounce never advances before
  the first successful write, so without the throttle the deferral path
  would re-read and log on every 10 s power sample). One honest limit: when
  the grace engaged because the persisted value was *malformed* (not absent),
  the re-read sees the same bytes and recovers only what the lenient
  normaliser already salvaged at boot — unparseable data stays unparseable.
- **Persist guard** — a 65 s interval per store (`powerCalibrationPersistGuard`
  in `setup/appPowerTracker.ts`, `evCarLinkPersistGuard` in
  `setup/appInit/evCarLinkAccess.ts`; slightly above the 60 s debounce so the
  tick after a successful write is not knife-edged out) that retries
  `persist*IfDue` while the store is dirty. Without it, a failed write or a mutation that landed inside
  the debounce sat memory-only until the next mutation or the shutdown flush —
  and production PELS is routinely OOM-killed before `onUninit` runs, so the
  shutdown flush is a bonus, not the mechanism.

The pre-shed anchor store (`setup/preShedAnchorStoreAdapter.ts`, 2026-08-25)
is a fourth per-store implementation of the pattern, per the ruling above:
write-through persistence (no debounce — mutations are rare and restarts are
routinely unclean), marker key + `getKeys()` cross-check on the boot read,
abandon-grace on a suspect read, dirty cleared only on a successful write and
retried on the next mutation. It covers this addendum's first-write concern
in a simpler shape fitting its tiny record: no write happens during the grace
window at all — every access re-reads the persisted value until it recovers
or the grace expires, and captures that arrive meanwhile are deferred
record-if-absent, so a recovered blob always wins over anything decided while
it was unreadable.

## Historical Proposal

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
