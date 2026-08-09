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
  // The task's device belongs to a separate-meter sub-home (multi-home v1
  // scopes smart tasks to the main home). Dedicated code so an EXISTING task
  // whose device is later moved to a sub-home reads honestly, instead of the
  // misleading `objective_missing_device` (the device is present — it is out
  // of scope). Like `objective_missing_device`, the diagnostic is `unknown`
  // and never plans: admission treats it as inactive, releasing the device to
  // normal control.
  | 'objective_device_in_sub_home'
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
  // The device is being left off because it was turned off outside PELS. An
  // explicit off action beats the task, but the deadline consequence must still
  // be visible — the task reports risk rather than claiming it is on track.
  | 'objective_stalled_device_capped';

type BaseDeferredObjectiveDiagnostic = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  enforcement: DeferredObjectiveSettingsEntry['enforcement'];
  /**
   * The trajectory verdict, or the reason there is none.
   *
   * Split deliberately. `status` used to carry a `'unknown'` arm alongside the
   * real verdicts (`on_track` / `at_risk` / `cannot_meet` / `satisfied` /
   * `invalid`), stamped for transient DATA problems — a missing rate, an
   * unavailable battery level. Every consumer then had to remember to branch on
   * a value that meant "we could not compute one", and one that forgot shipped
   * a bug: gating the external-off overlay on the live status meant a degraded
   * reading silently reverted every surface to a cached **On track** while the
   * device was held off.
   *
   * With the union, "no verdict" cannot be mistaken for a verdict — reach the
   * status through `resolvedTrajectoryStatus`, which answers `undefined` when
   * there is none. The `'unknown'` arm survives only on the PUBLISHED status
   * (`DeferredObjectivePublishedStatus`), where the UI needs something to show;
   * `statusTransitions` maps it at that boundary and nowhere else.
   */
  trajectory:
    | { kind: 'resolved'; status: DeferredObjectiveHorizonPlan['status'] }
    | { kind: 'unavailable'; reasonCode: DeferredObjectiveDiagnosticReasonCode };
  reasonCode: DeferredObjectiveDiagnosticReasonCode | DeferredObjectiveHorizonPlan['statusDetail'];
  /**
   * "Leave off until turned on again" is live on this device.
   *
   * Its OWN field rather than a `reasonCode` value, deliberately: `reasonCode`
   * is the planner's verdict and is frozen into the committed revision (it
   * resolves `floorShortfallCause`). Overwriting it would erase the real cause —
   * a budget-bound task whose device is switched off across a settle would lose
   * its budget signal, and the detail UI would explain the risk with the clock
   * instead. The hold is transient; the planner's verdict is not.
   */
  externalOffHoldActive?: true;
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
  expectedStepId: string | null;
  // The live step ladder was unavailable this cycle and the diagnostic was served
  // from the frozen committed plan instead of degrading to `unknown` (a
  // flow-registered stepped profile does not survive an app restart until the
  // Flow re-fires; SDK reads transiently fail — see `diagnosticsBridge`). Pure
  // log-visibility flag: admission and every other consumer treat the diagnostic
  // identically; `expectedStepId` is null while it is set.
  liveStepsUnavailable?: true;
  horizonPlan?: DeferredObjectiveHorizonPlan;
  // Ephemeral relative device priority used by the batch allocator. Resolved
  // from the current mode catalog and complete allocation roster on each read;
  // it is not a persisted source of ordering.
  devicePriority?: number;
  // Batch-allocation provenance. The recorder persists the signature on fresh
  // revisions and may replace (rather than floor-merge) a lower-priority
  // commitment when higher-priority claims changed its future schedule.
  allocationContextSignature?: string;
  replaceCommitment?: true;
  // True only while the current bucket is a planned bucket for a smart task whose "exempt
  // from budget" rescue permission is active. Admission consumes this flat flag to set the
  // device's existing `budgetExempt` for that bucket; idle/background cycles stay normal.
  budgetExemptApplied?: boolean;
  // True when the "limit lower-priority devices" rescue permission is granted (mode
  // 'always'). Admission consumes this flat flag to engage the device's boost while the
  // task is in its planned hours, so the existing escalation/shedding machinery claims
  // capacity from lower-priority devices. Producer resolves it; consumers don't re-derive.
  limitLowerPriorityApplied?: boolean;
  // True when the "pause lower-priority devices" rescue permission is granted (mode
  // 'always'). Admission consumes this flat flag to set the device's `reservesStartupPower`
  // while the task is in its planned hours. Unlike `limitLowerPriorityApplied`, this does
  // NOT engage boost and sheds nobody — the plan layer holds the device's lowest-active-step
  // power back from lower-priority devices' admission until it starts. Producer resolves it;
  // consumers don't re-derive.
  pauseLowerPriorityApplied?: boolean;
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

/**
 * The trajectory verdict when there is one, `undefined` when there is not.
 *
 * The single accessor for `trajectory`, so a consumer asking "is this task
 * satisfied?" gets `false` for a diagnostic that could not be computed, rather
 * than having to remember that one arm of an enum means "no answer".
 */
export const resolvedTrajectoryStatus = (
  diagnostic: Pick<BaseDeferredObjectiveDiagnostic, 'trajectory'>,
): DeferredObjectiveHorizonPlan['status'] | undefined => (
  diagnostic.trajectory.kind === 'resolved' ? diagnostic.trajectory.status : undefined
);
