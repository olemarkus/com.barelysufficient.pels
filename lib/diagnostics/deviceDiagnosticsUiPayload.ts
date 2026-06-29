import { getDateKeyInTimeZone } from '../utils/dateUtils';
import type {
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationSummary,
  DeviceDiagnosticsSummary,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type {
  SettingsUiPlanDeviceStarvation,
  SettingsUiPlanStarvationCause,
} from '../../packages/contracts/src/settingsUiApi';
import type { LiveDeviceDiagnostics } from './deviceDiagnosticsServiceTypes';
import { DEVICE_DIAGNOSTICS_WINDOW_DAYS, type DeviceDiagnosticsPersistence } from './deviceDiagnosticsPersistence';
import { isFiniteNumber } from './deviceDiagnosticsNumbers';

const createEmptyStarvationSummary = (): DeviceDiagnosticsStarvationSummary => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationEpisodeStartedAt: null,
  starvationLastResumedAt: null,
  intendedNormalTargetC: null,
  currentTemperatureC: null,
  starvationCause: null,
  starvationPauseReason: null,
});

export const buildStarvationSummary = (
  live: LiveDeviceDiagnostics | undefined,
): DeviceDiagnosticsStarvationSummary => {
  if (!live) return createEmptyStarvationSummary();

  const { starvation } = live;
  const observation = live.lastStarvationObservation;

  return {
    isStarved: starvation.isStarved,
    starvedAccumulatedMs: starvation.starvedAccumulatedMs,
    starvationEpisodeStartedAt: starvation.isStarved
      ? starvation.starvationEpisodeStartedAt ?? null
      : null,
    starvationLastResumedAt: starvation.isStarved
      ? starvation.starvationLastResumedAt ?? null
      : null,
    intendedNormalTargetC: observation?.intendedNormalTargetC ?? null,
    currentTemperatureC: observation?.currentTemperatureC ?? null,
    starvationCause: starvation.starvationCause,
    starvationPauseReason: starvation.starvationPauseReason,
  };
};

const OVERVIEW_BUDGET_STARVATION_CAUSES = new Set<DeviceDiagnosticsStarvationCountingCause>([
  'daily_budget',
  'hourly_budget',
]);

// Every starvation episode now carries a real counting cause (capacity/budget):
// PELS only starves a device it is actively holding below its mode target, so a
// starved device always has a `countingCause` (retained across pauses). The
// overview surfaces exactly two buckets — budget (releasable) vs capacity
// (physical). There is no manual or external bucket: a below-target device PELS
// merely keeps is not starved. The null fallback is defensive only and maps to
// the physical-capacity bucket (the non-actionable default).
const resolveOverviewStarvationCause = (
  countingCause: DeviceDiagnosticsStarvationCountingCause | null,
): SettingsUiPlanStarvationCause => (
  countingCause !== null && OVERVIEW_BUDGET_STARVATION_CAUSES.has(countingCause) ? 'budget' : 'capacity'
);

export const buildUiPayload = (params: {
  liveByDeviceId: Record<string, LiveDeviceDiagnostics>;
  latestObservationBatchId: number;
  persistence: DeviceDiagnosticsPersistence;
  timeZone: string;
  nowTs: number;
}): SettingsUiDeviceDiagnosticsPayload => {
  const {
    liveByDeviceId, latestObservationBatchId, persistence, timeZone, nowTs,
  } = params;
  const currentDateKey = getDateKeyInTimeZone(new Date(nowTs), timeZone);
  const dateKeysByWindow = persistence.buildWindowDateKeys(currentDateKey);
  const deviceIds = new Set([
    ...persistence.getPersistedDeviceIds(),
    ...Object.keys(liveByDeviceId),
  ]);

  const diagnosticsByDeviceId: Record<string, DeviceDiagnosticsSummary> = Object.fromEntries(
    [...deviceIds].map((deviceId) => {
      const live = liveByDeviceId[deviceId];
      const freshLive = live?.lastObservationBatchId === latestObservationBatchId ? live : undefined;
      return [deviceId, {
        currentPenaltyLevel: live?.currentPenaltyLevel ?? 0,
        starvation: buildStarvationSummary(freshLive),
        windows: {
          '1d': persistence.buildWindowSummary(deviceId, dateKeysByWindow['1d']),
          '7d': persistence.buildWindowSummary(deviceId, dateKeysByWindow['7d']),
          '21d': persistence.buildWindowSummary(deviceId, dateKeysByWindow['21d']),
        },
      }];
    }),
  );

  return {
    generatedAt: nowTs,
    windowDays: DEVICE_DIAGNOSTICS_WINDOW_DAYS,
    diagnosticsByDeviceId,
  };
};

export const getCurrentStarvedDeviceCount = (
  liveByDeviceId: Record<string, LiveDeviceDiagnostics>,
  latestObservationBatchId: number,
): number => (
  Object.values(liveByDeviceId)
    .filter((live) => live.lastObservationBatchId === latestObservationBatchId)
    .filter((live) => live.starvation.isStarved)
    .length
);

export const getOverviewStarvation = (
  live: LiveDeviceDiagnostics | undefined,
  latestObservationBatchId: number,
): SettingsUiPlanDeviceStarvation | null => {
  if (!live?.lastStarvationObservation?.eligibleForStarvation) return null;
  if (live.lastObservationBatchId !== latestObservationBatchId) return null;
  if (!live.starvation.isStarved) return null;
  return {
    isStarved: true,
    accumulatedMs: live.starvation.starvedAccumulatedMs,
    cause: resolveOverviewStarvationCause(live.starvation.starvationCause),
    startedAtMs: live.starvation.starvationEpisodeStartedAt ?? null,
  };
};

export type StarvedRescueEntry = {
  deviceId: string;
  starvation: SettingsUiPlanDeviceStarvation;
  intendedNormalTargetC: number | null;
};

// Currently-starved devices for the starvation-rescue widget. Mirrors
// `getOverviewStarvation` (only fresh, eligible, latched-starved devices) but
// enumerates the whole live set and also returns the device's intended normal
// target — the value a budget-rescue smart task must aim for so the device
// reaches its normal comfort/storage target. Name/kind are joined by the
// caller against the device snapshot (see `App.getStarvedRescueDevices`).
//
// Excludes devices in the CLEAR-hysteresis window (`clearQualifiedStartedAt`
// set): once `clearQualified` fires, PELS has already commanded the device back
// to its full mode target and is no longer holding it below. `isStarved` stays
// latched through the 10-min window only so the overview BADGE keeps its
// attribution (see `applyStarvationClearProgress`) — but a rescue must not be
// offered for a device PELS is no longer holding below target, so the rescue
// list (the widget held-back rows + the overview "Let it run now" chip gate)
// drops it immediately. The badge path (`getOverviewStarvation`) is untouched.
export const getStarvedRescueEntries = (
  liveByDeviceId: Record<string, LiveDeviceDiagnostics>,
  latestObservationBatchId: number,
): StarvedRescueEntry[] => (
  Object.keys(liveByDeviceId)
    .map((deviceId): StarvedRescueEntry | null => {
      const live = liveByDeviceId[deviceId];
      const starvation = getOverviewStarvation(live, latestObservationBatchId);
      if (!starvation) return null;
      if (isFiniteNumber(live?.starvation.clearQualifiedStartedAt)) return null;
      return {
        deviceId,
        starvation,
        intendedNormalTargetC: live?.lastStarvationObservation?.intendedNormalTargetC ?? null,
      };
    })
    .filter((entry): entry is StarvedRescueEntry => entry !== null)
);
