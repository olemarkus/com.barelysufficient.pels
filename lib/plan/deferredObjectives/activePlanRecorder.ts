/* eslint-disable max-lines -- active-plan recorder, diagnostics, and replay stay together. */
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  formatEstimatedDuration,
  resolvePlanLevelDurationSnapshot,
  toPersistedPlanLevelDurationFields,
} from './activePlanDuration';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION } from './activePlanSettings';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import {
  hasPriceHorizonAdvanced,
  resolveHorizonPriceWatermark,
  resolveReplanReason,
} from './replanReason';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { buildActivePlanLifecycleFields } from './activePlanLifecycleFields';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectivePlanRevisionEvent } from './planRevisionBus';
import type { DeferredObjectiveRescuePermissions } from './settings';
import {
  buildHoursFromHorizonPlan,
  mergeHoursPreservingCommitment,
  resolveProjectedFinishAtMs,
  sameHourSchedule,
  shouldFireNotification,
} from './activePlanSchedule';
import { roundKWh } from './activePlanMath';
import { buildObjectiveSignature, compareObjectiveSignatures } from './activePlanSignature';

const logger = getLogger('plan/deferred-active');

// Persisted plans store mixed objective kinds, so derive the nullable
// persisted value from the discriminated diagnostic.
const diagTargetTemperatureC = (diag: DeferredObjectiveDiagnostic): number | null => (
  diag.objectiveKind === 'temperature' ? diag.targetTemperatureC : null
);


// Mirror `planHistory.ts` ABANDON_GRACE_MS. Homey settings reads can transiently
// return empty/malformed data; if a plan cycle ever produces an empty
// diagnostic stream we must not drop persisted plans on the first miss. Wait
// at least an hour without seeing the diagnostic before declaring the
// objective abandoned.
const ABANDON_GRACE_MS = 60 * 60 * 1000;

export type ActivePlanPersistDeps = {
  load: () => DeferredObjectiveActivePlansV1 | null;
  save: (plans: DeferredObjectiveActivePlansV1) => void;
  debugStructured?: StructuredDebugEmitter;
  onRevisionWritten?: (event: DeferredObjectivePlanRevisionEvent) => void;
};

export type ActivePlanFlowCardSeed = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
  rescue?: DeferredObjectiveRescuePermissions;
};

const buildSignatureFromDiagnostic = (diag: DeferredObjectiveDiagnostic): string | null => {
  if (diag.deadlineAtMs === null) return null;
  return buildObjectiveSignature({
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diagTargetTemperatureC(diag),
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs,
    enforcement: diag.enforcement,
    rescue: diag.rescue,
  });
};

const createPlanFromSeed = (seed: ActivePlanFlowCardSeed, nowMs: number): DeferredObjectiveActivePlanV1 => ({
  deviceId: seed.deviceId,
  deviceName: seed.deviceName,
  objectiveKind: seed.objectiveKind,
  targetTemperatureC: seed.targetTemperatureC,
  targetPercent: seed.targetPercent,
  deadlineAtMs: seed.deadlineAtMs,
  startedAtMs: nowMs,
  pending: true,
  objectiveSignature: buildObjectiveSignature({
    objectiveKind: seed.objectiveKind,
    targetTemperatureC: seed.targetTemperatureC,
    targetPercent: seed.targetPercent,
    deadlineAtMs: seed.deadlineAtMs,
    enforcement: seed.enforcement,
    rescue: seed.rescue,
  }),
  original: null,
  latest: null,
});

// Reason codes from `diagnosticsBridge` that indicate the device-data side of the diagnostic
// failed before a horizon plan could be built. The pending hero needs to say "waiting for a
// reading from the device", not "waiting for prices" — see the comment in `ensurePendingRecord`.
const DEVICE_DATA_REASON_CODES: ReadonlySet<string> = new Set([
  'objective_invalid_deadline',
  'objective_missing_charge_rate',
  'objective_missing_device',
  'objective_missing_temperature',
  'objective_progress_stale',
]);

// For thermal objectives, `objective_missing_charge_rate` means the planner has the kWh/°C
// (learned or bootstrap) but no executable step yet — typically because `planningPowerKw`
// has not been calibrated from observed power. That is the same "still learning the energy
// profile" state as `objective_missing_capacity`, and the "Learning energy use" hero copy
// describes it correctly. EVs keep the generic `device_data_missing` mapping because for
// them `objective_missing_charge_rate` really is a missing reading from the charger.
const THERMAL_LEARNING_CAPACITY_REASON_CODES: ReadonlySet<string> = new Set([
  'objective_missing_capacity',
  'objective_missing_charge_rate',
]);

const resolvePendingReason = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanPendingReason => {
  if (diag.reasonCode === 'objective_price_feature_disabled') return 'price_feature_disabled';
  // EV plugged-out / discharging session — surface a dedicated "paused —
  // unplugged" copy variant so the user knows the plan resumes once they
  // plug back in. Without this the hero said the generic "Waiting" with no
  // hint that the action is on the user, not PELS.
  if (diag.reasonCode === 'objective_invalid_session') return 'invalid_session';
  // Thermal devices have no shipped bootstrap kWh/°C; tell the user that
  // power readings are what unblock the plan instead of leaving them with an
  // indefinite "Waiting" state. For thermal objectives this also covers
  // `objective_missing_charge_rate` (no executable step yet because
  // `planningPowerKw` is uncalibrated), which is the same cold-start state
  // from the user's point of view.
  if (
    diag.objectiveKind === 'temperature'
      && THERMAL_LEARNING_CAPACITY_REASON_CODES.has(diag.reasonCode)
  ) {
    return 'missing_capacity';
  }
  if (DEVICE_DATA_REASON_CODES.has(diag.reasonCode)) return 'device_data_missing';
  return 'awaiting_horizon_plan';
};

// Narrow diagnostic reason codes that the UI needs to render specific copy
// (e.g. "car unplugged") beyond what `pendingReason` alone can express.
const resolveDiagnosticReasonCode = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanDiagnosticReason | undefined => (
  diag.reasonCode === 'objective_invalid_session' ? 'objective_invalid_session' : undefined
);

const createPlanFromDiagnostic = (
  diag: DeferredObjectiveDiagnostic,
  signature: string,
  nowMs: number,
): DeferredObjectiveActivePlanV1 => {
  const diagnosticReasonCode = resolveDiagnosticReasonCode(diag);
  return {
    deviceId: diag.deviceId,
    deviceName: diag.deviceName ?? null,
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diagTargetTemperatureC(diag),
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs as number,
    startedAtMs: nowMs,
    pending: true,
    pendingReason: resolvePendingReason(diag),
    ...(diagnosticReasonCode !== undefined ? { diagnosticReasonCode } : {}),
    objectiveSignature: signature,
    original: null,
    latest: null,
  };
};

const buildRevision = (params: {
  diag: DeferredObjectiveDiagnostic;
  hours: DeferredObjectiveActivePlanHourV1[];
  revision: number;
  reason: DeferredObjectiveActivePlanRevisionReason;
  nowMs: number;
}): DeferredObjectiveActivePlanRevisionV1 => {
  // Callers only invoke buildRevision after `buildHoursFromHorizonPlan` returned
  // non-null, which guarantees `horizonPlan` is present.
  const horizonPlan = params.diag.horizonPlan as NonNullable<typeof params.diag.horizonPlan>;
  // Persist `kwhPerUnitSource` only when the diagnostic actually consulted a
  // profile (or its bootstrap fallback). `null` means the resolver short-
  // circuited (e.g. target already met) — omit the field rather than write
  // a misleading value.
  const source = params.diag.kwhPerUnitSource;
  // Only persist `dailyBudgetExhaustedBucketCount` when non-zero so older
  // persisted plans without the field stay byte-stable across revisions and
  // consumers that haven't been updated keep falling back to zero.
  const exhaustedBuckets = params.diag.dailyBudgetExhaustedBucketCount;
  // Producer-resolved floor-shortfall verdict. Suppress `none` so steady
  // on-track plans stay byte-stable; `budget` covers the squeeze case
  // (`dailyBudgetExhaustedBucketCount: 0` but the per-bucket cap still binds)
  // — see the contract type for the full mapping.
  const floorShortfallCause = resolveFloorShortfallCause(params.diag.reasonCode);
  const energyNeededKWh = roundKWh(horizonPlan.energyNeededKWh);
  // Mean-based expected energy, rounded to match `energyNeededKWh`. Persisted
  // only when it differs from the buffered figure, so steady devices stay
  // byte-stable across revisions and the UI's range collapses to one number.
  const energyExpectedKWhRaw = params.diag.energyExpectedKWh;
  const energyExpectedKWh = typeof energyExpectedKWhRaw === 'number' ? roundKWh(energyExpectedKWhRaw) : null;
  const planningSpeedKw = params.diag.planningSpeedKw;
  // Estimated duration is a derived field — the recorder is the right place
  // to format it so the hero meta line and any downstream consumer (flow
  // tokens) agree on the rounding/unit conventions.
  const estimatedDurationText = formatEstimatedDuration(energyNeededKWh, planningSpeedKw);
  return {
    revision: params.revision,
    revisedAtMs: params.nowMs,
    computedFromPricesUpTo: resolveHorizonPriceWatermark(params.diag),
    reason: params.reason,
    hours: params.hours,
    // Round to milliWh to match `plannedKWh`. Without rounding,
    // floating-point accumulation in the kWh/unit-band integrator (or the
    // simple multiply on the unbanded path) can produce ~1e-15 kWh drift
    // that would appear in persisted output even when the underlying
    // allocation is byte-identical.
    energyNeededKWh,
    ...(energyExpectedKWh !== null && energyExpectedKWh !== energyNeededKWh
      ? { energyExpectedKWh }
      : {}),
    planStatus: horizonPlan.status,
    ...(source !== null ? { kwhPerUnitSource: source } : {}),
    ...(exhaustedBuckets > 0 ? { dailyBudgetExhaustedBucketCount: exhaustedBuckets } : {}),
    ...(floorShortfallCause !== 'none' ? { floorShortfallCause } : {}),
    ...(typeof planningSpeedKw === 'number' && planningSpeedKw > 0 ? { planningSpeedKw } : {}),
    ...(estimatedDurationText !== null ? { estimatedDurationText } : {}),
  };
};

// Per-plan provenance is best-effort and only written when at least one
// field has useful content; otherwise older consumers continue using the
// fall-back lookup against the live profile store.
const resolveProvenance = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanV1['kwhPerUnitProvenance'] | undefined => {
  const source = diag.kwhPerUnitSource;
  if (source === null) return undefined;
  const learnedKwh = source === 'learned' ? (diag.kWhPerPercent ?? diag.kWhPerDegreeC) : null;
  const confidence = source === 'learned' && isProvenanceConfidence(diag.rateConfidence)
    ? diag.rateConfidence
    : null;
  const displayConfidence = source === 'learned' && isProvenanceConfidence(diag.displayConfidence)
    ? diag.displayConfidence
    : null;
  return {
    source,
    kWhPerUnit: typeof learnedKwh === 'number' && Number.isFinite(learnedKwh) ? learnedKwh : null,
    acceptedSamples: source === 'learned' ? diag.kwhPerUnitAcceptedSamples : 0,
    confidence,
    displayConfidence,
    lastAcceptedAtMs: source === 'learned' ? diag.kwhPerUnitLastAcceptedAtMs : null,
  };
};

const isProvenanceConfidence = (
  value: string | null,
): value is 'low' | 'medium' | 'high' => (
  value === 'low' || value === 'medium' || value === 'high'
);

// Caller already established `sameHourSchedule(latest.hours, hours)`. Returns
// true when consumer-visible status fields drifted across the same set of
// charging hours. Tracked fields and the UI signal each drives:
//   - `planStatus`                       → "Can't fully meet" chip
//   - `dailyBudgetExhaustedBucketCount`  → per-bucket headroom explanation
//   - `floorShortfallCause`              → hero recourse routing
//     (budget-bound → `Open Budget`, otherwise device-side). Squeeze-case
//     repro: `at_risk` stays put while cause flips from `feasible_above_floor`
//     to `limited_by_daily_budget` as background load shifts the per-bucket
//     cap binding; without re-persisting, the recourse would stay device-side.
// Legacy fields absent on `latest` resolve to `none`/`0` so unchanged revisions
// don't thrash on the first cycle after upgrade. Per-cycle drift in
// `plannedKWh` / `energyNeededKWh` is intentionally NOT a persist trigger —
// an actively charging EV shrinks `energyNeededKWh` monotonically every cycle.
const hasMetadataDriftedWithinSchedule = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  horizonPlan: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>;
  diag: DeferredObjectiveDiagnostic;
}): boolean => {
  const { latest, horizonPlan, diag } = params;
  return latest.planStatus !== horizonPlan.status
    || (latest.dailyBudgetExhaustedBucketCount ?? 0) !== diag.dailyBudgetExhaustedBucketCount
    || (latest.floorShortfallCause ?? 'none') !== resolveFloorShortfallCause(diag.reasonCode);
};

const resolveSourceTransition = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  diag: DeferredObjectiveDiagnostic;
}): { sourceChanged: boolean; sourceRefined: boolean } => {
  // Treat absence on `latest` as `learned` so legacy persisted revisions don't
  // appear to transition on the first observation after upgrade.
  const previousSource = params.latest.kwhPerUnitSource ?? 'learned';
  const nextSource = params.diag.kwhPerUnitSource;
  return {
    sourceChanged: nextSource !== null && previousSource !== nextSource,
    sourceRefined: previousSource === 'bootstrap' && nextSource === 'learned',
  };
};

const shouldWriteReplanRevision = (params: {
  objectiveChanged: boolean;
  scheduleChanged: boolean;
  metadataDriftedWithinSchedule: boolean;
  sourceChanged: boolean;
}): boolean => (
  params.objectiveChanged || params.scheduleChanged
    || params.metadataDriftedWithinSchedule || params.sourceChanged
);

// Bounded most-recent-first log of past revisions kept on the active plan
// record so the smart-task detail page can render a revision-history panel
// without re-fetching anything. Each replan prepends the previous `latest`
// onto the array and slices to this cap (FIFO prune). 20 covers any
// realistic smart-task lifecycle — schedule-changing replans are typically
// single-digit per task.
//
// Worst-case size per device: ~48-bucket horizon × 20 revisions × ~50 B JSON
// per bucket ≈ 48 KB of buckets, plus per-revision metadata (~1 KB total)
// pushes the upper bound to ~60 KB. Even with ten chatty devices that's 600 KB
// against the 30 MB Homey RSS headroom (`project_homey_rss_limit`); the cap
// is comfortable, not tight.
const MAX_HISTORY_REVISIONS = 20;

// `objectiveChanged` discards the previous commitment entirely and seeds a
// fresh one from the live `hours`. `scheduleChanged` (e.g. phase-2
// expansion grew the commitment) advances `committedAtMs` and persists the
// merged `effectiveHours`. Otherwise the existing commitment is preserved
// so within-schedule metadata drift doesn't visibly reshape the timestamp.
const resolveCommitment = (params: {
  objectiveChanged: boolean;
  scheduleChanged: boolean;
  hours: DeferredObjectiveActivePlanHourV1[];
  effectiveHours: DeferredObjectiveActivePlanHourV1[];
  previous: DeferredObjectiveActivePlanV1['commitment'];
  nowMs: number;
}): DeferredObjectiveActivePlanV1['commitment'] => {
  if (params.objectiveChanged) {
    return { committedAtMs: params.nowMs, hours: params.hours };
  }
  if (params.scheduleChanged) {
    return { committedAtMs: params.nowMs, hours: params.effectiveHours };
  }
  return params.previous;
};

export class DeferredObjectiveActivePlanRecorder {
  private plans: Record<string, DeferredObjectiveActivePlanV1>;

  // In-memory only. Records the last cycle that emitted a diagnostic for the
  // device so abandon-grace works after settings reads. Initialized to
  // recorder construction time on reload so a transient SDK miss right after
  // restart does not delete persisted plans.
  private lastSeenAtMs: Map<string, number>;

  private dirty = false;

  constructor(private readonly deps: ActivePlanPersistDeps) {
    const loaded = deps.load();
    this.plans = loaded ? { ...loaded.plansByDeviceId } : {};
    const constructedAtMs = Date.now();
    this.lastSeenAtMs = new Map(Object.keys(this.plans).map((id) => [id, constructedAtMs]));
  }

  // Called from the flow card handler so the UI shows a pending hero immediately,
  // before the next plan cycle has a chance to compute a horizon.
  markPending(seed: ActivePlanFlowCardSeed, nowMs: number): void {
    const existing = this.plans[seed.deviceId];
    const signature = buildObjectiveSignature(seed);
    if (existing && existing.deadlineAtMs === seed.deadlineAtMs && existing.objectiveSignature === signature) {
      if (existing.deviceName !== seed.deviceName) {
        this.plans[seed.deviceId] = { ...existing, deviceName: seed.deviceName };
        this.dirty = true;
      }
      return;
    }
    this.plans[seed.deviceId] = createPlanFromSeed(seed, nowMs);
    this.lastSeenAtMs.set(seed.deviceId, nowMs);
    this.dirty = true;
  }

  // Called from the flow card handler when the objective is cleared.
  clearForDevice(deviceId: string): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.dirty = true;
  }

  // Per-cycle observation. Reads `horizonPlan` from each diagnostic and updates
  // the persisted plan iff a replan trigger fires.
  observe(diagnostics: readonly DeferredObjectiveDiagnostic[], nowMs: number): void {
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      this.lastSeenAtMs.set(diag.deviceId, nowMs);
      this.observeDiagnostic(diag, nowMs);
    }
    this.dropExpiredAndAbandoned(nowMs);
  }

  private observeDiagnostic(diag: DeferredObjectiveDiagnostic, nowMs: number): void {
    const signature = buildSignatureFromDiagnostic(diag);
    if (signature === null) return;
    const existing = this.plans[diag.deviceId];
    // A previous record for a different deadline is stale — replace it.
    if (existing && existing.deadlineAtMs !== diag.deadlineAtMs) {
      delete this.plans[diag.deviceId];
    }
    const candidateHours = buildHoursFromHorizonPlan(diag);
    if (candidateHours === null) {
      // Diagnostic without horizonPlan (e.g. prices missing): can't compute a
      // revision. Auto-create a pending record so the UI knows the objective
      // is being tracked.
      this.ensurePendingRecord(diag, signature, nowMs);
      return;
    }
    const current = this.plans[diag.deviceId];
    if (!current) {
      // No prior record; the recorder discovered the objective via the
      // diagnostic itself (e.g. objective enabled before this code shipped, or
      // app restarted without persisted state). Treat the original cause as
      // the flow card.
      this.writeFirstRevision(diag, signature, candidateHours, 'flow_card', nowMs);
      return;
    }
    if (current.pending || current.latest === null) {
      // Was waiting for prices (or freshly seeded); now we have an allocation.
      const reason: DeferredObjectiveActivePlanRevisionReason = current.pending && current.startedAtMs < nowMs
        ? 'prices_arrived'
        : 'flow_card';
      this.writeFirstRevision(diag, signature, candidateHours, reason, nowMs);
      return;
    }
    const backfilled = this.backfillCommitmentIfMissing(current, signature, nowMs);
    this.maybeWriteReplanRevision(diag, signature, candidateHours, backfilled, nowMs);
  }

  // Plans persisted before the stable-schedule commitment shipped (v2.7.3 and
  // earlier) carry `latest.hours` but no `commitment`, which causes
  // `maybeWriteReplanRevision` and `resolveCommittedHours` to keep treating the
  // allocation as advisory — the executor re-optimises every cycle. Quietly
  // adopt the existing `latest.hours` as the committed envelope so the
  // post-upgrade behaviour matches new plans. No revision is emitted: this is
  // a data-shape migration, not a user-visible replan.
  //
  // Caller has already ensured `!current.pending` and `current.latest !== null`.
  // Skipping when `latest.hours` is empty preserves the "no hours scheduled"
  // shape rather than committing to an empty envelope. We do not race with
  // `markPending` / `clearForDevice`: both run synchronously from flow card
  // handlers, and any plan with `latest !== null` has already left the pending
  // state — so by the time we reach this path the legacy record is stable
  // enough to commit.
  //
  // We also gate the backfill on the persisted `objectiveSignature` matching
  // the current diagnostic's resolved signature. When they differ (e.g. the
  // user changed the target/enforcement before the upgrade was observed), the
  // persisted `latest.hours` correspond to the OLD objective — committing to
  // them would lock in stale hours for the new target. In that case we skip;
  // `maybeWriteReplanRevision` will then detect the signature change and
  // write a fresh revision with the correct commitment via the first-revision
  // path.
  private backfillCommitmentIfMissing(
    current: DeferredObjectiveActivePlanV1,
    currentSignature: string,
    nowMs: number,
  ): DeferredObjectiveActivePlanV1 {
    if (current.commitment) return current;
    if (current.objectiveSignature !== currentSignature) return current;
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    if (latest.hours.length === 0) return current;
    const backfilled: DeferredObjectiveActivePlanV1 = {
      ...current,
      commitment: {
        committedAtMs: nowMs,
        hours: latest.hours,
      },
    };
    this.plans[current.deviceId] = backfilled;
    this.dirty = true;
    return backfilled;
  }

  private ensurePendingRecord(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    nowMs: number,
  ): void {
    const pendingReason = resolvePendingReason(diag);
    const diagnosticReasonCode = resolveDiagnosticReasonCode(diag);
    const existing = this.plans[diag.deviceId];
    if (existing !== undefined) {
      // Refresh `pendingReason` (pending records only — it's meaningless for
      // executed plans) and `diagnosticReasonCode` (always — must surface the
      // current cause even on non-pending plans). The non-pending path matters
      // for the unplug-mid-schedule case: an EV with a persisted revision that
      // transitions to `objective_invalid_session` needs to drive the
      // "Charging plan paused — car unplugged" state on the device card.
      const reasonChanged = existing.pending && existing.pendingReason !== pendingReason;
      const diagChanged = existing.diagnosticReasonCode !== diagnosticReasonCode;
      if (reasonChanged || diagChanged) {
        const updated: DeferredObjectiveActivePlanV1 = existing.pending
          ? { ...existing, pendingReason }
          : { ...existing };
        if (diagnosticReasonCode !== undefined) {
          updated.diagnosticReasonCode = diagnosticReasonCode;
        } else {
          delete updated.diagnosticReasonCode;
        }
        this.plans[diag.deviceId] = updated;
        this.dirty = true;
      }
      return;
    }
    this.plans[diag.deviceId] = createPlanFromDiagnostic(diag, signature, nowMs);
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_pending',
      deviceId: diag.deviceId,
      reason: 'awaiting_horizon_plan',
      ...buildActivePlanLifecycleFields(diag, this.plans[diag.deviceId]!.startedAtMs),
    });
  }

  private writeFirstRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    hours: DeferredObjectiveActivePlanHourV1[],
    reason: DeferredObjectiveActivePlanRevisionReason,
    nowMs: number,
  ): void {
    const revision = buildRevision({ diag, hours, revision: 1, reason, nowMs });
    const startedAtMs = this.plans[diag.deviceId]?.startedAtMs ?? nowMs;
    const provenance = resolveProvenance(diag);
    // Freeze the plan-level total duration here so the hero meta line stays
    // stable across revisions. See `resolvePlanLevelDurationSnapshot` for the
    // preservation/reset rules applied during subsequent revisions.
    this.plans[diag.deviceId] = {
      deviceId: diag.deviceId,
      deviceName: diag.deviceName ?? null,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      deadlineAtMs: diag.deadlineAtMs as number,
      startedAtMs,
      pending: false,
      objectiveSignature: signature,
      commitment: {
        committedAtMs: nowMs,
        hours,
      },
      ...(provenance ? { kwhPerUnitProvenance: provenance } : {}),
      ...(revision.planningSpeedKw !== undefined ? { initialPlanningSpeedKw: revision.planningSpeedKw } : {}),
      ...(revision.estimatedDurationText !== undefined
        ? { initialEstimatedDurationText: revision.estimatedDurationText }
        : {}),
      original: revision,
      latest: revision,
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: 1,
      reason,
      hourCount: hours.length,
      ...buildActivePlanLifecycleFields(diag, startedAtMs),
    });
  }

  private maybeWriteReplanRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    hours: DeferredObjectiveActivePlanHourV1[],
    current: DeferredObjectiveActivePlanV1,
    nowMs: number,
  ): void {
    // Caller (`observeDiagnostic`) already returns early when `current.latest`
    // is null, so we can dereference it directly here.
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    const horizonPlan = diag.horizonPlan as NonNullable<typeof diag.horizonPlan>;
    // `rescueOnly` routes to `flow_permission_changed` below so the history detail
    // names the Flow permission change, not a generic objective edit.
    const sigDiff = compareObjectiveSignatures(current.objectiveSignature, signature);
    const objectiveChanged = sigDiff.changed;
    // When the objective signature changes, the previous commitment is
    // discarded and the live `hours` become the new commitment. Otherwise
    // we merge live into commitment so per-cycle growth (within-hour drift
    // or phase-2 expansion) extends the commitment while the existing
    // committed kWh is preserved as a floor against transient shrinkage —
    // see `mergeHoursPreservingCommitment` for the merge rules.
    const effectiveHours = objectiveChanged
      ? hours
      : mergeHoursPreservingCommitment(current.commitment?.hours ?? [], hours);
    // Schedule change = user-visible "new plan" (set of charging hours).
    // Drives the `deadline_plan_changed` flow trigger.
    const scheduleChanged = !sameHourSchedule(latest.hours, effectiveHours);
    // Same charging hours but consumer-visible status fields drifted — see
    // `hasMetadataDriftedWithinSchedule` for the field list. Covers
    // `planStatus` transitions (drives the "Can't fully meet" chip) and
    // `dailyBudgetExhaustedBucketCount` (drives the per-bucket headroom
    // explanation). Per-cycle drift in `plannedKWh` / `energyNeededKWh` is
    // intentionally excluded to keep settings I/O budget in check on actively
    // charging EVs.
    const metadataDriftedWithinSchedule = !scheduleChanged
      && hasMetadataDriftedWithinSchedule({ latest, horizonPlan, diag });
    // Any kwhPerUnitSource change is a replan trigger so persisted metadata
    // (`kwhPerUnitSource`, `energyNeededKWh`, `planStatus`) cannot go stale
    // when the bucket allocation happens to be byte-identical across a source
    // flip. The reason is only `rate_refined` for the bootstrap→learned
    // direction; the rarer learned→bootstrap regression (profile pruned at
    // retention or device removed) falls through to `prices_revised`.
    //
    // `null` means the resolver did not consult a profile (e.g. target is
    // already satisfied so `energyNeededKWh = 0`). Treat that as "no source
    // change" rather than coercing it to `'learned'` — otherwise a bootstrap
    // revision followed by a satisfied diagnostic would spuriously fire
    // `rate_refined` even though nothing was learned.
    const { sourceChanged, sourceRefined } = resolveSourceTransition({ latest, diag });
    // TODO: device_unavailable + measured_deviation triggers — wired here once
    // device-level metering exists. For now those reasons are not used.
    if (!shouldWriteReplanRevision({
      objectiveChanged,
      scheduleChanged,
      metadataDriftedWithinSchedule,
      sourceChanged,
    })) return;
    const reason = resolveReplanReason({
      objectiveChanged,
      rescuePermissionOnlyChanged: sigDiff.rescueOnly,
      sourceRefined,
      pricesAdvanced: hasPriceHorizonAdvanced(latest, diag),
    });
    const nextRevision = latest.revision + 1;
    const revision = buildRevision({ diag, hours: effectiveHours, revision: nextRevision, reason, nowMs });
    const provenance = resolveProvenance(diag);
    // Provenance updates are best-effort; preserve the existing snapshot when
    // the new diagnostic didn't resolve a profile so we don't clobber useful
    // accepted-sample counts with a transient `null`. Don't carry the
    // snapshot across an objective-kind change on the same device id —
    // accepted-sample counts and confidence are kind-specific.
    const nextProvenance = provenance
      ?? (current.objectiveKind === diag.objectiveKind ? current.kwhPerUnitProvenance : undefined);
    const snapshot = resolvePlanLevelDurationSnapshot({ current, revision, reason });
    // Drop the prior snapshot fields from `...current` so the
    // `objective_changed` reset path can genuinely omit them when the new
    // revision has no usable planning speed. `toPersistedPlanLevelDurationFields`
    // then re-adds the keys only when the resolved snapshot has a value, so
    // the persisted JSON.stringify output stays identical to the prior
    // explicit-undefined idiom while the in-memory shape no longer exposes
    // `undefined` keys that violate `exactOptionalPropertyTypes`-style
    // contracts.
    const {
      initialPlanningSpeedKw: _droppedSnapshotSpeed,
      initialEstimatedDurationText: _droppedSnapshotDurationText,
      ...currentWithoutSnapshot
    } = current;
    this.plans[diag.deviceId] = {
      ...currentWithoutSnapshot,
      deviceName: diag.deviceName ?? current.deviceName,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      objectiveSignature: signature,
      // Persist the merged `effectiveHours` as the commitment when the
      // schedule has changed (i.e. expansion added one or more new hours).
      // `committedAtMs` advances to nowMs on each grow so consumers can
      // reason about "when did this hour join the plan". When the schedule
      // is unchanged, preserve the existing commitment (including its
      // original `committedAtMs`) so within-schedule metadata drift doesn't
      // visibly reshape the commitment timestamp.
      commitment: resolveCommitment({
        objectiveChanged,
        scheduleChanged,
        hours,
        effectiveHours,
        previous: current.commitment,
        nowMs,
      }),
      ...(nextProvenance ? { kwhPerUnitProvenance: nextProvenance } : {}),
      ...toPersistedPlanLevelDurationFields(snapshot),
      latest: revision,
      // Prepend the prior `latest` onto the history log, FIFO-pruned to the
      // cap so the persisted blob stays bounded. The head of the array is
      // always "the revision immediately before the current `latest`."
      history: [latest, ...(current.history ?? [])].slice(0, MAX_HISTORY_REVISIONS),
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: nextRevision,
      reason,
      hourCount: effectiveHours.length,
      ...buildActivePlanLifecycleFields(diag, current.startedAtMs),
    });
    if (shouldFireNotification(latest.hours.length, effectiveHours.length, horizonPlan.status)) {
      this.deps.onRevisionWritten?.({
        deviceId: diag.deviceId,
        deviceName: diag.deviceName ?? current.deviceName,
        objectiveKind: diag.objectiveKind,
        revision,
        reason,
        allocationChanged: true,
        projectedFinishAtMs: resolveProjectedFinishAtMs(diag),
      });
    }
  }

  private dropExpiredAndAbandoned(nowMs: number): void {
    for (const [deviceId, plan] of Object.entries(this.plans)) {
      if (plan.deadlineAtMs <= nowMs) {
        delete this.plans[deviceId];
        this.lastSeenAtMs.delete(deviceId);
        this.dirty = true;
        this.emit({ event: 'active_plan_dropped', deviceId, reason: 'deadline_passed' });
        continue;
      }
      // Diagnostic stopped appearing while the deadline is still in the
      // future. This could be objective disabled, device unavailable, or a
      // transient empty Homey settings read. Wait for the abandon grace
      // before dropping so a single bad cycle does not delete persisted
      // state. A re-enabled objective produces a fresh objectiveSignature
      // which observe() picks up via objective_changed before grace expires.
      const lastSeen = this.lastSeenAtMs.get(deviceId) ?? nowMs;
      if (nowMs - lastSeen >= ABANDON_GRACE_MS) {
        delete this.plans[deviceId];
        this.lastSeenAtMs.delete(deviceId);
        this.dirty = true;
        this.emit({ event: 'active_plan_dropped', deviceId, reason: 'objective_inactive' });
      }
    }
  }

  flushIfDirty(): boolean {
    if (!this.dirty) return false;
    this.deps.save({
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    });
    this.dirty = false;
    return true;
  }

  getActivePlansSnapshot(): DeferredObjectiveActivePlansV1 {
    return {
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    };
  }

  // Test seam: expose internals for assertions without going through save().
  getPlanForTests(deviceId: string): DeferredObjectiveActivePlanV1 | undefined {
    return this.plans[deviceId];
  }

  resetForTests(): void {
    this.plans = {};
    this.lastSeenAtMs.clear();
    this.dirty = false;
  }

  private emit(payload: Record<string, unknown>): void {
    if (this.deps.debugStructured) {
      this.deps.debugStructured(payload);
    } else {
      logger.debug(payload);
    }
  }
}
