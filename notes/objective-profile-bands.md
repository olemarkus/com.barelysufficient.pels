# Objective profile bands — adaptive kWh-per-unit learning

## Why this exists

A single global `kWhPerUnit` mean per device is wrong for two known device shapes:

- **Water heaters / thermostats**: heat losses scale with ΔT-to-ambient, and a bottom-mounted temperature sensor reads cold for the first degrees of any cycle (stratification — hot water rises away from the sensor). The result is a U-shape: early degrees slow, middle fast, last degrees slow. A linear estimator under-estimates near the setpoint.
- **EV chargers**: constant-power charging up to ~80% SoC, then CV-phase taper. A linear estimator under-estimates the kWh needed to reach 100%.

#775 fixed the orthogonal problem of refill-cycle pollution (sharp temperature drops after a hot-water draw). This change adds the actual non-linear model the estimator needs.

## Design

### Per-device ring buffer

Each `DeviceObjectiveProfile` keeps up to `OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE = 64` recent `{observedAtMs, inputValue, kwhPerUnit}` tuples. New samples push to the end; oldest are dropped past the cap. The buffer is persisted as part of `power_tracker_state`.

`inputValue` is tagged with the **midpoint** of the rise (`(previousSample.value + sample.value) / 2`) rather than the start or end. This reflects where the energy was actually deposited along the input axis.

The buffer is updated only when `kWhPerUnit` is known (`crediblePowerW` was present on the previous sample). Recovery-window samples are not added — the recovery path returns its `nextProfile` before `buildAcceptedProfileSample` runs.

#### Requirement: a credible power source must be available per accepted sample

`crediblePowerW` is resolved by `resolveCredibleDevicePower` in `lib/objectives/samples.ts`. It draws from one of two sources:

1. `measuredPowerKw` — an inline meter on the device capability set.
2. `steppedLoadProfile.steps[reportedStepId].planningPowerW` — the user-configured planning power for the device's currently reported step.

If neither is available, `crediblePowerW` is omitted from the sample. The next accepted sample then enters `buildAcceptedProfileSample` with `windowEnergyKwh = undefined` (the open sub-interval has no left-edge power), so `kwhPerUnit` is `undefined`, `resolveBandedUpdate` returns `{}`, and the band buffer never grows. Adaptive learning silently stalls.

For thermostats without an inline meter, configure a per-step `planningPowerW` on the device's stepped-load profile. Without one, energy training is effectively disabled regardless of accepted-sample count.

#### `objective_profile_no_power_source` diagnostic

After `OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD = 20` consecutive accepted samples whose own `crediblePowerW` is absent or non-positive, `buildAcceptedProfileSample` emits a one-shot `objective_profile_no_power_source` structured event carrying `{deviceId, deviceName, profileKind, acceptedSamples, consecutiveSamplesWithoutPower, threshold}`. The diagnostic is informational; band-fitter behavior is unchanged.

Semantics (`lib/objectives/noPowerSourceDiagnostic.ts`):

- **Tracks the sample's own `crediblePowerW`, not the just-closed window's `kwhPerUnit`** — the sample's `crediblePowerW` becomes the *next* window's left-edge power, so a single valid sample after a silent run is the first one that lets training resume going forward. Tracking the closed window's `kwhPerUnit` would never reset because the closed window still bills at the silent baseline.
- **One-shot per device per process** — the diagnostic fires at most once per device per app start. A device that flips from "silent" to "valid" and back doesn't re-emit during the same process lifetime. An app restart re-arms.
- **Counter resets on any valid `crediblePowerW`** — an intermittent SDK gap does not lock the device into "perpetually silent"; if power readings start arriving the counter drops back to zero and the threshold has to be crossed again from scratch.
- **No persisted state** — per `feedback_homey_sdk_unreliable`, the counter and emitted flag live in process memory only. A transient SDK outage that drops `measuredPowerKw` should not have to fight stale persisted state on restart.

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

## Interaction with #775 recovery window

The recovery window suspends all stat updates while armed. The new buffer/band logic is reached only via `buildAcceptedProfileSample`, which runs only on the non-recovery path. Recovery's `disarm_recovery` path destructures `recoveryTargetValue`/`recoveryArmedAtMs` (and `recoveryNoProgressSamples`) via `...rest` but preserves `samples` and `bands`. So:

- A refill cycle does not push samples into the buffer.
- Bands learned before a drop survive the drop unchanged and resume estimating after recovery.

### Forward-progress disarm

`resolveArmedRecovery` disarms on three conditions, in order:

1. **Recovered** — `sample.value >= recoveryTargetValue` (pre-drop value reached).
2. **Safety timeout** — armed age ≥ `RECOVERY_SAFETY_TIMEOUT_MS` (24h hard cap).
3. **No progress** — `RECOVERY_NO_PROGRESS_SAMPLE_LIMIT` consecutive samples with non-positive delta vs the previous sample. A delta above `RECOVERY_PROGRESS_EPSILON` resets the counter.

The third condition exists for cap-shed thermostats: when a smart task is itself shedding the heater, the device cools *away* from the pre-drop value and would otherwise sit in `reject_recovering` for the full 24h timeout, blocking all stat and band updates. The no-progress disarm treats this as "we lost the refill assumption; resume baseline learning" — recovery fields clear, the disarming sample becomes the new baseline, `samples` / `bands` survive.

The disarm event carries `disarmReason: 'recovered' | 'safety_timeout' | 'no_progress'` for telemetry; the action itself remains `disarm_recovery` for all three paths.

## Why not …

- **Distance-to-target bands** (last 2°C, last 5°C, etc.): doesn't model EV taper (anchored to absolute SoC), and shifts every time the user changes setpoint.
- **Three fixed zones (cold-start / main / near-target)**: thresholds would have to be device-specific anyway, at which point absolute bands are barely more code.
- **Welford-only adaptive trees with no sample buffer**: splits would have to inherit half the parent's variance approximations because there are no raw samples to re-bucket. Buffer is ~5 KB per device × 64 devices ≈ 320 KB total, well inside the 30 MB headroom (`project_homey_rss_limit`).
- **Pure tree (no SSE floor)**: would over-fragment on noisy data with a single outlier.

## What `kWhPerUnit` means in plan provenance now

Before this change, `kwhPerUnitProvenance.kWhPerUnit` on an active plan recorded the device's learned global mean — a slow-changing rate independent of the specific plan. With banded estimation, `resolveProfileEnergy` returns `effectiveKwhPerUnit = energyNeededKWh / remainingUnits`, integrated across the bands between the current value and the target. The diagnostic surface (`kWhPerPercent` / `kWhPerDegreeC`) and the active plan recorder both store that effective value.

Consequence: **two plans for the same device starting from different SoCs or temperatures can record different `kWhPerUnit` even when nothing in the model has changed.** This is intentional — the recorded value reflects what was actually used to size this plan. Operators reading provenance should treat it as "rate used for this plan," not "the device's learned rate."

If a UI surface needs the stable learned mean separately, it can read `objectiveProfiles[deviceId].kwhPerUnit.mean` directly from `power_tracker_state`.

## `displayConfidence` for the smart-task chip

The active-plan provenance carries two confidence values:

- `confidence` — the raw per-sample CV-based stat from `objectiveProfileStats.resolveProfileConfidence`. Honest about per-sample noise. On thermal devices this sits at `low` effectively forever (stratification + ambient drift + draw history pushes CV above 0.75 regardless of sample count). Kept for logs and diagnostics.
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
