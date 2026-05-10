import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION } from './activePlanSettings';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

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

const hoursSignature = (hours: readonly DeferredObjectiveActivePlanHourV1[]): string => (
  JSON.stringify(hours.map((h) => [h.startsAtMs, h.plannedKWh]))
);

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
}): DeferredObjectiveActivePlanRevisionV1 => ({
  revision: params.revision,
  revisedAtMs: params.nowMs,
  computedFromPricesUpTo: resolveComputedFromPricesUpTo(params.diag),
  reason: params.reason,
  hours: params.hours,
});

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
    this.maybeWriteReplanRevision(diag, signature, candidateHours, current, nowMs);
  }

  private ensurePendingRecord(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    nowMs: number,
  ): void {
    if (this.plans[diag.deviceId] !== undefined) return;
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
    const objectiveChanged = current.objectiveSignature !== signature;
    const allocationChanged = hoursSignature(latest.hours) !== hoursSignature(hours);
    // TODO: device_unavailable + measured_deviation triggers — wired here once
    // device-level metering exists. For now those reasons are not used.
    if (!objectiveChanged && !allocationChanged) return;
    const reason: DeferredObjectiveActivePlanRevisionReason = objectiveChanged
      ? 'objective_changed'
      : 'prices_revised';
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
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: nextRevision,
      reason,
      hourCount: hours.length,
    });
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
    if (!this.deps.debugStructured) return;
    this.deps.debugStructured(payload);
  }
}

