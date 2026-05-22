# Feasibility & learned-rate confidence (Cause #1)

Why smart-task verdicts (`cannot_meet` / `on_track`) flip on a volatile learned
rate, and what the fix actually is. This corrects the original P0 framing in
`TODO.md` ("rate never converges / fix sample-rejection / make bands engage"),
which the prod logs disprove.

Companion to `feasibility-floor-vs-climbed-band.md` (Slice 1, shipped): that note
handles the *step* axis (floor vs climbed band); this one handles the *rate*
axis (how confident we are in kWh-per-unit).

## What a sample is

Per device, per planning cycle, `buildObjectiveProfileSample`
(`lib/core/objectiveProfileSamples.ts`) captures:

- `value` — the objective quantity (°C for thermostats, % SoC for EVs).
- `observedAtMs` — the **sensor's own freshness timestamp** (`lastFreshDataMs`
  / `stateOfCharge.observedAtMs`), not PELS wall-clock.
- `crediblePowerW` — measured power if present, else the reported step's
  planning power; **absent when the device isn't drawing**.

Two consecutive samples yield the learned rate:
`kwhPerUnit = crediblePowerW × Δt / Δvalue` (energy) and
`unitPerHour = Δvalue / Δt` (speed). `energyNeededKWh = remainingUnits ×
kwhPerUnit` is what the horizon planner sizes feasibility against.

## What the prod logs (2026-05-22, `0a4464c3`) actually show

Sampled the `objective_profile_*` structured events:

- **Rejections are mostly harmless skips, not data loss.** 24/44 are
  `non_monotonic_time` — the sensor's `lastFreshDataMs` not advancing between
  faster PELS polls (duplicate timestamp). `buildRejectedProfileSample` does
  **not** advance the baseline for these, so the next real rise still
  integrates the full elapsed interval. Energy is not lost.
- **No-power intervals are already excluded from the energy estimate.** Every
  `powerSource:null` sample logs `kwhPerUnit:null, energyKwh:null`
  (`calculateEnergyKwh` returns `undefined` when `crediblePowerW` is absent).
  Idle/coast drift never pollutes kWh/unit. The "if power fell to 0 we can't
  infer kWh/unit" rule is **already implemented** — but only for power = 0, not
  for power *variation* (see the poisoning vector below).
- **Samples converge and bands engage.** Mature devices reach
  `acceptedSamples:500+`, `bufferedSamples:64` (ring-buffer cap), `bandsCount:2`.
- **The buffer is persisted.** It rides in `power_tracker_state`
  (`PowerTrackerState.objectiveProfiles`), saved every persist tick and
  reloaded at startup; retention is 30 days (`OBJECTIVE_PROFILE_RETENTION_MS`).
  A transient empty SDK read leaves the in-memory state untouched (`app.ts`
  `loadPowerTracker` only assigns when `isPowerTrackerState` passes).

So the original P0 sub-causes about *convergence/storage* don't hold: samples
converge, bands fit, storage persists. But the samples are **not clean** — see
below.

## Active poisoning vector: single-point power over a variable-power interval

`calculateEnergyKwh` bills the **entire baseline→rise interval at the baseline
sample's single `crediblePowerW`** (`objectiveProfiles.ts:429` —
`previousSample.crediblePowerW × intervalMs`). That is correct only when power
was constant across the interval. It is **not** constant for stepped/variable
devices.

Evidence (`/tmp/pels` 2026-05-22, the "Connected 300" device): per-interval
implied power (`energyKwh / intervalHours`) lands on three discrete levels —
**1193 W, 1671 W, 2865 W** — i.e. the device runs low/medium/high steps. Within
a single 5-minute accepted interval, any mid-window step change is mis-attributed:
the whole rise is charged at the baseline step's power. The intermediate samples
that carry the true power profile are *discarded* (rejected as `rise_too_small`,
baseline preserved), so their power is never used.

Consequence: this inflates the `kwhPerUnit` spread (the logs' `0.09 → 0.26`
swing is part stratification, part this mis-attribution), which is **the reason
confidence is pinned `low`** — see below. So poisoning and the confidence floor
are the same problem viewed twice.

Fix: **accumulate energy across sub-intervals** using each sample's own
`crediblePowerW` (`Σ crediblePowerW_i × Δt_i`) instead of one baseline reading.
The running accumulator is in-progress state spanning multiple cycles, so it must
be **persisted on `DeviceObjectiveProfile`** alongside `lastSample` — otherwise a
restart or settings-driven reload mid-interval drops the partial sum and
under-counts the energy when the value finally moves.
A flat-value-but-still-powered sample stays a baseline-preserving skip whose
power×time is *added to a running energy total*; the kWh/unit is emitted when the
value finally moves. Per the power-continuity rule, if any sub-interval shows
power = 0, the window is thermally contaminated (coasting, not electrical heat) →
reset the baseline and discard the partial accumulator rather than averaging it.

## The real gap: two coupled problems

**(i) The verdict ignores confidence.** `horizonPlanner` / `bucketAllocation` /
`rescueReplan` consume **no confidence value** — grep is empty. The verdict is
computed purely from whether the point-estimate `energyNeededKWh` fits the
buckets. So when `kwhPerUnit` is volatile (`0.09 → 0.26` kWh/°C in the logs:
part real stratification, part the power mis-attribution above), the *headline
flips* between `cannot_meet` and `on_track` even though the model reports `low`
confidence.

**(ii) Confidence is pinned `low`, so it is not yet usable as a gate.** In prod,
`energyConfidence` is `low` 22/24 samples, `medium` once, never `high`. Fixing
(i) by mapping `low → at_risk` would therefore relabel *almost every* task a
permanent "At risk" — as useless as the false "Cannot finish" it replaces. So
(ii) is a **prerequisite for (i)**, not a follow-up. The poisoning vector above
is one driver of the low confidence; the dispersion model is the other (below).

The confidence signal already exists and is already band-aware:
`profileEnergyResolution.resolveDisplayConfidence` returns `min(band.confidence)`
over the bands overlapping `[current, target]`, falling back to the global
`kWhPerUnit.confidence`. It's surfaced to diagnostics as `displayConfidence` and
drives the UI chip — but the planner never reads it for the verdict.

### Fix — three steps, in dependency order

The end state is confidence-aware feasibility, but it cannot ship first.

**Step 1 (prerequisite) — stop poisoning the estimate. ✅ SHIPPED.** Accumulate
energy across sub-intervals (`Σ crediblePowerW_i × Δt_i`, persisted on the
profile as `pendingEnergyKWh`/`subIntervalStartMs`/`subIntervalPowerW` per the
poisoning section) and invalidate the window on a power-=0 sub-interval. The
`rise_too_small` skips that used to be discarded now bank their sub-interval
energy at their own left-edge power; the accept emits `pending + final
sub-interval`; baseline resets (accept / value-fell / interval-too-long /
recovery / contamination) clear the accumulator. No-skip windows stay
byte-identical to the old single-baseline bill. This tightens the real
`kwhPerUnit` dispersion so confidence can actually rise — Step 2's prerequisite.

**Step 2 (prerequisite) — make confidence escape `low`.** Even with clean
samples, `resolveProfileConfidence` measures dispersion as relative-std-dev of a
*single global mean*, which is structurally wrong once bands exist — a well-fit
U-curve reports high global variance *because* the bands captured real
structure. Judge confidence by **within-band residual**. (Note the band cap is
not the constraint: `OBJECTIVE_PROFILE_MAX_BANDS` is already `4`; prod fits only
`bandsCount:2`, so the lever is split *quality* — e.g. the
`MIN_SSE_REDUCTION_FRACTION` split threshold — not raising the constant.) Without
this, confidence stays `low` and Step 3 degenerates to permanent "At risk."

**Step 3 (the lever) — confidence-aware verdict.** Prefer a **continuous margin**
over the 3-level enum: have `profileEnergyResolution` emit `energyNeededKWh`
*plus* a `± margin` derived from the in-use band's residual (`k·σ`). The planner
treats a shortfall inside the margin as `at_risk` (new detail
`estimate_uncertain`) rather than a confident `cannot_meet`/`on_track`. The
continuous margin avoids the enum's all-or-nothing trap: a tight-but-"low"
device gets a *narrow* band and can still read `on_track` or a genuine
`cannot_meet`; only real dispersion widens to `at_risk`. Resolution stays in the
producer — the planner consumes the flat `(energyNeededKWh, margin)` pair, never
per-band fields (`feedback_layering_resolution_in_producer`). Composes with the
Slice 1 floor-vs-climbed banding (same "don't assert a flat constant"
philosophy, now on the rate axis), and needs the `pels-copy-and-terminology`
gate so `at_risk` doesn't become an unactionable catch-all.

Validation gate before building Step 3: instrument `displayConfidence` /
band-residual at plan time and confirm mature devices reach `medium`/`high` after
Steps 1–2. If they don't, Step 3 is still premature.

Out of scope here: the P0's **missed-history** half (post-hoc classification of
finalized runs) is a separate item; confidence-aware *live* verdicts don't
re-label history.

## Secondary / deferred

- **P3 telemetry — `unitPerHour` pollution.** The speed stat *does* fold in
  no-power coast intervals (0.2–2 °/hr) alongside powered heating (8–31 °/hr),
  so its `confidence` (logged as the `objective_profile_sample_recorded`
  `rateConfidence` field) is pinned `low`. But `unitPerHour` is **consumed
  nowhere** outside that debug field — the planner-facing `rateConfidence` is
  `kWhPerUnit.confidence`, not the speed stat. So this is telemetry clarity
  only: apply the same no-power exclusion the energy stat uses, or stop logging
  it as "rate confidence." No functional impact.
