import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryV5,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION } from './planHistorySettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import {
  stallEvidenceCoversTarget,
  type StallEvidence,
} from '../../../packages/shared-domain/src/idleClassificationCopy';
import { buildEndedEventFromEntry, type DeferredObjectiveEndedBus } from './endedEventBus';
import {
  appendHourlyContribution,
  buildFinalizedAttributionEvent,
  drainProgressSamples,
  hourBucketMs,
  type HourPriceResolver,
} from './planHistoryV4Helpers';
import {
  buildKey,
  finalizeRecord,
  findPlanForRecord,
  type InProgressKey,
  type InProgressRecord,
  isPlannableStatus,
  isSatisfiedStatus,
  lastObservedAtMs,
  mergeRecord,
  promoteRecordToStalled,
  rawHorizonStatus,
  recordNonPlannableTick,
  stallClassificationToMetReason,
  startRecord,
} from './planHistoryInProgressState';
import { randomUUID } from 'node:crypto';
import { toPlanHistoryRecord } from '../../../packages/shared-domain/src/deferredPlanHistoryResolvedView';
import type { PersistedMeteredDeliveryState } from './planHistoryMeteredState';
import type { MeteredDeviceReading } from '../../ports/meteredSnapshots';

const logger = getLogger('plan/deferred-history');
// Cap the rolling buffer. One deferred objective produces at most one entry per deadline run
// (per-day for HH:mm objectives), so 30 entries covers ~one month of history per device for a
// single-device household and shorter spans for multi-device homes. Bounded JSON size keeps
// startup reads cheap on Homey Pro.
export const HISTORY_ENTRY_CAP = 30;

// If a previously-tracked diagnostic stops appearing for this long while its deadline is still
// in the future, treat the run as abandoned (settings disabled, device removed, evaluator
// dropped to unknown for an extended stretch).
const ABANDON_GRACE_MS = 60 * 60 * 1000;
const MAX_METERED_DELIVERY_SAMPLE_GAP_MS = 10 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

type DeliveryInterval = {
  startMs: number;
  endMs: number;
  powerKw: number;
};

const readingEndMs = (reading: MeteredDeviceReading): number => (
  reading.kind === 'instantaneous' ? reading.observedAtMs : reading.endMs
);

const resolveDeliveryInterval = (
  reading: MeteredDeviceReading,
  previous: MeteredDeviceReading | undefined,
): DeliveryInterval | null => {
  if (reading.kind === 'interval_average') {
    if (previous !== undefined && reading.endMs <= readingEndMs(previous)) return null;
    if (reading.endMs <= reading.startMs) return null;
    return { startMs: reading.startMs, endMs: reading.endMs, powerKw: reading.powerKw };
  }
  if (previous?.kind !== 'instantaneous') return null;
  if (reading.observedAtMs <= previous.observedAtMs) return null;
  return {
    startMs: previous.observedAtMs,
    endMs: reading.observedAtMs,
    powerKw: previous.powerKw,
  };
};

// Reads through the observer-layer idle classifier
// (`lib/observer/idleClassifier.ts`). `near_target_idle` and `capped_idle`
// both promote the run to satisfied (the run reflects "the device went as
// far as it was going to go" — same outcome, two underlying causes which
// the recorder distinguishes via `metReason`). `unresponsive` is a
// hardware-fault signal and is deliberately ignored — we don't want to
// silently call a tripped breaker "succeeded".
export type DeferredObjectiveStallClassificationReader = (
  deviceId: string,
) => StallEvidence | undefined;

export type DeferredObjectiveBackfillConfig = {
  deviceId: string;
  objectiveKind: 'temperature' | 'ev_soc';
  deadlineAtMs: number;
  targetTemperatureC: number | null;
  targetPercent: number | null;
};

const synthesizeBackfillEntry = (
  config: DeferredObjectiveBackfillConfig,
): DeferredObjectivePlanHistoryRecord => ({
  id: randomUUID(),
  deviceId: config.deviceId,
  targetValue: config.objectiveKind === 'temperature'
    ? config.targetTemperatureC
    : config.targetPercent,
  deadlineAtMs: config.deadlineAtMs,
  startedAtMs: config.deadlineAtMs,
  finalizedAtMs: config.deadlineAtMs,
  startProgressValue: null,
  finalProgressValue: null,
  initialEnergyNeededKWh: 0,
  outcome: 'abandoned',
  metAtMs: null,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'backfill',
  originalPlan: null,
  finalPlan: null,
});

export type PlanHistoryPersistDeps = {
  // Persisted history reader. Returns null when no payload exists yet
  // (first install / settings purge). Migration from older schemas is done
  // upstream by `normalizeDeferredObjectivePlanHistory`, so the recorder
  // accepts only the current compact v5 envelope.
  load: () => PlanHistoryLoadResult;
  // Persist the snapshot. Return `true` on success, `false` on failure (e.g. the underlying
  // settings.set threw and the host swallowed it). A `false` return keeps the recorder dirty
  // so a later flush retries, and lets callers gate side-effects (like advancing the
  // observation watermark) on real persistence success.
  save: (
    history: DeferredObjectivePlanHistoryV5,
    meteredDeliveryStates: readonly PersistedMeteredDeliveryState[],
  ) => boolean;
  // Optional bus the recorder publishes ended events to as runs finalize. The
  // recorder filters by `discoveredFrom === 'observation'` and public outcome
  // (`met`/`missed`/`abandoned`) before publishing — backfill and replaced
  // entries never reach the bus.
  endedBus?: DeferredObjectiveEndedBus;
  // Resolve the spot price and price tone (cheap/normal/expensive) for an
  // hour-aligned timestamp. The internal hour-rollover detector calls this
  // when it closes an hour so per-hour `hourlyContributions` carry a stable
  // band even if cheap/normal/expensive thresholds shift in a later
  // version. Returning `null` (no price data yet, hour outside the
  // published horizon) causes that hour's contribution to be skipped
  // rather than fabricated. The dep is optional so the recorder remains
  // useful in tests; without it no priced contribution is ever emitted.
  resolveHourPrice?: HourPriceResolver;
  // Optional structured-debug emitter. The recorder emits one
  // `deferred_objective_history_finalized` event per observation entry as it
  // finalizes, carrying the resolved miss attribution (cause + the raw plan-time
  // confidence / committed-floor / delivery inputs it rested on). This is the
  // telemetry that lets us count how many `missed` runs were genuine capacity
  // misses versus shaky-estimate / conservative-planning false alarms. Optional
  // so the recorder stays usable in tests and headless callers. Gated on the
  // `deferred_objectives` debug topic by the wiring in `setup/appInit.ts`.
  debugStructured?: StructuredDebugEmitter;
};

export type PlanHistoryLoadResult = {
  snapshot: DeferredObjectivePlanHistoryV5;
  persistenceSafe: boolean;
  meteredDeliveryStates?: readonly PersistedMeteredDeliveryState[];
};

export class DeferredObjectivePlanHistoryRecorder {
  private inProgress = new Map<InProgressKey, InProgressRecord>();
  private lastMeteredDeliveryByDeviceId = new Map<string, MeteredDeviceReading>();
  private restoredMeteredDeliveryByKey = new Map<InProgressKey, PersistedMeteredDeliveryState>();

  private entries: DeferredObjectivePlanHistoryRecord[];

  private dirty = false;

  private persistenceSafe: boolean;

  constructor(private readonly deps: PlanHistoryPersistDeps) {
    const loaded = deps.load();
    this.entries = loaded.snapshot.entries.slice();
    this.persistenceSafe = loaded.persistenceSafe;
    for (const state of loaded.meteredDeliveryStates ?? []) {
      this.restoredMeteredDeliveryByKey.set(buildKey(state.deviceId, state.deadlineAtMs), state);
    }
    this.trimEntries();
  }

  // Live trajectory for an in-flight run, stitched into the active-plans UI
  // payload (`setup/deferredObjectiveActivePlansUiAssembler.ts`) so the
  // smart-tasks widget can draw planned-vs-actual progress while the run is
  // open. Reads the in-memory in-progress record without mutating it
  // (`drainProgressSamples` copies + sorts the sample map). Returns null when no
  // run is open for the device; a device has at most one open run (one objective
  // per device), so the first matching record wins.
  getInProgressTrajectory(deviceId: string): {
    startProgressC: number | null;
    startProgressPercent: number | null;
    progressSamples: DeferredObjectivePlanHistoryProgressSample[];
  } | null {
    for (const record of this.inProgress.values()) {
      if (record.deviceId !== deviceId) continue;
      return {
        startProgressC: record.startProgressC,
        startProgressPercent: record.startProgressPercent,
        progressSamples: drainProgressSamples(record.progressSamples),
      };
    }
    return null;
  }

  observe(
    diagnostics: readonly DeferredObjectiveDiagnostic[],
    nowMs: number,
    activePlans: DeferredObjectiveActivePlansV1 | null = null,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): void {
    const seenKeys = new Set<InProgressKey>();
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      const key = buildKey(diag.deviceId, diag.deadlineAtMs);
      seenKeys.add(key);
      this.observeDiagnostic(diag, key, nowMs, activePlans, getStallClassification);
    }
    this.finalizeStaleRecords(seenKeys, nowMs);
  }

  // Runs after merge/start so the freeze-on-met-time logic in `mergeRecord`
  // doesn't overwrite the plateau on the cycle stall is declared.
  private maybePromoteOnStall(
    record: InProgressRecord,
    diag: DeferredObjectiveDiagnostic,
    nowMs: number,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): InProgressRecord {
    const evidence = getStallClassification?.(diag.deviceId);
    // The verdict alone is not enough: a device idling at a setback setpoint
    // PELS itself wrote is `near_target_idle` without having delivered this
    // task's target. Only evidence measured against a setpoint that covers the
    // target may promote. See `notes/deferred-load-objectives/README.md`
    // § "Observer stall evidence".
    const reason = stallEvidenceCoversTarget(evidence, diag.targetValue)
      ? stallClassificationToMetReason(evidence.classification)
      : null;
    return reason === null
      ? record
      : promoteRecordToStalled(record, diag, nowMs, reason);
  }

  private observeDiagnostic(
    diag: DeferredObjectiveDiagnostic,
    key: InProgressKey,
    nowMs: number,
    activePlans: DeferredObjectiveActivePlansV1 | null,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): void {
    const plan = findPlanForRecord(activePlans, { deviceId: diag.deviceId, deadlineAtMs: diag.deadlineAtMs! });
    const existing = this.inProgress.get(key);
    if (existing) {
      const horizonStatus = rawHorizonStatus(diag);
      const plannable = isPlannableStatus(horizonStatus) || isSatisfiedStatus(horizonStatus);
      // Plannable diagnostics roll forward progress + planning flags. Unknown/invalid still
      // count as observation ("PELS was watching"). If an already-met run later reports
      // trustworthy below-target progress, clear the live met marker; otherwise preserve
      // the last trustworthy progress.
      const merged = plannable
        ? mergeRecord(existing, diag, nowMs, plan)
        : recordNonPlannableTick(existing, diag, nowMs, plan);
      const settled = this.maybePromoteOnStall(merged, diag, nowMs, getStallClassification);
      this.inProgress.set(key, settled);
      return;
    }
    // Begin tracking on first sight of a future-dated deadline, regardless of status. The
    // deadline event is the recorded thing; observation quality is captured separately via
    // observedIntervals + progress nullability. A stale deadline starts no new record, but a
    // restored metered run must be reconstructed and finalized so its saved delivery survives.
    if (diag.deadlineAtMs! <= nowMs) {
      const restored = this.restoredMeteredDeliveryByKey.get(key);
      if (restored === undefined) return;
      const recovered = startRecord(diag, nowMs, plan);
      if (recovered === null) return;
      this.pushEntry(finalizeRecord(
        restoreMeteredDelivery(recovered, restored),
        nowMs,
        'deadline_passed',
      ));
      this.restoredMeteredDeliveryByKey.delete(key);
      return;
    }
    let next = startRecord(diag, nowMs, plan);
    if (!next) return;
    const restored = this.restoredMeteredDeliveryByKey.get(key);
    if (restored !== undefined) {
      next = restoreMeteredDelivery(next, restored);
      this.restoredMeteredDeliveryByKey.delete(key);
    }
    // Deliberately skip stall promotion on first-seen records. The
    // classification ticks AFTER plan emission (`tickIdleClassifier`), so the
    // value we'd read here is the *previous* cycle's result — which belongs
    // to whatever objective ran for this device on the prior tick. After a
    // `finalizeForUserChange` swap (user replaced target / deadline), that
    // stale `near_target_idle` would falsely auto-complete the brand-new run
    // on its first tick and stick until finalization. The next tick — where
    // the classifier has had a chance to re-evaluate against the actual
    // current objective — handles promotion through the `existing` branch.
    this.inProgress.set(key, next);
  }

  /**
   * Synthesize history entries for one-shot deadlines that elapsed while no plannable
   * observation was possible (e.g. PELS was off, or the diagnostic stream never produced an
   * entry for this objective). Each config carries a single absolute `deadlineAtMs`; we
   * include it only when it lies in the (fromMs, toMs] window and no entry already records
   * the same `(deviceId, deadlineAtMs)` key.
   */
  backfillFromConfig(
    configs: readonly DeferredObjectiveBackfillConfig[],
    fromMs: number,
    toMs: number,
  ): void {
    if (configs.length === 0 || toMs <= fromMs) return;
    const existingKeys = new Set<InProgressKey>(
      this.entries.map((entry) => buildKey(entry.deviceId, entry.deadlineAtMs)),
    );
    for (const config of configs) {
      if (config.deadlineAtMs <= fromMs || config.deadlineAtMs > toMs) continue;
      const key = buildKey(config.deviceId, config.deadlineAtMs);
      if (existingKeys.has(key)) continue;
      if (this.restoredMeteredDeliveryByKey.has(key)) continue;
      existingKeys.add(key);
      this.pushEntry(synthesizeBackfillEntry(config));
    }
  }

  /**
   * Finalize any in-progress run for this device because the user changed or cleared the
   * objective. `'replaced'` is for a new deadline / target replacing the prior one;
   * `'abandoned'` is for an explicit clear. Without this signal the recorder would wait the
   * full `ABANDON_GRACE_MS` before declaring the run abandoned, and a user-initiated swap
   * would be misreported as `'abandoned'` instead of `'replaced'`.
   *
   * The active-plan recorder deliberately keeps same-deadline target changes as in-run
   * revisions; history splits them into separate entries so each entry has a stable target
   * to judge outcome against.
   */
  finalizeForUserChange(deviceId: string, nowMs: number, reason: 'replaced' | 'abandoned'): void {
    for (const [key, record] of this.inProgress) {
      if (record.deviceId !== deviceId) continue;
      this.pushEntry(finalizeRecord(record, nowMs, reason));
      this.inProgress.delete(key);
    }
  }

  /**
   * Finalize any in-progress run for this device whose deadline has already elapsed,
   * synchronously, with reason `'deadline_passed'`. Counterpart to `finalizeForUserChange`
   * for the at-or-after-deadline branch of `applyDeferredObjectiveChange`: when the user
   * creates the next task at the moment the prior deadline lands (e.g. a "When deadline
   * reached" → "Set deadline" Flow chain), the prior run should land as
   * `'deadline_passed'` (→ met/missed) immediately rather than wait for the next plan
   * cycle's `finalizeStaleRecords` sweep — that wait would silently drop the entry if
   * PELS restarts in the interval, and in `power_source = flow` mode the next sweep can
   * be hours away.
   *
   * Records whose deadline is still in the future are left untouched (caller is expected
   * to gate on that, but the guard is here too as a safety net).
   */
  finalizeElapsedDeadline(deviceId: string, nowMs: number): void {
    for (const [key, record] of this.inProgress) {
      if (record.deviceId !== deviceId) continue;
      if (record.deadlineAtMs > nowMs) continue;
      this.pushEntry(finalizeRecord(record, nowMs, 'deadline_passed'));
      this.inProgress.delete(key);
    }
  }

  /**
   * Integrate trusted, source-timed device-meter readings for every open
   * Smart-task run. Retained snapshots repeat the same source timestamp and are
   * therefore a no-op. Direct watt readings close the prior sample's forward
   * interval; cumulative-meter averages book their own already-covered interval.
   */
  observeMeteredReading(reading: MeteredDeviceReading): void {
    const previous = this.lastMeteredDeliveryByDeviceId.get(reading.deviceId);
    if (previous !== undefined && readingEndMs(reading) <= readingEndMs(previous)) return;
    this.lastMeteredDeliveryByDeviceId.set(reading.deviceId, reading);
    const interval = resolveDeliveryInterval(reading, previous);
    if (interval === null) return;
    if (reading.kind === 'instantaneous'
      && interval.endMs - interval.startMs > MAX_METERED_DELIVERY_SAMPLE_GAP_MS) return;
    for (const [key, record] of this.inProgress) {
      if (record.deviceId !== reading.deviceId) continue;
      const startMs = Math.max(interval.startMs, record.startedAtMs);
      const endMs = Math.min(interval.endMs, record.deadlineAtMs);
      if (endMs <= startMs) continue;
      this.inProgress.set(key, this.integrateMeteredDelivery(record, startMs, endMs, interval.powerKw));
      this.dirty = true;
    }
  }

  private integrateMeteredDelivery(
    record: InProgressRecord,
    startMs: number,
    endMs: number,
    currentDrawKw: number,
  ): InProgressRecord {
    let cursorMs = startMs;
    let deliveredKWh = record.deliveredKWh;
    let totalCost = record.totalCost;
    let costDisplay = record.costDisplay;
    let hourlyContributions = record.hourlyContributions;
    let deliveryPriceComplete = record.deliveryPriceComplete;
    while (cursorMs < endMs) {
      const hourMs = hourBucketMs(cursorMs);
      const sliceEndMs = Math.min(endMs, hourMs + ONE_HOUR_MS);
      const sliceDeliveredKWh = currentDrawKw * ((sliceEndMs - cursorMs) / ONE_HOUR_MS);
      const price = this.deps.resolveHourPrice?.(hourMs) ?? null;
      if (price === null) {
        deliveredKWh += sliceDeliveredKWh;
        deliveryPriceComplete = deliveryPriceComplete && sliceDeliveredKWh === 0;
      } else {
        deliveredKWh += sliceDeliveredKWh;
        totalCost += sliceDeliveredKWh * price.priceValue;
        costDisplay ??= price.costDisplay;
        hourlyContributions = appendHourlyContribution(hourlyContributions, {
          atMs: hourMs,
          deliveredKWh: sliceDeliveredKWh,
          priceValue: price.priceValue,
          tone: price.tone,
        });
      }
      cursorMs = sliceEndMs;
    }
    return {
      ...record,
      hasDeliveryContribution: true,
      deliveredKWh,
      totalCost,
      costDisplay,
      hourlyContributions,
      deliveryPriceComplete,
    };
  }

  private finalizeStaleRecords(seenKeys: ReadonlySet<InProgressKey>, nowMs: number): void {
    for (const [key, record] of this.inProgress) {
      if (record.deadlineAtMs <= nowMs) {
        this.pushEntry(finalizeRecord(record, nowMs, 'deadline_passed'));
        this.inProgress.delete(key);
        continue;
      }
      if (seenKeys.has(key)) continue;
      // Diagnostic stopped appearing while deadline is still future. Wait for the grace
      // window before declaring the run abandoned, in case the device briefly drops out and
      // recovers.
      if (nowMs - lastObservedAtMs(record) >= ABANDON_GRACE_MS) {
        this.pushEntry(finalizeRecord(record, nowMs, 'abandoned'));
        this.inProgress.delete(key);
      }
    }
  }

  private pushEntry(entry: DeferredObjectivePlanHistoryEntry | DeferredObjectivePlanHistoryRecord): void {
    this.entries.push(toPlanHistoryRecord(entry));
    this.trimEntries();
    this.dirty = true;
    if ('objectiveKind' in entry) {
      this.emitFinalizedAttribution(entry);
      const endedEvent = buildEndedEventFromEntry(entry);
      if (endedEvent !== null) {
        this.deps.endedBus?.publish(endedEvent);
      }
    }
  }

  // Emit the per-run miss attribution as the entry finalizes. Backfill entries
  // are skipped: they carry no observed plan/delivery, so the attribution would
  // be `unknown` with null inputs — noise. Emitting on every outcome (not just
  // `missed`) is deliberate: the met/missed ratio against the same confidence /
  // floor inputs is what quantifies the false-alarm rate. The attribution reads
  // only the persisted entry, so this log and the history-detail "Why" line
  // resolve the same cause by construction.
  private emitFinalizedAttribution(entry: DeferredObjectivePlanHistoryEntry): void {
    if (entry.discoveredFrom !== 'observation') return;
    const event = buildFinalizedAttributionEvent(entry);
    if (this.deps.debugStructured) {
      this.deps.debugStructured(event);
    } else {
      logger.debug(event);
    }
  }

  private trimEntries(): void {
    this.entries.sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
    if (this.entries.length > HISTORY_ENTRY_CAP) {
      this.entries = this.entries.slice(this.entries.length - HISTORY_ENTRY_CAP);
    }
  }

  flushIfDirty(): boolean {
    this.recoverHistoryIfAvailable();
    if (!this.dirty || !this.persistenceSafe) return false;
    const persisted = this.deps.save({
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    }, this.buildMeteredDeliverySnapshot());
    if (!persisted) return false;
    this.dirty = false;
    return true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getHistorySnapshot(): DeferredObjectivePlanHistoryV5 {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    };
  }

  private recoverHistoryIfAvailable(): void {
    if (this.persistenceSafe) return;
    const recovered = this.deps.load();
    if (!recovered.persistenceSafe) return;
    this.entries = mergeRecoveredEntries(recovered.snapshot.entries, this.entries);
    for (const state of recovered.meteredDeliveryStates ?? []) {
      const key = buildKey(state.deviceId, state.deadlineAtMs);
      const active = this.inProgress.get(key);
      if (active === undefined) {
        this.restoredMeteredDeliveryByKey.set(key, state);
      } else {
        this.inProgress.set(key, mergeMeteredDelivery(active, state));
      }
    }
    this.trimEntries();
    this.persistenceSafe = true;
  }

  private buildMeteredDeliverySnapshot(): PersistedMeteredDeliveryState[] {
    const restored = [...this.restoredMeteredDeliveryByKey.values()];
    const active = [...this.inProgress.values()].flatMap((record) => (
      record.hasDeliveryContribution
        ? [{
          deviceId: record.deviceId,
          deadlineAtMs: record.deadlineAtMs,
          startedAtMs: record.startedAtMs,
          commitment: record.commitment.kind === 'learning'
            ? { kind: 'unknown' as const }
            : record.commitment,
          deliveredKWh: record.deliveredKWh,
          totalCost: record.totalCost,
          costDisplay: record.costDisplay,
          deliveryPriceComplete: record.deliveryPriceComplete,
          hourlyContributions: record.hourlyContributions.slice(),
        }]
        : []
    ));
    return [...restored, ...active];
  }

  // Test-only seam: clear in-progress state without touching persisted entries.
  resetInProgressForTests(): void {
    this.inProgress.clear();
    this.lastMeteredDeliveryByDeviceId.clear();
  }
}

const restoreMeteredDelivery = (
  record: InProgressRecord,
  state: PersistedMeteredDeliveryState,
): InProgressRecord => mergeMeteredDelivery(record, state);

const mergeMeteredDelivery = (
  record: InProgressRecord,
  state: PersistedMeteredDeliveryState,
): InProgressRecord => {
  let hourlyContributions = state.hourlyContributions.slice();
  for (const contribution of record.hourlyContributions) {
    hourlyContributions = appendHourlyContribution(hourlyContributions, contribution);
  }
  return {
    ...record,
    startedAtMs: Math.min(record.startedAtMs, state.startedAtMs),
    commitment: state.commitment,
    deliveredKWh: state.deliveredKWh + record.deliveredKWh,
    totalCost: state.totalCost + record.totalCost,
    costDisplay: state.costDisplay ?? record.costDisplay,
    hasDeliveryContribution: true,
    deliveryPriceComplete: state.deliveryPriceComplete && record.deliveryPriceComplete,
    hourlyContributions,
  };
};

const mergeRecoveredEntries = (
  durable: readonly DeferredObjectivePlanHistoryRecord[],
  local: readonly DeferredObjectivePlanHistoryRecord[],
): DeferredObjectivePlanHistoryRecord[] => {
  const merged = durable.slice();
  const durableIds = new Set(durable.map((entry) => entry.id));
  for (const entry of local) {
    if (durableIds.has(entry.id)) continue;
    const key = buildKey(entry.deviceId, entry.deadlineAtMs);
    const existingIndex = merged.findIndex(
      (candidate) => buildKey(candidate.deviceId, candidate.deadlineAtMs) === key,
    );
    const existing = existingIndex < 0 ? undefined : merged[existingIndex];
    if (existing === undefined) {
      merged.push(entry);
      continue;
    }
    if (existing.discoveredFrom === 'backfill' && entry.discoveredFrom === 'observation') {
      merged[existingIndex] = entry;
      continue;
    }
    if (entry.discoveredFrom === 'observation') merged.push(entry);
  }
  return merged;
};
