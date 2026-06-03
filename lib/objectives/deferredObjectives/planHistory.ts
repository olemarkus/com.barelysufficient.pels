import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryV4,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION } from './planHistorySettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { IdleClassification } from '../../../packages/shared-domain/src/idleClassificationCopy';
import { buildEndedEventFromEntry, type DeferredObjectiveEndedBus } from './endedEventBus';
import {
  appendHourlyContribution,
  buildFinalHourFlush,
  buildFinalizedAttributionEvent,
  detectHourRollover,
  drainProgressSamples,
  hasTrustworthyProgress,
  hourBucketMs,
  type HourPriceResolver,
  type HourProgressSnapshot,
  pickKwhPerUnit,
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

const logger = getLogger('plan/deferred-history');
// Cap the rolling buffer. One deferred objective produces at most one entry per deadline run
// (per-day for HH:mm objectives), so 30 entries covers ~one month of history per device for a
// single-device household and shorter spans for multi-device homes. Bounded JSON size keeps
// startup reads cheap on Homey Pro.
const HISTORY_ENTRY_CAP = 30;

// If a previously-tracked diagnostic stops appearing for this long while its deadline is still
// in the future, treat the run as abandoned (settings disabled, device removed, evaluator
// dropped to unknown for an extended stretch).
const ABANDON_GRACE_MS = 60 * 60 * 1000;

// Reads through the observer-layer idle classifier
// (`lib/observer/idleClassifier.ts`). `near_target_idle` and `capped_idle`
// both promote the run to satisfied (the run reflects "the device went as
// far as it was going to go" — same outcome, two underlying causes which
// the recorder distinguishes via `metReason`). `unresponsive` is a
// hardware-fault signal and is deliberately ignored — we don't want to
// silently call a tripped breaker "succeeded".
export type DeferredObjectiveStallClassificationReader = (
  deviceId: string,
) => IdleClassification | undefined;

export type DeferredObjectiveBackfillConfig = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  deadlineAtMs: number;
  targetTemperatureC: number | null;
  targetPercent: number | null;
};

const synthesizeBackfillEntry = (
  config: DeferredObjectiveBackfillConfig,
): DeferredObjectivePlanHistoryEntry => ({
  id: randomUUID(),
  deviceId: config.deviceId,
  deviceName: config.deviceName,
  objectiveKind: config.objectiveKind,
  targetTemperatureC: config.targetTemperatureC,
  targetPercent: config.targetPercent,
  deadlineAtMs: config.deadlineAtMs,
  startedAtMs: config.deadlineAtMs,
  finalizedAtMs: config.deadlineAtMs,
  startProgressC: null,
  startProgressPercent: null,
  finalProgressC: null,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 0,
  outcome: 'unknown',
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
  // accepts the v4 envelope it was bumped to in v2.7.2.
  load: () => DeferredObjectivePlanHistoryV4 | null;
  // Persist the snapshot. Return `true` on success, `false` on failure (e.g. the underlying
  // settings.set threw and the host swallowed it). A `false` return keeps the recorder dirty
  // so a later flush retries, and lets callers gate side-effects (like advancing the
  // observation watermark) on real persistence success.
  save: (history: DeferredObjectivePlanHistoryV4) => boolean;
  // Optional bus the recorder publishes ended events to as runs finalize. The
  // recorder filters by `discoveredFrom === 'observation'` and public outcome
  // (`met`/`missed`/`abandoned`) before publishing — backfill entries and
  // `replaced`/`unknown` outcomes never reach the bus.
  endedBus?: DeferredObjectiveEndedBus;
  // Resolve the spot price and price tone (cheap/normal/expensive) for an
  // hour-aligned timestamp. The internal hour-rollover detector calls this
  // when it closes an hour so per-hour `hourlyContributions` carry a stable
  // band even if cheap/normal/expensive thresholds shift in a later
  // version. Returning `null` (no price data yet, hour outside the
  // published horizon) causes that hour's contribution to be skipped
  // rather than fabricated. The dep is optional so the recorder remains
  // useful in tests and for callers that drive `recordHourlyDelivery`
  // directly with their own pricing.
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
  // Optional side-effect callback invoked when a temperature objective finalises
  // as `met` with `metReason: 'stalled'` — the exact shape that carries a clean
  // observation of the device's local control deadband. The wiring layer reads
  // the current learned deadband, computes the observed gap, EMA-updates, and
  // persists. Kept off the recorder so this module stays free of settings I/O
  // and the test fixtures keep their headless shape. See
  // `lib/utils/learnedThermostatDeadbandStore.ts` for the consumer.
  onMetStalledEntry?: (entry: DeferredObjectivePlanHistoryEntry) => void;
};

// Per-hour delivery contribution fed into the recorder by the runtime
// power-tracker / pricing wiring. Both fields are absolute values for the
// hour: `deliveredKWh` is the device's measured useful kWh during that
// hour, `priceValue` is the hourly spot price in the user's display unit.
// The recorder sums `priceValue × deliveredKWh` into `totalCost` on the
// matching in-progress record. Wiring lives in `setup/appInit.ts`.
export type DeferredObjectivePlanHistoryHourlyDelivery = {
  deviceId: string;
  deadlineAtMs: number;
  // Hour-aligned start; redundantly carried so the recorder can ignore
  // contributions whose hour falls outside the run's observed window if a
  // late-arriving feed reports against a deadline that has already
  // finalized. Currently informational — duplicate contributions for the
  // same hour are added (the wiring is responsible for de-duping if needed).
  hourStartMs: number;
  deliveredKWh: number;
  priceValue: number;
  // Price-tier classification for the hour, resolved by the caller (the
  // runtime wiring) against the live cheap/normal/expensive thresholds.
  // Captured at contribution time so the postmortem reads a stable band
  // even if thresholds shift in a later version. See
  // `DeferredObjectivePlanHistoryHourlyTone`.
  tone: DeferredObjectivePlanHistoryHourlyTone;
};

export class DeferredObjectivePlanHistoryRecorder {
  private inProgress = new Map<InProgressKey, InProgressRecord>();

  private entries: DeferredObjectivePlanHistoryEntry[];

  private dirty = false;

  constructor(private readonly deps: PlanHistoryPersistDeps) {
    const loaded = deps.load();
    this.entries = loaded?.entries.slice() ?? [];
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
    const classification = getStallClassification?.(diag.deviceId);
    const reason = stallClassificationToMetReason(classification);
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
      const withRollover = this.applyHourlyDeliveryRollover(merged, diag, nowMs);
      this.inProgress.set(
        key,
        this.maybePromoteOnStall(withRollover, diag, nowMs, getStallClassification),
      );
      return;
    }
    // Begin tracking on first sight of a future-dated deadline, regardless of status. The
    // deadline event is the recorded thing; observation quality is captured separately via
    // observedIntervals + progress nullability. The stale-deadline guard still applies so a
    // diagnostic whose deadline has already passed doesn't create a junk record finalized on
    // the same cycle.
    if (diag.deadlineAtMs! <= nowMs) return;
    const next = startRecord(diag, nowMs, plan);
    if (!next) return;
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
      const flushed = this.flushOpenHourAtFinalize(record);
      this.pushEntry(finalizeRecord(flushed, nowMs, reason), flushed.energyExpectedKWhAtFinalize);
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
      const flushed = this.flushOpenHourAtFinalize(record);
      this.pushEntry(
        finalizeRecord(flushed, nowMs, 'deadline_passed'),
        flushed.energyExpectedKWhAtFinalize,
      );
      this.inProgress.delete(key);
    }
  }

  /**
   * Sum a per-hour delivery contribution onto the in-progress run that
   * matches `(deviceId, deadlineAtMs)`. The matching record's running
   * `deliveredKWh` and `totalCost = Σ priceValue × deliveredKWh` totals are
   * persisted at finalization. No-op when no matching in-progress run
   * exists (late contribution after the deadline finalized, or contribution
   * for a deadline this recorder never tracked).
   *
   * Designed as a one-shot push rather than per-cycle bookkeeping so the
   * caller can drive it from either the power-tracker hourly rollover or
   * from a plan-cycle aggregator without the recorder needing to know
   * either data source's cadence. Negative `deliveredKWh` values are
   * dropped (defensive: only consumption is interesting; production / sign
   * inversions would corrupt the running total).
   */
  recordHourlyDelivery(contribution: DeferredObjectivePlanHistoryHourlyDelivery): void {
    if (!Number.isFinite(contribution.deliveredKWh) || contribution.deliveredKWh < 0) return;
    if (!Number.isFinite(contribution.priceValue)) return;
    const key = buildKey(contribution.deviceId, contribution.deadlineAtMs);
    const record = this.inProgress.get(key);
    if (!record) return;
    // Hour-align the timestamp the postmortem renders against so duplicate
    // contributions for the same hour land on the same bucket (the strip
    // sums kWh into the existing entry and keeps the latest tone/price).
    // Floor against the contribution's `hourStartMs` rather than `nowMs`
    // because the caller may replay a missed hour from an aggregator
    // cadence that doesn't match real time.
    const hourAtMs = hourBucketMs(contribution.hourStartMs);
    const hourlyContributions = appendHourlyContribution(record.hourlyContributions, {
      atMs: hourAtMs,
      deliveredKWh: contribution.deliveredKWh,
      priceValue: contribution.priceValue,
      tone: contribution.tone,
    });
    this.inProgress.set(key, {
      ...record,
      deliveredKWh: record.deliveredKWh + contribution.deliveredKWh,
      totalCost: record.totalCost + contribution.priceValue * contribution.deliveredKWh,
      hasDeliveryContribution: true,
      hourlyContributions,
    });
  }

  // Drive the internal hour-rollover detector after a cycle's progress
  // sample has been recorded. Each closed-hour contribution is folded into
  // the record exactly the same way `recordHourlyDelivery` does — sharing
  // the merge helper guarantees the postmortem totals stay consistent
  // whether the contribution arrived from this runtime wiring or from an
  // external aggregator. The `currentHourOpening` anchor and cached
  // `lastKWhPerUnit` are always refreshed so the next cycle's rollover sees
  // the freshest values, even on cycles that produced no contribution.
  private applyHourlyDeliveryRollover(
    record: InProgressRecord,
    diag: DeferredObjectiveDiagnostic,
    nowMs: number,
  ): InProgressRecord {
    if (!hasTrustworthyProgress(diag)) return record;
    const nowProgress = diag.objectiveKind === 'temperature'
      ? diag.currentTemperatureC
      : diag.currentPercent;
    if (nowProgress === null) return record;
    const kWhPerUnit = pickKwhPerUnit(diag);
    // Anchor an opening on the first trustworthy reading even when
    // kWh/unit isn't resolved yet — once a profile lands later in the run
    // we can still attribute the closing hour using the freshly-resolved
    // factor. Skip emission for the prior hour if kWh/unit was missing
    // when it closed.
    if (record.currentHourOpening === null) {
      return {
        ...record,
        currentHourOpening: { hourMs: hourBucketMs(nowMs), value: nowProgress },
        lastKWhPerUnit: kWhPerUnit ?? record.lastKWhPerUnit,
      };
    }
    if (kWhPerUnit === null) {
      // No factor yet — keep the existing opening so the eventual
      // resolution can still attribute against it, but skip emission.
      return { ...record, lastKWhPerUnit: kWhPerUnit ?? record.lastKWhPerUnit };
    }
    const rollover = detectHourRollover({
      opening: record.currentHourOpening,
      nowProgress,
      nowMs,
      kWhPerUnit,
      resolvePrice: this.deps.resolveHourPrice,
    });
    if (rollover === null) {
      // No transition — only refresh the cached kWh/unit so finalize-time
      // flush uses the latest factor.
      return { ...record, lastKWhPerUnit: kWhPerUnit };
    }
    return this.foldContributionsIntoRecord({
      record,
      contributions: rollover.contributions,
      nextOpening: rollover.nextOpening,
      kWhPerUnit,
    });
  }

  // Pure merge of zero-or-more emitted contributions into an in-progress
  // record. Mirrors the totals math in `recordHourlyDelivery` so external
  // aggregator pushes and the internal rollover path agree byte-for-byte
  // on the persisted entry. Always advances `currentHourOpening` and
  // `lastKWhPerUnit` so finalize-time flushing has the right anchor even
  // when no contribution fired this cycle.
  private foldContributionsIntoRecord(params: {
    record: InProgressRecord;
    contributions: readonly DeferredObjectivePlanHistoryHourlyContribution[];
    nextOpening: HourProgressSnapshot;
    kWhPerUnit: number;
  }): InProgressRecord {
    const { record, contributions, nextOpening, kWhPerUnit } = params;
    if (contributions.length === 0) {
      return { ...record, currentHourOpening: nextOpening, lastKWhPerUnit: kWhPerUnit };
    }
    let { hourlyContributions, deliveredKWh, totalCost } = record;
    for (const contribution of contributions) {
      hourlyContributions = appendHourlyContribution(hourlyContributions, contribution);
      deliveredKWh += contribution.deliveredKWh;
      totalCost += contribution.deliveredKWh * contribution.priceValue;
    }
    return {
      ...record,
      hourlyContributions,
      deliveredKWh,
      totalCost,
      hasDeliveryContribution: true,
      currentHourOpening: nextOpening,
      lastKWhPerUnit: kWhPerUnit,
    };
  }

  // Flush a final contribution for the still-open hour when the run
  // finalizes. Without this, a sub-hour run (short EV top-up, brief
  // thermal nudge) that never crossed an hour boundary would record
  // `hasDeliveryContribution: false` and drop its delivery entirely. The
  // helper returns the record updated with the flushed contribution (or
  // the original record if no flush was possible — no opening anchor, no
  // measurable delta, no kWh/unit, or no price resolver).
  private flushOpenHourAtFinalize(record: InProgressRecord): InProgressRecord {
    const finalProgress = record.objectiveKind === 'temperature'
      ? record.finalProgressC
      : record.finalProgressPercent;
    // Option (a): advance the opening anchor to the *next* hour bucket so a
    // (defensive) re-entry on the returned record cannot collide with the
    // just-flushed hour. Finalization deletes the record immediately today, so
    // this is belt-and-braces — but the previous shape (re-using the
    // just-closed `hourMs`) was a latent double-count waiting for a refactor.
    // See `buildFinalHourFlush` for the next-bucket math.
    const flush = buildFinalHourFlush({
      opening: record.currentHourOpening,
      finalProgress,
      kWhPerUnit: record.lastKWhPerUnit,
      resolvePrice: this.deps.resolveHourPrice,
    });
    if (flush === null) return record;
    return this.foldContributionsIntoRecord({
      record,
      contributions: [flush.contribution],
      nextOpening: flush.nextOpening,
      kWhPerUnit: record.lastKWhPerUnit!,
    });
  }

  private finalizeStaleRecords(seenKeys: ReadonlySet<InProgressKey>, nowMs: number): void {
    for (const [key, record] of this.inProgress) {
      if (record.deadlineAtMs <= nowMs) {
        const flushed = this.flushOpenHourAtFinalize(record);
        this.pushEntry(finalizeRecord(flushed, nowMs, 'deadline_passed'), flushed.energyExpectedKWhAtFinalize);
        this.inProgress.delete(key);
        continue;
      }
      if (seenKeys.has(key)) continue;
      // Diagnostic stopped appearing while deadline is still future. Wait for the grace
      // window before declaring the run abandoned, in case the device briefly drops out and
      // recovers.
      if (nowMs - lastObservedAtMs(record) >= ABANDON_GRACE_MS) {
        const flushed = this.flushOpenHourAtFinalize(record);
        this.pushEntry(finalizeRecord(flushed, nowMs, 'abandoned'), flushed.energyExpectedKWhAtFinalize);
        this.inProgress.delete(key);
      }
    }
  }

  // `energyExpectedKWh` is the mean-based plan total threaded from the in-progress
  // record at finalize. Optional: backfill entries (synthesized from settings
  // without a live plan) and call sites without an in-progress record pass
  // `null`; the attribution falls back to the buffered `plannedKWh` comparison.
  private pushEntry(entry: DeferredObjectivePlanHistoryEntry, energyExpectedKWh: number | null = null): void {
    this.entries.push(entry);
    this.trimEntries();
    this.dirty = true;
    this.emitFinalizedAttribution(entry, energyExpectedKWh);
    const endedEvent = buildEndedEventFromEntry(entry);
    if (endedEvent !== null) {
      this.deps.endedBus?.publish(endedEvent);
    }
    // Deadband learning hook: only fires for clean met/stalled temperature
    // entries — the device's local controller satisfied near setpoint, which
    // is the only shape that carries a meaningful deadband observation.
    // `missed` is excluded because the device didn't reach satisfaction at
    // all; `stalled_device_capped` is excluded because the device parked at
    // its own internal cap, not at the user-target deadband.
    if (entry.discoveredFrom === 'observation'
        && entry.outcome === 'met'
        && entry.metReason === 'stalled'
        && entry.objectiveKind === 'temperature') {
      this.deps.onMetStalledEntry?.(entry);
    }
  }

  // Emit the per-run miss attribution as the entry finalizes. Backfill entries
  // are skipped: they carry no observed plan/delivery, so the attribution would
  // be `unknown` with null inputs — noise. Emitting on every outcome (not just
  // `missed`) is deliberate: the met/missed ratio against the same confidence /
  // floor inputs is what quantifies the false-alarm rate. `energyExpectedKWh`
  // is the mean-based plan total threaded from the live revision so cold-start
  // buffer-inflated runs aren't mislabelled `capacity_shortfall`; see
  // `InProgressRecord.energyExpectedKWhAtFinalize`.
  private emitFinalizedAttribution(entry: DeferredObjectivePlanHistoryEntry, energyExpectedKWh: number | null): void {
    if (entry.discoveredFrom !== 'observation') return;
    const event = buildFinalizedAttributionEvent(entry, energyExpectedKWh);
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
    if (!this.dirty) return false;
    const persisted = this.deps.save({
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    });
    if (!persisted) return false;
    this.dirty = false;
    return true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getHistorySnapshot(): DeferredObjectivePlanHistoryV4 {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    };
  }

  // Test-only seam: clear in-progress state without touching persisted entries.
  resetInProgressForTests(): void {
    this.inProgress.clear();
  }
}
