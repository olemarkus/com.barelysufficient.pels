import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION } from './activePlanSettings';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectivePlanRevisionEvent } from './planRevisionBus';

const KWH_ROUNDING_FACTOR = 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// Mirror `planHistory.ts` ABANDON_GRACE_MS. Homey settings reads can transiently
// return empty/malformed data; if a plan cycle ever produces an empty
// diagnostic stream we must not drop persisted plans on the first miss. Wait
// at least an hour without seeing the diagnostic before declaring the
// objective abandoned.
const ABANDON_GRACE_MS = 60 * 60 * 1000;

const roundKWh = (value: number): number => Math.round(value * KWH_ROUNDING_FACTOR) / KWH_ROUNDING_FACTOR;

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
};

export const buildObjectiveSignature = (params: {
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
}): string => JSON.stringify([
  params.objectiveKind,
  params.targetTemperatureC,
  params.targetPercent,
  params.deadlineAtMs,
  params.enforcement,
]);

const buildSignatureFromDiagnostic = (diag: DeferredObjectiveDiagnostic): string | null => {
  if (diag.deadlineAtMs === null) return null;
  return buildObjectiveSignature({
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diag.targetTemperatureC,
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs,
    enforcement: diag.enforcement,
  });
};

const buildHoursFromHorizonPlan = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanHourV1[] | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  // The horizon planner trims the current bucket's start to `nowMs` and may
  // split a single hour into two segments at `planningEndMs` (see
  // `bucketAllocation.ts`), so plannedBucket startMs values can be
  // mid-hour. The Settings UI keys planned usage by hour-aligned price-horizon
  // start timestamps, so floor each bucket to its containing hour and sum
  // segments that collapse into the same hour.
  const byHour = new Map<number, number>();
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    const hourStart = Math.floor(bucket.startMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    byHour.set(hourStart, (byHour.get(hourStart) ?? 0) + bucket.plannedUsefulEnergyKWh);
  }
  return [...byHour.entries()]
    .map(([startsAtMs, plannedKWh]) => ({ startsAtMs, plannedKWh: roundKWh(plannedKWh) }))
    .sort((left, right) => left.startsAtMs - right.startsAtMs);
};

const resolveProjectedFinishAtMs = (
  diag: DeferredObjectiveDiagnostic,
): number | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  // The last planned bucket may be only partially used; estimate finish time
  // from its fill ratio so the trigger token reflects realistic completion,
  // not just the hour boundary.
  let lastPlannedBucket: typeof horizonPlan.plannedBuckets[number] | null = null;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    if (lastPlannedBucket === null || bucket.startMs > lastPlannedBucket.startMs) {
      lastPlannedBucket = bucket;
    }
  }
  if (lastPlannedBucket === null) return null;
  const bucketDurationMs = lastPlannedBucket.endMs - lastPlannedBucket.startMs;
  if (bucketDurationMs <= 0) return null;
  const capacity = lastPlannedBucket.usefulEnergyCapacityKWh;
  const fraction = capacity > 0
    ? Math.min(1, Math.max(0, lastPlannedBucket.plannedUsefulEnergyKWh / capacity))
    : 1;
  return Math.round(lastPlannedBucket.startMs + fraction * bucketDurationMs);
};

const resolveComputedFromPricesUpTo = (
  diag: DeferredObjectiveDiagnostic,
): number | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  let latest: number | null = null;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (latest === null || bucket.endMs > latest) latest = bucket.endMs;
  }
  return latest;
};

// Schedule comparison: two hour lists are equivalent iff they cover the same
// set of hour-aligned `startsAtMs` values, in order. `plannedKWh` is
// deliberately excluded — a shrinking `energyNeededKWh` (e.g. consumption
// during the same set of charging hours) redistributes kWh across the same
// hours without changing the user-visible schedule, and must not fire a
// "new plan" notification.
const sameHourSchedule = (
  a: readonly DeferredObjectiveActivePlanHourV1[],
  b: readonly DeferredObjectiveActivePlanHourV1[],
): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.startsAtMs !== b[i]!.startsAtMs) return false;
  }
  return true;
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
  }),
  original: null,
  latest: null,
});

// Reason codes from `diagnosticsBridge` that indicate the device-data side of the diagnostic
// failed before a horizon plan could be built. The pending hero needs to say "waiting for a
// reading from the device", not "waiting for prices" — see the comment in `ensurePendingRecord`.
const DEVICE_DATA_REASON_CODES: ReadonlySet<string> = new Set([
  'objective_invalid_deadline',
  'objective_invalid_session',
  'objective_missing_capacity',
  'objective_missing_charge_rate',
  'objective_missing_device',
  'objective_missing_temperature',
  'objective_progress_stale',
]);

const resolvePendingReason = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanPendingReason => {
  if (diag.reasonCode === 'objective_price_feature_disabled') return 'price_feature_disabled';
  if (DEVICE_DATA_REASON_CODES.has(diag.reasonCode)) return 'device_data_missing';
  return 'awaiting_horizon_plan';
};

const createPlanFromDiagnostic = (
  diag: DeferredObjectiveDiagnostic,
  signature: string,
  nowMs: number,
): DeferredObjectiveActivePlanV1 => ({
  deviceId: diag.deviceId,
  deviceName: diag.deviceName ?? null,
  objectiveKind: diag.objectiveKind,
  targetTemperatureC: diag.targetTemperatureC,
  targetPercent: diag.targetPercent,
  deadlineAtMs: diag.deadlineAtMs as number,
  startedAtMs: nowMs,
  pending: true,
  pendingReason: resolvePendingReason(diag),
  objectiveSignature: signature,
  original: null,
  latest: null,
});

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
  return {
    revision: params.revision,
    revisedAtMs: params.nowMs,
    computedFromPricesUpTo: resolveComputedFromPricesUpTo(params.diag),
    reason: params.reason,
    hours: params.hours,
    energyNeededKWh: horizonPlan.energyNeededKWh,
    planStatus: horizonPlan.status,
    ...(source !== null ? { kwhPerUnitSource: source } : {}),
  };
};

const seedScheduledStarts = (plan: DeferredObjectiveActivePlanV1): Set<number> => {
  const starts = new Set<number>();
  for (const hour of plan.original?.hours ?? []) starts.add(hour.startsAtMs);
  for (const hour of plan.latest?.hours ?? []) starts.add(hour.startsAtMs);
  return starts;
};

// Treat absence as `learned` so legacy persisted revisions don't appear to
// transition to `learned` on the first observation after upgrade.
const resolveLatestKwhPerUnitSource = (
  latest: DeferredObjectiveActivePlanRevisionV1,
): 'learned' | 'bootstrap' => latest.kwhPerUnitSource ?? 'learned';

export class DeferredObjectiveActivePlanRecorder {
  private plans: Record<string, DeferredObjectiveActivePlanV1>;

  // In-memory only. Records the last cycle that emitted a diagnostic for the
  // device so abandon-grace works after settings reads. Initialized to
  // recorder construction time on reload so a transient SDK miss right after
  // restart does not delete persisted plans.
  private lastSeenAtMs: Map<string, number>;

  // In-memory only. Per-device union of every `startsAtMs` ever scheduled
  // during the current plan's lifetime, used to drive the monotonic
  // `accumulatedHourCount` on revision events. Reset when the objective
  // signature changes or the plan is cleared. Reseeded on construction from
  // `original.hours ∪ latest.hours` of any persisted plan — the best
  // available approximation after a restart drops mid-plan history.
  private scheduledHourStarts: Map<string, Set<number>>;

  private dirty = false;

  constructor(private readonly deps: ActivePlanPersistDeps) {
    const loaded = deps.load();
    this.plans = loaded ? { ...loaded.plansByDeviceId } : {};
    const constructedAtMs = Date.now();
    this.lastSeenAtMs = new Map(Object.keys(this.plans).map((id) => [id, constructedAtMs]));
    this.scheduledHourStarts = new Map(
      Object.entries(this.plans).map(([id, plan]) => [id, seedScheduledStarts(plan)]),
    );
  }

  // Called from the flow card handler so the UI shows a pending hero immediately,
  // before the next plan cycle has a chance to compute a horizon.
  markPending(seed: ActivePlanFlowCardSeed, nowMs: number): void {
    const existing = this.plans[seed.deviceId];
    if (existing && existing.deadlineAtMs === seed.deadlineAtMs) {
      // Same deadline: leave signature/targets/kind alone so the next observe()
      // cycle can detect an objective change naturally and write a revision
      // with reason `objective_changed`. Updating those fields here would mask
      // the diff because `maybeWriteReplanRevision` compares the diagnostic's
      // signature against `current.objectiveSignature`. Refresh only the
      // cosmetic device name.
      if (existing.deviceName !== seed.deviceName) {
        this.plans[seed.deviceId] = { ...existing, deviceName: seed.deviceName };
        this.dirty = true;
      }
      return;
    }
    this.plans[seed.deviceId] = createPlanFromSeed(seed, nowMs);
    this.lastSeenAtMs.set(seed.deviceId, nowMs);
    this.scheduledHourStarts.delete(seed.deviceId);
    this.dirty = true;
  }

  // Called from the flow card handler when the objective is cleared.
  clearForDevice(deviceId: string): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.scheduledHourStarts.delete(deviceId);
    this.dirty = true;
  }

  private recordScheduledHours(
    deviceId: string,
    hours: readonly DeferredObjectiveActivePlanHourV1[],
    resetFirst: boolean,
  ): number {
    const starts = resetFirst ? new Set<number>() : (this.scheduledHourStarts.get(deviceId) ?? new Set<number>());
    for (const hour of hours) starts.add(hour.startsAtMs);
    this.scheduledHourStarts.set(deviceId, starts);
    return starts.size;
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
      this.scheduledHourStarts.delete(diag.deviceId);
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
    this.maybeWriteReplanRevision(diag, signature, candidateHours, current, nowMs);
  }

  private ensurePendingRecord(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    nowMs: number,
  ): void {
    const pendingReason = resolvePendingReason(diag);
    const existing = this.plans[diag.deviceId];
    if (existing !== undefined) {
      // Refresh `pendingReason` so the UI reflects the current cause even when
      // the record was first seeded by a flow card (no diagnostic context) or
      // when the cause transitions, e.g. user toggles price-aware optimisation
      // off while waiting for the price horizon.
      if (existing.pending && existing.pendingReason !== pendingReason) {
        this.plans[diag.deviceId] = { ...existing, pendingReason };
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
    this.plans[diag.deviceId] = {
      deviceId: diag.deviceId,
      deviceName: diag.deviceName ?? null,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diag.targetTemperatureC,
      targetPercent: diag.targetPercent,
      deadlineAtMs: diag.deadlineAtMs as number,
      startedAtMs,
      pending: false,
      objectiveSignature: signature,
      original: revision,
      latest: revision,
    };
    this.dirty = true;
    this.recordScheduledHours(diag.deviceId, hours, true);
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: 1,
      reason,
      hourCount: hours.length,
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
    const objectiveChanged = current.objectiveSignature !== signature;
    // Schedule change = user-visible "new plan" (set of charging hours).
    // Drives the `deadline_plan_changed` flow trigger.
    const scheduleChanged = !sameHourSchedule(latest.hours, hours);
    // `planStatus` transitions (on_track <-> at_risk <-> cannot_meet) drive
    // the "Can't fully meet" chip in Settings UI, so they must persist even
    // when the schedule is unchanged. Per-cycle drift in `plannedKWh` /
    // `energyNeededKWh` is intentionally NOT a persist trigger: an actively
    // charging EV shrinks `energyNeededKWh` monotonically every plan cycle
    // (~30s), and writing the persisted setting on every cycle was filling
    // the Homey settings I/O budget for no user-visible benefit. The
    // settings UI reads `activePlan.latest.energyNeededKWh` as authoritative
    // but tolerates the slightly stale value — the original starting energy
    // is more meaningful to the user than a near-zero final value.
    const statusChanged = !scheduleChanged && latest.planStatus !== horizonPlan.status;
    // Any kwhPerUnitSource change is a replan trigger so the persisted
    // `kwhPerUnitSource` cannot stay stale at e.g. 'learned' while the
    // planner is using bootstrap, even when the bucket allocation happens
    // to be byte-identical across a source flip. The reason is only
    // `rate_refined` for the bootstrap→learned direction; the rarer
    // learned→bootstrap regression (profile pruned at retention or device
    // removed) falls through to `prices_revised`.
    //
    // `null` means the resolver did not consult a profile (e.g. target is
    // already satisfied so `energyNeededKWh = 0`). Treat that as "no source
    // change" rather than coercing it to `'learned'` — otherwise a bootstrap
    // revision followed by a satisfied diagnostic would spuriously fire
    // `rate_refined` even though nothing was learned.
    const previousSource = resolveLatestKwhPerUnitSource(latest);
    const nextSource = diag.kwhPerUnitSource;
    const sourceChanged = nextSource !== null && previousSource !== nextSource;
    const sourceRefined = previousSource === 'bootstrap' && nextSource === 'learned';
    // TODO: device_unavailable + measured_deviation triggers — wired here once
    // device-level metering exists. For now those reasons are not used.
    if (!objectiveChanged && !scheduleChanged && !statusChanged && !sourceChanged) return;
    const reason: DeferredObjectiveActivePlanRevisionReason = (() => {
      if (objectiveChanged) return 'objective_changed';
      if (sourceRefined) return 'rate_refined';
      return 'prices_revised';
    })();
    const nextRevision = latest.revision + 1;
    const revision = buildRevision({ diag, hours, revision: nextRevision, reason, nowMs });
    this.plans[diag.deviceId] = {
      ...current,
      deviceName: diag.deviceName ?? current.deviceName,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diag.targetTemperatureC,
      targetPercent: diag.targetPercent,
      objectiveSignature: signature,
      latest: revision,
    };
    this.dirty = true;
    const accumulatedHourCount = this.recordScheduledHours(diag.deviceId, hours, objectiveChanged);
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: nextRevision,
      reason,
      hourCount: hours.length,
    });
    if (scheduleChanged) {
      this.deps.onRevisionWritten?.({
        deviceId: diag.deviceId,
        deviceName: diag.deviceName ?? current.deviceName,
        objectiveKind: diag.objectiveKind,
        revision,
        reason,
        allocationChanged: true,
        projectedFinishAtMs: resolveProjectedFinishAtMs(diag),
        accumulatedHourCount,
      });
    }
  }

  private dropExpiredAndAbandoned(nowMs: number): void {
    for (const [deviceId, plan] of Object.entries(this.plans)) {
      if (plan.deadlineAtMs <= nowMs) {
        delete this.plans[deviceId];
        this.lastSeenAtMs.delete(deviceId);
        this.scheduledHourStarts.delete(deviceId);
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
        this.scheduledHourStarts.delete(deviceId);
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
    if (!this.deps.debugStructured) return;
    this.deps.debugStructured(payload);
  }
}

