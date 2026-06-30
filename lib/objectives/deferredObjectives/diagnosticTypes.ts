import type { DeferredObjectiveKwhPerUnitSource } from './profileEnergyResolution';
import type {
  DeferredObjectivePolicyHorizonUnavailableReason,
  PriceHorizonEntry,
} from './policyHorizon';
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
} from './settings';
import type { DeferredObjectiveHorizonPlan } from './types';

// Injected by the wiring layer: resolves the price-layer allocation horizon for
// `[nowMs, deadlineAtMs)`. Defined as a closure (not a `CombinedPricesV2` input)
// so this leafward subsystem never imports the `lib/price` peer — the producer
// (`buildPriceHorizonFromCombined` in lib/price) lives in the price layer.
export type BuildPriceHorizon = (nowMs: number, deadlineAtMs: number) => PriceHorizonEntry[];

export type DeferredObjectiveDiagnosticReasonCode =
  | DeferredObjectivePolicyHorizonUnavailableReason
  | 'objective_charger_not_resumable'
  | 'objective_invalid_deadline'
  | 'objective_invalid_session'
  | 'objective_missing_capacity'
  | 'objective_missing_charge_rate'
  | 'objective_missing_device'
  | 'objective_missing_temperature'
  | 'objective_progress_stale'
  // Live status resolved to `satisfied` because the device parked in a stall
  // classification (see `resolveStallReportedStatus`). `near_target` = inside
  // the hysteresis band; `device_capped` = at the device's own internal cap.
  | 'objective_stalled_near_target'
  | 'objective_stalled_device_capped';

export type { DeferredObjectiveKwhPerUnitSource } from './profileEnergyResolution';

type BaseDeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  status: 'unknown' | DeferredObjectiveHorizonPlan['status'];
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  targetPercent: number | null;
  currentPercent: number | null;
  // Unit-AGNOSTIC current/target reading, identical to the kind-split
  // `currentTemperatureC`/`targetTemperatureC` (temperature) or
  // `currentPercent`/`targetPercent` (ev_soc) for this diagnostic. A heater and
  // an EV are the same planning problem; the unit is only a display label
  // (resolve it via `unitForObjectiveKind(objectiveKind)`). Consumers read these
  // instead of forking on `objectiveKind` to pick a value. Invariant, for every
  // diagnostic:
  //   currentValue === (objectiveKind === 'temperature' ? currentTemperatureC : currentPercent)
  //   targetValue  === (objectiveKind === 'temperature' ? targetTemperatureC  : targetPercent)
  // (a `?: never` ev-variant temperature field counts as null).
  currentValue: number | null;
  targetValue: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  energyNeededKWh: number | null;
  // Mean-based estimate (no variance buffer). Pairs with the buffered
  // `energyNeededKWh` so the UI can render an `expected…planned` range. Omitted
  // on the unresolved paths; absent or equal to `energyNeededKWh` means there is
  // no buffer to show (cold-start, bootstrap, steady device).
  energyExpectedKWh?: number | null;
  // Banded remaining-interval display average (kWh/unit), kind-agnostic. Shifts
  // as a task crosses bands. Sourced from `profileEnergy.kWhPerUnit`.
  kWhPerUnitBanded: number | null;
  // Buffered per-unit rate (`energyNeededKWh / remainingUnits`), kind-agnostic.
  // The buffered-currency analog of the mean `kWhPerUnitBanded`.
  // Consumed by the unit-milestone stamp so the cumulative milestone lands on
  // target instead of overshooting by the buffer ratio. Optional/back-compatible:
  // absent on legacy diagnostics, where the stamp falls back to the mean rate.
  kWhPerUnitBuffered?: number | null;
  // Sample-driven global learned mean (kWh/unit), kind-agnostic. Distinct from
  // `kWhPerUnitBanded`, which is the banded remaining-interval display average
  // and so shifts as a task crosses bands.
  // This only moves on genuine rate drift, so it is the stable statistic the
  // active-plan recorder's `measured_deviation` detector compares. Null on
  // bootstrap / unresolved. See `profileEnergyResolution.kWhPerUnitMean`.
  kwhPerUnitLearnedMean: number | null;
  rateConfidence: string | null;
  // Band-aware aggregated confidence for the smart-task chip. Honest about
  // whether the *model in use* (bands integrated for this resolution) is
  // well-supported, instead of the raw per-sample CV which sits at "low" on
  // thermal devices effectively forever. Null on bootstrap / unresolved.
  displayConfidence: 'low' | 'medium' | 'high' | null;
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  // Number of accepted samples that produced the learned profile mean. Zero
  // when `kwhPerUnitSource` is `bootstrap` or null. Surfaced so the UI can
  // explain EV learning progress without re-reading the profile store.
  kwhPerUnitAcceptedSamples: number;
  // UTC ms of the last accepted sample. Null when no learned profile exists
  // yet (bootstrap or unresolved).
  kwhPerUnitLastAcceptedAtMs: number | null;
  // The "useful" planning power in kW that the planner would commit per
  // active hour. For stepped devices this is the lowest non-zero step's
  // useful power; for binary devices (EV chargers) it is the single step's
  // useful power. Null when no steps were resolvable. Surfaced as the
  // "Y.Y kW" speed-mode reading in the hero meta line.
  planningSpeedKw: number | null;
  // Planning-affecting rescue permissions participate in the active-plan signature
  // so permission edits invalidate stale committed schedules.
  rescue?: DeferredObjectiveRescuePermissions;
  horizonBucketCount: number;
  // Number of buckets in the horizon whose per-bucket cap collapsed to zero
  // because the daily budget cap had already been reached at the start of the
  // bucket. Lets the UI explain a `cannot_meet` outcome that would otherwise
  // look like a device or schedule problem.
  dailyBudgetExhaustedBucketCount: number;
  expectedStepId: string | null;
  horizonPlan?: DeferredObjectiveHorizonPlan;
  // True only while the current bucket is a planned bucket for a smart task whose "exempt
  // from budget" rescue permission is active. Admission consumes this flat flag to set the
  // device's existing `budgetExempt` for that bucket; idle/background cycles stay normal.
  budgetExemptApplied?: boolean;
  // True when the "limit lower-priority devices" rescue permission is granted (mode
  // 'always'). Admission consumes this flat flag to engage the device's boost while the
  // task is in its planned hours, so the existing escalation/shedding machinery claims
  // capacity from lower-priority devices. Producer resolves it; consumers don't re-derive.
  limitLowerPriorityApplied?: boolean;
};

export type { BaseDeferredObjectiveDiagnostic };

// Discriminated by `objectiveKind`. Temperature variants always carry a
// numeric `targetTemperatureC` (the setting requires it); EV variants omit
// both temperature fields entirely so consumers can't accidentally read
// them. `currentTemperatureC` stays `number | null` on the temperature
// variant because sensor reads can legitimately fail.
export type DeferredObjectiveDiagnostic =
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'temperature';
    targetTemperatureC: number;
    currentTemperatureC: number | null;
  })
  | (BaseDeferredObjectiveDiagnostic & {
    objectiveKind: 'ev_soc';
    targetTemperatureC?: never;
    currentTemperatureC?: never;
  });
