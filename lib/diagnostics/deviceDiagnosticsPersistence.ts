import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import type {
  DeviceDiagnosticsWindowKey,
  DeviceDiagnosticsWindowSummary,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import {
  buildWindowSummary as buildModelWindowSummary,
  countPersistedDays,
  countPersistedDevices,
  createEmptyDayAggregate,
  createEmptyPersistedState,
  getRecentDateKeys as getModelRecentDateKeys,
  type PersistedDayAggregate,
  type PersistedDiagnosticsState,
} from './deviceDiagnosticsModel';
import type { DeviceDiagnosticsServiceDeps, LiveDemandObservation } from './deviceDiagnosticsServiceTypes';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { clampPenaltyLevel } from './deviceDiagnosticsNumbers';

const moduleLogger = getLogger('diagnostics/device');
// Hoisted once so `emitDebug` allocates no per-call closure on the (test-only;
// production always wires `debugStructured`) fallback path.
const debugFallbackEmit: StructuredDebugEmitter = (payload) => moduleLogger.debug(payload);

export const DEVICE_DIAGNOSTICS_STATE_KEY = 'device_diagnostics_v1';
export const DEVICE_DIAGNOSTICS_WINDOW_DAYS = 21;
export const DEVICE_DIAGNOSTICS_PERSIST_VERSION = 2;

const DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS = 5 * 60 * 1000;

type DeviceDiagnosticsPersistenceDeps = Pick<
  DeviceDiagnosticsServiceDeps,
  'diagnosticsStateStore' | 'getTimeZone' | 'isDebugEnabled' | 'structuredLog' | 'debugStructured'
>;

// Owns the persisted per-device day aggregates plus the flush lifecycle
// (dirty-tracking, throttling, day rollover, pruning). Kept as a class so the
// in-place mutation of the persisted state tree reads naturally.
export class DeviceDiagnosticsPersistence {
  private persistedState: PersistedDiagnosticsState = createEmptyPersistedState({
    persistVersion: DEVICE_DIAGNOSTICS_PERSIST_VERSION,
    windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
  });
  private dirty = false;
  private dirtyDeviceIds = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastFlushMs = 0;
  private lastSkippedFlushLogMs = 0;
  private lastSeenDateKey: string | null = null;

  constructor(private deps: DeviceDiagnosticsPersistenceDeps) {
    this.loadFromSettings();
  }

  private emitDebug(payload: Record<string, unknown>): void {
    (this.deps.debugStructured ?? debugFallbackEmit)(payload);
  }

  private isDiagnosticsDebugEnabled(): boolean {
    return this.deps.isDebugEnabled?.() ?? true;
  }

  private loadFromSettings(): void {
    const sanitized = this.deps.diagnosticsStateStore.read();
    this.persistedState = sanitized.state;
    const prunedDayCount = this.pruneExpiredDays(Date.now());
    this.lastSeenDateKey = getDateKeyInTimeZone(new Date(), this.deps.getTimeZone());

    if (sanitized.resetReason) {
      this.emitDebug({ event: 'diagnostics_persisted_payload_reset', reason: sanitized.resetReason });
      this.dirty = true;
      this.flush('startup_repair', { force: true });
      return;
    }

    if (prunedDayCount > 0 || sanitized.repaired) {
      this.dirty = true;
      this.flush('startup_repair', { force: true });
    }

    this.emitDebug({
      event: 'diagnostics_persisted_payload_loaded',
      version: this.persistedState.version,
      devices: countPersistedDevices(this.persistedState),
      days: countPersistedDays(this.persistedState),
    });
    if (prunedDayCount > 0) {
      this.emitDebug({ event: 'diagnostics_pruned_expired_days', count: prunedDayCount });
    }
  }

  /**
   * Home-level censoring evidence for one local day: Σ targetDeficitMs +
   * Σ blockedByHeadroomMs across every device's persisted aggregate. Returns
   * undefined when the day carries NO censoring (no device recorded it, or
   * every device recorded zero deficit and zero headroom-block — the common
   * case, since an aggregate exists for any shed/activation). The weather
   * collector then leaves the day's suppression "unknown" rather than writing
   * a misleading all-zero object. Read-only, dateKey-scoped — diagnostics
   * stays planner-orthogonal.
   */
  getDaySuppressionTotals(dateKey: string): { targetDeficitMs: number; blockedByHeadroomMs: number } | undefined {
    let targetDeficitMs = 0;
    let blockedByHeadroomMs = 0;
    for (const deviceState of Object.values(this.persistedState.devicesById)) {
      const aggregate = deviceState.daysByDateKey[dateKey];
      if (!aggregate) continue;
      targetDeficitMs += aggregate.targetDeficitMs;
      blockedByHeadroomMs += aggregate.blockedByHeadroomMs;
    }
    return targetDeficitMs > 0 || blockedByHeadroomMs > 0 ? { targetDeficitMs, blockedByHeadroomMs } : undefined;
  }

  getPersistedDeviceIds(): string[] {
    return Object.keys(this.persistedState.devicesById);
  }

  buildWindowSummary(deviceId: string, dateKeys: string[]): DeviceDiagnosticsWindowSummary {
    return buildModelWindowSummary(this.persistedState.devicesById[deviceId], dateKeys);
  }

  recordDemandSpan(
    deviceId: string,
    startTs: number,
    endTs: number,
    observation: LiveDemandObservation,
  ): void {
    if (!observation.includeDemandMetrics || !observation.unmetDemand || endTs <= startTs) return;
    this.addDurationByDay(deviceId, startTs, endTs, 'unmetDemandMs');
    if (observation.targetDeficitActive) {
      this.addDurationByDay(deviceId, startTs, endTs, 'targetDeficitMs');
    }
    if (observation.blockCause === 'headroom') {
      this.addDurationByDay(deviceId, startTs, endTs, 'blockedByHeadroomMs');
    } else if (observation.blockCause === 'cooldown_backoff') {
      this.addDurationByDay(deviceId, startTs, endTs, 'blockedByCooldownBackoffMs');
    }
  }

  private addDurationByDay(
    deviceId: string,
    startTs: number,
    endTs: number,
    key: keyof Pick<
      PersistedDayAggregate,
      'unmetDemandMs' | 'blockedByHeadroomMs' | 'blockedByCooldownBackoffMs' | 'targetDeficitMs'
    >,
  ): void {
    if (endTs <= startTs) return;
    let cursorTs = startTs;
    const timeZone = this.deps.getTimeZone();
    while (cursorTs < endTs) {
      const dateKey = getDateKeyInTimeZone(new Date(cursorTs), timeZone);
      const dayStartTs = getDateKeyStartMs(dateKey, timeZone);
      const nextDayStartTs = getNextLocalDayStartUtcMs(dayStartTs, timeZone);
      const sliceEndTs = Math.min(endTs, nextDayStartTs);
      const aggregate = this.getDayAggregate(deviceId, dateKey);
      aggregate[key] += Math.max(0, sliceEndTs - cursorTs);
      cursorTs = sliceEndTs;
      this.markDirty(deviceId);
    }
  }

  addCount(
    deviceId: string,
    nowTs: number,
    key: keyof Pick<
      PersistedDayAggregate,
      'shedCount' | 'restoreCount' | 'failedActivationCount' | 'stableActivationCount' | 'penaltyBumpCount'
    >,
    delta: number,
  ): void {
    if (delta <= 0) return;
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate[key] += delta;
    this.markDirty(deviceId);
  }

  addShedToRestore(deviceId: string, nowTs: number, durationMs: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.shedToRestoreCount += 1;
    aggregate.shedToRestoreTotalMs += Math.max(0, durationMs);
    this.markDirty(deviceId);
  }

  addRestoreToSetback(deviceId: string, nowTs: number, durationMs: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.restoreToSetbackCount += 1;
    aggregate.restoreToSetbackTotalMs += Math.max(0, durationMs);
    aggregate.restoreToSetbackMinMs = aggregate.restoreToSetbackMinMs === null
      ? Math.max(0, durationMs)
      : Math.min(aggregate.restoreToSetbackMinMs, Math.max(0, durationMs));
    aggregate.restoreToSetbackMaxMs = aggregate.restoreToSetbackMaxMs === null
      ? Math.max(0, durationMs)
      : Math.max(aggregate.restoreToSetbackMaxMs, Math.max(0, durationMs));
    this.markDirty(deviceId);
  }

  updatePenaltyMaxSeen(deviceId: string, nowTs: number, penaltyLevel: number): void {
    const aggregate = this.getDayAggregateForTs(deviceId, nowTs);
    aggregate.penaltyMaxLevelSeen = Math.max(aggregate.penaltyMaxLevelSeen, clampPenaltyLevel(penaltyLevel));
    this.markDirty(deviceId);
  }

  private getDayAggregateForTs(deviceId: string, nowTs: number): PersistedDayAggregate {
    const dateKey = getDateKeyInTimeZone(new Date(nowTs), this.deps.getTimeZone());
    return this.getDayAggregate(deviceId, dateKey);
  }

  private getDayAggregate(deviceId: string, dateKey: string): PersistedDayAggregate {
    let deviceState = this.persistedState.devicesById[deviceId];
    if (!deviceState) {
      deviceState = { daysByDateKey: {} };
      this.persistedState.devicesById[deviceId] = deviceState;
    }
    let aggregate = deviceState.daysByDateKey[dateKey];
    if (!aggregate) {
      aggregate = createEmptyDayAggregate();
      deviceState.daysByDateKey[dateKey] = aggregate;
      this.markDirty(deviceId);
    }
    return aggregate;
  }

  buildWindowDateKeys(currentDateKey: string): Record<DeviceDiagnosticsWindowKey, string[]> {
    return {
      '1d': this.getRecentDateKeys(currentDateKey, 1),
      '7d': this.getRecentDateKeys(currentDateKey, 7),
      '21d': this.getRecentDateKeys(currentDateKey, 21),
    };
  }

  private getRecentDateKeys(currentDateKey: string, count: number): string[] {
    return getModelRecentDateKeys({
      currentDateKey,
      count,
      timeZone: this.deps.getTimeZone(),
    });
  }

  private pruneExpiredDays(nowTs: number): number {
    const timeZone = this.deps.getTimeZone();
    const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), timeZone);
    const allowedKeys = new Set(this.getRecentDateKeys(currentDateKey, DEVICE_DIAGNOSTICS_WINDOW_DAYS));
    let removed = 0;
    for (const [deviceId, deviceState] of Object.entries(this.persistedState.devicesById)) {
      let removedForDevice = false;
      for (const dateKey of Object.keys(deviceState.daysByDateKey)) {
        if (allowedKeys.has(dateKey)) continue;
        delete deviceState.daysByDateKey[dateKey];
        removed += 1;
        removedForDevice = true;
      }
      if (Object.keys(deviceState.daysByDateKey).length === 0) {
        delete this.persistedState.devicesById[deviceId];
        removedForDevice = true;
      }
      if (removedForDevice) {
        this.markDirty(deviceId);
      }
    }
    return removed;
  }

  ensureDayRollover(nowTs: number): void {
    const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), this.deps.getTimeZone());
    if (this.lastSeenDateKey === null) {
      this.lastSeenDateKey = currentDateKey;
      return;
    }
    if (this.lastSeenDateKey === currentDateKey) return;
    this.flush('day_rollover', { force: true });
    const pruned = this.pruneExpiredDays(nowTs);
    if (pruned > 0) {
      this.emitDebug({ event: 'diagnostics_pruned_expired_days', count: pruned });
    }
    this.lastSeenDateKey = currentDateKey;
  }

  scheduleFlush(nowTs: number): void {
    if (!this.dirty) {
      this.logSkippedFlush(nowTs, 'no changes');
      return;
    }
    if (this.flushTimer) return;
    const waitMs = this.lastFlushMs === 0
      ? 0
      : Math.max(0, DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS - (nowTs - this.lastFlushMs));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush('throttle');
    }, waitMs);
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null && 'unref' in this.flushTimer
      && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  private logSkippedFlush(nowTs: number, detail: string): void {
    if (nowTs - this.lastSkippedFlushLogMs < DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS) return;
    this.lastSkippedFlushLogMs = nowTs;
    this.emitDebug({ event: 'diagnostics_flush_skipped', detail });
  }

  private flush(reason: 'startup_repair' | 'throttle' | 'day_rollover' | 'shutdown', options: {
    force?: boolean;
  } = {}): void {
    const nowTs = Date.now();
    if (!this.dirty) {
      this.logSkippedFlush(nowTs, `nothing dirty (${reason})`);
      return;
    }
    if (!options.force && this.lastFlushMs > 0 && (nowTs - this.lastFlushMs) < DEVICE_DIAGNOSTICS_FLUSH_THROTTLE_MS) {
      this.scheduleFlush(nowTs);
      return;
    }

    this.persistedState.generatedAt = nowTs;
    try {
      this.deps.diagnosticsStateStore.write(this.persistedState);
      this.lastFlushMs = nowTs;
      this.dirty = false;
      const dirtyDeviceCount = this.dirtyDeviceIds.size;
      const dayCount = countPersistedDays(this.persistedState);
      const bytes = this.isDiagnosticsDebugEnabled()
        ? Buffer.byteLength(JSON.stringify(this.persistedState), 'utf8')
        : undefined;
      this.dirtyDeviceIds.clear();
      this.emitDebug({
        event: 'diagnostics_flushed',
        reason,
        dirtyDevices: dirtyDeviceCount,
        days: dayCount,
        ...(bytes === undefined ? {} : { bytes }),
      });
    } catch (error) {
      (this.deps.structuredLog ?? moduleLogger).error({
        event: 'diagnostics_persist_failed',
        reason,
        err: normalizeError(error),
      });
    }
  }

  private markDirty(deviceId: string): void {
    this.dirty = true;
    if (deviceId) {
      this.dirtyDeviceIds.add(deviceId);
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush('shutdown', { force: true });
  }
}
