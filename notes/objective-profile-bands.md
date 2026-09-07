# Objective profile bands — adaptive kWh-per-unit learning

## Why this exists

A single global `kWhPerUnit` mean per device is wrong for two known device shapes:

- **Water heaters / thermostats**: heat losses scale with ΔT-to-ambient, and a bottom-mounted temperature sensor reads cold for the first degrees of any cycle (stratification — hot water rises away from the sensor). The result is a U-shape: early degrees slow, middle fast, last degrees slow. A linear estimator under-estimates near the setpoint.
- **EV chargers**: constant-power charging up to ~80% SoC, then CV-phase taper. A linear estimator under-estimates the kWh needed to reach 100%.

#775 fixed the orthogonal problem of refill-cycle pollution (sharp temperature drops after a hot-water draw). This change adds the actual non-linear model the estimator needs.

## Design

### Per-device ring buffer

Each `DeviceObjectiveProfile` keeps up to `OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE = 64` recent `{observedAtMs, inputValue, kwhPerUnit}` tuples. New samples push to the end; older ones are dropped past the cap **and past `OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS = 14 days`**. The buffer is persisted as the tracker's `objectiveProfiles` scalar in the userdata store (`lib/power/trackerStore.ts`).

**The buffer is the single record of what the device costs per unit.** Both derived views are rebuilt from it whenever an observation is recorded: `bands` by the fitter below, and the global `kwhPerUnit` stat by `resolveKwhPerUnitStat`. That is why the global stat is *derived* rather than accumulated with Welford as it once was — a running pair cannot have an aged-out window removed from it, so an expired observation would have stayed in the mean for the life of the profile while the buffer had moved on. `resolveProfileEnergy` sizes every smart task from that mean, so the horizon has to reach it.

Consequence: `kwhPerUnit.sampleCount` counts what the buffer currently holds (≤ 64, within horizon), not a lifetime total. `profile.acceptedSamples` is the lifetime counter, and it is the one provenance reports (`kwhPerUnitAcceptedSamples`).

`inputValue` is tagged with the **midpoint** of the rise (`(previousSample.value + sample.value) / 2`) rather than the start or end. This reflects where the energy was actually deposited along the input axis.

The buffer is updated only when `kWhPerUnit` is known (`crediblePowerW` was present on the previous sample) and the window passed the learned energy band. Refused windows are not added — every rejection path returns before `buildAcceptedProfileSample` runs — and a refusal that voids the window also resets the baseline and drops the partial energy sum, so the refused window is discarded rather than deferred into the next one.

#### Requirement: a credible power source must be available per accepted sample

`crediblePowerW` is resolved by `resolveCredibleDevicePower` in `lib/objectives/samples.ts`. It draws from one of two sources:

1. `currentDrawKw` — the producer-resolved draw, i.e. an inline meter on the device capability set. The raw `measuredPowerKw` does not reach this layer; the wiring (`setup/powerSamplePipeline.ts`) resolves it, and a device with no meter arrives as `0`, which fails the 5 W credibility floor.
2. `steppedLoadProfile.steps[reportedStepId].planningPowerW` — the user-configured planning power for the device's currently reported step.

If neither is available, `crediblePowerW` is omitted from the sample. The next accepted sample then enters `buildAcceptedProfileSample` with `windowEnergyKwh = undefined` (the open sub-interval has no left-edge power), so `kwhPerUnit` is `undefined`, `resolveBandedUpdate` returns `{}`, and the band buffer never grows. Adaptive learning silently stalls.

For thermostats without an inline meter, configure a per-step `planningPowerW` on the device's stepped-load profile. Without one, energy training is effectively disabled regardless of accepted-sample count.

#### `objective_profile_no_power_source` diagnostic

After `OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD = 20` consecutive accepted samples whose own `crediblePowerW` is absent or non-positive, `buildAcceptedProfileSample` emits a one-shot `objective_profile_no_power_source` structured event carrying `{deviceId, deviceName, profileKind, acceptedSamples, consecutiveSamplesWithoutPower, threshold}`. The diagnostic is informational; band-fitter behavior is unchanged.

Semantics (`lib/objectives/noPowerSourceDiagnostic.ts`):

- **Tracks the sample's own `crediblePowerW`, not the just-closed window's `kwhPerUnit`** — the sample's `crediblePowerW` becomes the *next* window's left-edge power, so a single valid sample after a silent run is the first one that lets training resume going forward. Tracking the closed window's `kwhPerUnit` would never reset because the closed window still bills at the silent baseline.
- **One-shot per device per process** — the diagnostic fires at most once per device per app start. A device that flips from "silent" to "valid" and back doesn't re-emit during the same process lifetime. An app restart re-arms.
- **Counter resets on any valid `crediblePowerW`** — an intermittent SDK gap does not lock the device into "perpetually silent"; if power readings start arriving the counter drops back to zero and the threshold has to be crossed again from scratch.
- **No persisted state** — per `feedback_homey_sdk_unreliable`, the counter and emitted flag live in process memory only. A transient SDK outage that drops the meter reading (and so resolves `currentDrawKw` to 0) should not have to fight stale persisted state on restart.

### Adaptive band fitter

`fitBandsFromSamples` runs on every accepted sample once the buffer has `OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2 = 16` rows:

1. **Initial state**: one band covering the full observed range.
2. **EV anchor (ev_soc only)**: if data straddles 80% with at least `OBJECTIVE_PROFILE_MIN_BAND_SAMPLES = 8` on each side, force a band edge at 80. This guarantees the CV-taper region is never averaged with the constant-power region below it, even when both sides are individually uniform and greedy splitting would find no signal.
3. **Greedy variance-reduction splits**: repeatedly pick the band whose best internal split point yields the largest SSE reduction. Commit the split if reduction ≥ `MIN_SSE_REDUCTION_FRACTION = 0.1` of the parent SSE AND both children meet the min-sample floor. Stop at `OBJECTIVE_PROFILE_MAX_BANDS = 4`.

The `MIN_SSE_REDUCTION_FRACTION` floor prevents fragmenting bands that are already homogeneous. The `OBJECTIVE_PROFILE_MIN_BAND_SAMPLES` floor prevents a freshly-split low-data band from dominating the estimate before it has enough evidence.

### Estimator integration

`resolveProfileEnergy` now accepts an optional `currentValue`. When bands exist AND `currentValue` is provided:

```
energy = Σ over bands of (overlap(band, [current, target]) × band.mean)
       + uncoveredUnits × globalMean
```

The global `kwhPerUnit.mean` is the fallback for:

- Bands with `sampleCount < 4` (sparse — `MIN_BAND_SAMPLES_FOR_INTEGRATION`).
- Portions of `[current, target]` outside any band's range (target above the highest observed value, current below the lowest).
- Calls without `currentValue` (no `progressCurrentValue` mapping — currently `generic_energy`).

The effective `kWhPerUnit` reported back to the planner is `energy / remainingUnits` so the planner's existing kWh-per-unit reasoning collapses to the global mean cleanly when bands aren't usable.

## Interaction with the learned energy band

Whether a window teaches the profile at all is decided before this file's machinery runs, by the per-device kWh/unit band in `lib/objectives/energyBand.ts`. A window whose cost per unit sits outside what the device has historically needed is refused as contaminated — a tank refilling with cold water after a draw, a charge report that steps without the matching energy, a heater bleeding heat out of an open door — and only accepted windows reach `buildAcceptedProfileSample`, so only they enter the sample buffer and the band fit. Consequences for the layout here:

- A refill cycle does not push samples into the buffer, and its several windows are simply several refusals.
- Bands learned before a drop survive it unchanged: a refusal returns `{...previous, rejectedSamples + 1}` and touches neither `samples` nor `bands`.
- The gate has its own two guards against eating its own inputs: the band is robust (median and median absolute deviation, so an admitted outlier moves the centre by one rank rather than dragging a mean and squaring into sigma), and its history is aged out after two weeks, so a device whose honest rate genuinely moved — a different car on the same charger — drops back to the coarse bootstrap bound and relearns instead of refusing every window forever. The horizon is applied on both sides: `appendSampleToBuffer` prunes on write (which is what keeps `bands` and `kwhPerUnit` recent), and `resolveEnergyPerUnitBand` filters on read (which is what runs when a locked-out device has stopped writing altogether). Worst case for the escape is therefore bounded by the horizon: two weeks of planning at the old rate.
- A refusal **voids the open window** unless the refusal is about the sample rather than the window (`interval_too_short`, `non_monotonic_time`). The energy and value sums are cumulative from the baseline, so anything less defers the refused window into the next one instead of discarding it: a refused 2 kWh / 0.8-unit refill followed by an ordinary 2 kWh / 4-unit rise would otherwise arrive as 4 / 4.8 = 0.83 on a device whose rate is 0.5, inside the band and accepted. The disposition travels on the rejection itself (`ProfileSampleRejection.openWindow`) rather than as a list of reason strings read back at the far end.
- The two are not the same "band". The layout in this file partitions the device's **input range** (SoC, °C) so the estimator can integrate a taper; `energyBand.ts` bounds the **kWh/unit figure itself** and answers only "is this window credible". They are computed from the same buffer and never consult each other.

The band replaced a recovery window (#775): a sharp fall used to arm a period in which *nothing* was learned until the value climbed back, 24 h elapsed, or four samples showed no forward progress. It was an indirect proxy — detect the fall, then blanket-suppress whatever followed — and its cost was everything ordinary caught in the blast radius, plus a no-progress counter and a safety timeout whose only job was to release a capacity-shed thermostat that had cooled away and would never climb back. Judging each window on its own merit needs none of that: the shed thermostat's next honest rise is learned at once.

## Why not …

- **Distance-to-target bands** (last 2°C, last 5°C, etc.): doesn't model EV taper (anchored to absolute SoC), and shifts every time the user changes setpoint.
- **Three fixed zones (cold-start / main / near-target)**: thresholds would have to be device-specific anyway, at which point absolute bands are barely more code.
- **Welford-only adaptive trees with no sample buffer**: splits would have to inherit half the parent's variance approximations because there are no raw samples to re-bucket. Buffer is ~5 KB per device × 64 devices ≈ 320 KB total, well inside the 30 MB headroom (`project_homey_rss_limit`).
- **Pure tree (no SSE floor)**: would over-fragment on noisy data with a single outlier.

## What `kWhPerUnit` means in plan provenance now

Before this change, `kwhPerUnitProvenance.kWhPerUnit` on an active plan recorded the device's learned global mean — a slow-changing rate independent of the specific plan. With banded estimation, `resolveProfileEnergy` returns `effectiveKwhPerUnit = energyNeededKWh / remainingUnits`, integrated across the bands between the current value and the target. The diagnostic surface (the unit-agnostic `kWhPerUnitBanded`, emitted to structured logs as the legacy per-kind `kWhPerPercent` / `kWhPerDegreeC` for back-compat) and the active plan recorder both store that effective value.

Consequence: **two plans for the same device starting from different SoCs or temperatures can record different `kWhPerUnit` even when nothing in the model has changed.** This is intentional — the recorded value reflects what was actually used to size this plan. Operators reading provenance should treat it as "rate used for this plan," not "the device's learned rate."

If a UI surface needs the stable learned mean separately, it can read `objectiveProfiles[deviceId].kwhPerUnit.mean` from the live tracker through `api.js` (the tracker persists to the userdata store, not a settings key).

## `displayConfidence` for the smart-task chip

The active-plan provenance carries two confidence values:

- `confidence` — the raw per-sample CV-based stat from `resolveProfileConfidence` (`lib/objectives/stats.ts`). Honest about per-sample noise. On thermal devices this sits at `low` effectively forever (stratification + ambient drift + draw history pushes CV above 0.75 regardless of sample count). Kept for logs and diagnostics.
- `displayConfidence` — the band-aware aggregate driving the "Estimating" / "Refining" chip. Reflects whether the bands actually integrated for this resolution are well-supported.

`resolveDisplayConfidence` aggregates per the rule:

1. No bands, or no `currentValue`, or non-positive `remainingUnits` → fall back to global.
2. An overlapping band has `sampleCount < MIN_BAND_SAMPLES_FOR_INTEGRATION` → fall back to global (we'd lean on the global mean for that slice anyway).
3. Bands don't fully cover `[current, target]` (within a 1e-6 tolerance) → fall back to global.
4. Otherwise → `min(confidence)` across overlapping bands.

The UI consumer in `packages/settings-ui/src/ui/deadlinePlanResolvers.ts` reads `provenance.displayConfidence` first, falls back to `provenance.confidence`, then to the live profile's stat. Producer-resolved per `feedback_layering_resolution_in_producer.md`: the UI never branches on bands or per-band fields.

## Tunables

If estimation regresses for a specific device shape, the relevant constants are:

| Constant | File | Purpose |
| --- | --- | --- |
| `OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE` | `lib/objectives/bands.ts` | Cap on retained samples per device |
| `OBJECTIVE_PROFILE_MIN_BAND_SAMPLES` | `lib/objectives/bands.ts` | Floor for any produced band (also gates band-fitting on the full buffer) |
| `OBJECTIVE_PROFILE_MAX_BANDS` | `lib/objectives/bands.ts` | Upper cap on band count |
| `MIN_SSE_REDUCTION_FRACTION` | `lib/objectives/bands.ts` | Minimum relative variance reduction to commit a split |
| `EV_SOC_TAPER_ANCHOR` | `lib/objectives/bands.ts` | Forced band edge for EV profiles |
| `MIN_BAND_SAMPLES_FOR_INTEGRATION` | `lib/objectives/deferredObjectives/profileEnergyResolution.ts` | Below this, integrator uses the global mean for that portion |

No settings UI surface yet — banded estimation is on by default with no gate.
