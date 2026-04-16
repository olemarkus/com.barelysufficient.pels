import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
} from '../utils/dateUtils';
import { ACTIVATION_BACKOFF_MAX_LEVEL } from '../plan/planActivationBackoff';
import type {
  DeviceDiagnosticsWindowSummary,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';

export type PersistedDayAggregate = {
  unmetDemandMs: number;
  blockedByHeadroomMs: number;
  blockedByCooldownBackoffMs: number;
  targetDeficitMs: number;
  shedCount: number;
  restoreCount: number;
  failedActivationCount: number;
  stableActivationCount: number;
  shedToRestoreCount: number;
  shedToRestoreTotalMs: number;
  restoreToSetbackCount: number;
  restoreToSetbackTotalMs: number;
  restoreToSetbackMinMs: number | null;
  restoreToSetbackMaxMs: number | null;
  penaltyBumpCount: number;
  penaltyMaxLevelSeen: number;
};

export type PersistedDeviceDiagnostics = {
  daysByDateKey: Record<string, PersistedDayAggregate>;
};

export type PersistedDiagnosticsState = {
  version: number;
  windowDays: number;
  generatedAt: number | null;
  devicesById: Record<string, PersistedDeviceDiagnostics>;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const clampNonNegativeInt = (value: unknown): number => (
  isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0
);

const clampDurationMs = (value: unknown): number => (
  isFiniteNumber(value) ? Math.max(0, value) : 0
);

const clampPenaltyLevel = (value: unknown): number => {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(value)));
};

const sanitizeNullableDuration = (value: unknown): number | null => (
  isFiniteNumber(value) ? Math.max(0, value) : null
);

export const createEmptyDayAggregate = (): PersistedDayAggregate => ({
  unmetDemandMs: 0,
  blockedByHeadroomMs: 0,
  blockedByCooldownBackoffMs: 0,
  targetDeficitMs: 0,
  shedCount: 0,
  restoreCount: 0,
  failedActivationCount: 0,
  stableActivationCount: 0,
  shedToRestoreCount: 0,
  shedToRestoreTotalMs: 0,
  restoreToSetbackCount: 0,
  restoreToSetbackTotalMs: 0,
  restoreToSetbackMinMs: null,
  restoreToSetbackMaxMs: null,
  penaltyBumpCount: 0,
  penaltyMaxLevelSeen: 0,
});

export const createEmptyPersistedState = (params: {
  persistVersion: number;
  windowDays: number;
}): PersistedDiagnosticsState => ({
  version: params.persistVersion,
  windowDays: params.windowDays,
  generatedAt: null,
  devicesById: {},
});

const sanitizeDayAggregate = (raw: unknown): PersistedDayAggregate => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createEmptyDayAggregate();
  }
  const record = raw as Record<string, unknown>;
  return {
    unmetDemandMs: clampDurationMs(record.unmetDemandMs),
    blockedByHeadroomMs: clampDurationMs(record.blockedByHeadroomMs),
    blockedByCooldownBackoffMs: clampDurationMs(record.blockedByCooldownBackoffMs),
    targetDeficitMs: clampDurationMs(record.targetDeficitMs),
    shedCount: clampNonNegativeInt(record.shedCount),
    restoreCount: clampNonNegativeInt(record.restoreCount),
    failedActivationCount: clampNonNegativeInt(record.failedActivationCount),
    stableActivationCount: clampNonNegativeInt(record.stableActivationCount),
    shedToRestoreCount: clampNonNegativeInt(record.shedToRestoreCount),
    shedToRestoreTotalMs: clampDurationMs(record.shedToRestoreTotalMs),
    restoreToSetbackCount: clampNonNegativeInt(record.restoreToSetbackCount),
    restoreToSetbackTotalMs: clampDurationMs(record.restoreToSetbackTotalMs),
    restoreToSetbackMinMs: sanitizeNullableDuration(record.restoreToSetbackMinMs),
    restoreToSetbackMaxMs: sanitizeNullableDuration(record.restoreToSetbackMaxMs),
    penaltyBumpCount: clampNonNegativeInt(record.penaltyBumpCount),
    penaltyMaxLevelSeen: clampPenaltyLevel(record.penaltyMaxLevelSeen),
  };
};

const sanitizeDeviceState = (raw: unknown): {
  deviceState: PersistedDeviceDiagnostics | null;
  repaired: boolean;
} => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { deviceState: null, repaired: true };
  }
  const daysByDateKey = (raw as Record<string, unknown>).daysByDateKey;
  if (!daysByDateKey || typeof daysByDateKey !== 'object' || Array.isArray(daysByDateKey)) {
    return { deviceState: null, repaired: true };
  }

  let repaired = false;
  const sanitizedDays = Object.fromEntries(
    Object.entries(daysByDateKey)
      .filter(([dateKey]) => {
        const keep = /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
        repaired = repaired || !keep;
        return keep;
      })
      .map(([dateKey, aggregate]) => [dateKey, sanitizeDayAggregate(aggregate)]),
  );
  return {
    deviceState: { daysByDateKey: sanitizedDays },
    repaired,
  };
};

export const sanitizePersistedState = (params: {
  raw: unknown;
  persistVersion: number;
  windowDays: number;
}): {
  state: PersistedDiagnosticsState;
  repaired: boolean;
  resetReason?: string;
} => {
  const emptyState = createEmptyPersistedState(params);
  if (params.raw === null || params.raw === undefined) {
    return { state: emptyState, repaired: false };
  }
  if (typeof params.raw !== 'object' || Array.isArray(params.raw)) {
    return {
      state: emptyState,
      repaired: true,
      resetReason: 'invalid persisted payload',
    };
  }

  const record = params.raw as Record<string, unknown>;
  if (record.version !== params.persistVersion) {
    return {
      state: emptyState,
      repaired: true,
      resetReason: `version mismatch (${String(record.version)} -> ${params.persistVersion})`,
    };
  }

  const devicesById = record.devicesById;
  if (!devicesById || typeof devicesById !== 'object' || Array.isArray(devicesById)) {
    return {
      state: {
        ...emptyState,
        generatedAt: isFiniteNumber(record.generatedAt) ? record.generatedAt : null,
      },
      repaired: true,
      resetReason: 'invalid devicesById payload',
    };
  }

  let repaired = false;
  const sanitizedDevices = Object.fromEntries(
    Object.entries(devicesById)
      .flatMap(([deviceId, deviceValue]) => {
        const result = sanitizeDeviceState(deviceValue);
        repaired = repaired || result.repaired;
        return result.deviceState ? [[deviceId, result.deviceState]] : [];
      }),
  );

  return {
    state: {
      ...emptyState,
      generatedAt: isFiniteNumber(record.generatedAt) ? record.generatedAt : null,
      devicesById: sanitizedDevices,
    },
    repaired,
  };
};

export const countPersistedDevices = (state: PersistedDiagnosticsState): number => (
  Object.keys(state.devicesById).length
);

export const countPersistedDays = (state: PersistedDiagnosticsState): number => Object.values(state.devicesById)
  .reduce((sum, deviceState) => sum + Object.keys(deviceState.daysByDateKey).length, 0);

const averageOrNull = (total: number, count: number): number | null => (
  count > 0 ? total / count : null
);

const buildEmptyWindowSummary = (): DeviceDiagnosticsWindowSummary => ({
  unmetDemandMs: 0,
  blockedByHeadroomMs: 0,
  blockedByCooldownBackoffMs: 0,
  targetDeficitMs: 0,
  shedCount: 0,
  restoreCount: 0,
  failedActivationCount: 0,
  stableActivationCount: 0,
  penaltyBumpCount: 0,
  maxPenaltyLevelSeen: 0,
  avgShedToRestoreMs: null,
  avgRestoreToSetbackMs: null,
  minRestoreToSetbackMs: null,
  maxRestoreToSetbackMs: null,
});

/* eslint-disable functional/immutable-data --
 * Local summary aggregation uses mutable accumulators instead of rebuilding
 * the diagnostics window object for each day.
 */
export const buildWindowSummary = (
  deviceState: PersistedDeviceDiagnostics | undefined,
  dateKeys: string[],
): DeviceDiagnosticsWindowSummary => {
  const summary = buildEmptyWindowSummary();
  if (!deviceState) return summary;

  const cycleTotals = {
    shedToRestoreCount: 0,
    shedToRestoreTotalMs: 0,
    restoreToSetbackCount: 0,
    restoreToSetbackTotalMs: 0,
  };

  for (const dateKey of dateKeys) {
    const aggregate = deviceState.daysByDateKey[dateKey];
    if (!aggregate) continue;
    summary.unmetDemandMs += aggregate.unmetDemandMs;
    summary.blockedByHeadroomMs += aggregate.blockedByHeadroomMs;
    summary.blockedByCooldownBackoffMs += aggregate.blockedByCooldownBackoffMs;
    summary.targetDeficitMs += aggregate.targetDeficitMs;
    summary.shedCount += aggregate.shedCount;
    summary.restoreCount += aggregate.restoreCount;
    summary.failedActivationCount += aggregate.failedActivationCount;
    summary.stableActivationCount += aggregate.stableActivationCount;
    summary.penaltyBumpCount += aggregate.penaltyBumpCount;
    summary.maxPenaltyLevelSeen = Math.max(summary.maxPenaltyLevelSeen, aggregate.penaltyMaxLevelSeen);
    cycleTotals.shedToRestoreCount += aggregate.shedToRestoreCount;
    cycleTotals.shedToRestoreTotalMs += aggregate.shedToRestoreTotalMs;
    cycleTotals.restoreToSetbackCount += aggregate.restoreToSetbackCount;
    cycleTotals.restoreToSetbackTotalMs += aggregate.restoreToSetbackTotalMs;
    if (aggregate.restoreToSetbackMinMs !== null) {
      summary.minRestoreToSetbackMs = summary.minRestoreToSetbackMs === null
        ? aggregate.restoreToSetbackMinMs
        : Math.min(summary.minRestoreToSetbackMs, aggregate.restoreToSetbackMinMs);
    }
    if (aggregate.restoreToSetbackMaxMs !== null) {
      summary.maxRestoreToSetbackMs = summary.maxRestoreToSetbackMs === null
        ? aggregate.restoreToSetbackMaxMs
        : Math.max(summary.maxRestoreToSetbackMs, aggregate.restoreToSetbackMaxMs);
    }
  }

  summary.avgShedToRestoreMs = averageOrNull(cycleTotals.shedToRestoreTotalMs, cycleTotals.shedToRestoreCount);
  summary.avgRestoreToSetbackMs = averageOrNull(
    cycleTotals.restoreToSetbackTotalMs,
    cycleTotals.restoreToSetbackCount,
  );
  return summary;
};
/* eslint-enable functional/immutable-data */

export const getRecentDateKeys = (params: {
  currentDateKey: string;
  count: number;
  timeZone: string;
}): string[] => {
  const currentDayStartMs = getDateKeyStartMs(params.currentDateKey, params.timeZone);
  const keys: string[] = [];
  for (let offset = 0; offset < params.count; offset += 1) {
    const date = new Date(currentDayStartMs + (12 * 60 * 60 * 1000) - (offset * 24 * 60 * 60 * 1000));
    // eslint-disable-next-line functional/immutable-data -- Local key collection is a simple mutable accumulator.
    keys.push(getDateKeyInTimeZone(date, params.timeZone));
  }
  return keys;
};

export const formatDurationSeconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

export const formatDeviceRef = (deviceId: string, name: string): string => (
  `deviceId=${deviceId} name="${name}"`
);
