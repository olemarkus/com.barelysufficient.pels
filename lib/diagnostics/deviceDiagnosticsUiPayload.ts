import { getDateKeyInTimeZone } from '../../packages/shared-domain/src/utils/dateUtils';
import type {
  DeviceDiagnosticsStarvationSummary,
  DeviceDiagnosticsSummary,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type {
  SettingsUiPlanDeviceStarvation,
} from '../../packages/contracts/src/settingsUiApi';
import type {
  StarvationNotListedDevice,
  StarvationNotListedReason,
  StarvationTarget,
} from '../../packages/contracts/src/starvationRescue';
import type {
  HeldBackScope,
  LiveDeviceDiagnostics,
  LiveStarvationObservation,
} from './deviceDiagnosticsServiceTypes';
import { resolveStarvationEntryRemainingMs } from './deviceDiagnosticsEpisodes';
import { DEVICE_DIAGNOSTICS_WINDOW_DAYS, type DeviceDiagnosticsPersistence } from './deviceDiagnosticsPersistence';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';

const createEmptyStarvationSummary = (): DeviceDiagnosticsStarvationSummary => ({
  isStarved: false,
  starvedAccumulatedMs: 0,
  starvationEpisodeStartedAt: null,
  starvationLastResumedAt: null,
  intendedTarget: null,
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
    intendedTarget: observation?.intendedTarget ?? null,
    currentTemperatureC: observation?.currentTemperatureC ?? null,
    starvationCause: starvation.starvationCause,
    starvationPauseReason: starvation.starvationPauseReason,
  };
};

export const buildUiPayload = (
  liveByDeviceId: Record<string, LiveDeviceDiagnostics>,
  latestObservationBatchId: number,
  persistence: DeviceDiagnosticsPersistence,
  timeZone: string,
  nowTs: number,
): SettingsUiDeviceDiagnosticsPayload => {
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
  };
};

export type StarvedRescueEntry = {
  deviceId: string;
  starvation: SettingsUiPlanDeviceStarvation;
  intendedTarget: StarvationTarget | null;
};

// Currently-starved devices for the starvation-rescue widget. Mirrors
// `getOverviewStarvation` (only fresh, eligible, latched-starved devices) but
// enumerates the whole live set and also returns the device's intended normal
// target — the value a budget-rescue smart task must aim for so the device
// reaches its normal comfort/storage temperature or its target battery level. Name/kind are joined by the
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
        intendedTarget: live?.lastStarvationObservation?.intendedTarget ?? null,
      };
    })
    .filter((entry): entry is StarvedRescueEntry => entry !== null)
);

const resolveNotListedReason = (
  scope: Exclude<HeldBackScope, 'off_list'>,
  live: LiveDeviceDiagnostics,
  observation: LiveStarvationObservation,
  observedTs: number,
): StarvationNotListedReason => {
  if (scope !== 'candidate') return { kind: scope };
  if (!observation.pelsHoldsBelowTarget) return { kind: 'at_target' };
  return { kind: 'listed_soon', remainingMs: resolveStarvationEntryRemainingMs(live.starvation, observedTs) };
};

// Devices PELS limits for power in the latest plan sample that the held-back
// list does not show, each with why. A latched-starved device is on the list,
// so it is never repeated here; one in the clear window has left the list
// (`getStarvedRescueEntries`) and is no longer held below its target, so it
// reads as at its target here rather than vanishing from both.
export const getLimitedNotListedEntries = (
  liveByDeviceId: Record<string, LiveDeviceDiagnostics>,
  latestObservationBatchId: number,
): StarvationNotListedDevice[] => (
  Object.entries(liveByDeviceId).flatMap(([deviceId, live]): StarvationNotListedDevice[] => {
    const observation = live.lastStarvationObservation;
    if (live.lastObservationBatchId !== latestObservationBatchId || !observation) return [];
    const scope = observation.heldBackScope;
    const onList = live.starvation.isStarved && !isFiniteNumber(live.starvation.clearQualifiedStartedAt);
    if (scope === 'off_list' || onList || live.lastObservedTs === undefined) return [];
    return [{
      deviceId,
      deviceName: live.name,
      reason: resolveNotListedReason(scope, live, observation, live.lastObservedTs),
    }];
  })
);
