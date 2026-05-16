import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import type {
  SettingsUiPlanDevice,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../utils/types';
import { getHourBucketKey } from '../utils/dateUtils';

// Sentinel prefix the settings UI matches to detect the PELS boot/restart
// window and keep the panel in a bounded loading/retry state instead of
// surfacing a hard error. Duplicated here because the runtime cannot
// value-import deploy-excluded contract source files; the canonical
// declaration lives at `packages/contracts/src/settingsUiApi.ts`
// (`SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX`). Keep both copies in sync.
const APP_NOT_READY_ERROR_PREFIX = 'PELS_APP_NOT_READY:';

const appNotReadyError = (capability: string): Error => (
  new Error(`${APP_NOT_READY_ERROR_PREFIX} ${capability} unavailable while PELS is starting`)
);

type SettingsUiRuntimeApp = Homey.App & {
  latestTargetSnapshot?: TargetDeviceSnapshot[];
  getUiPickerDevices?: () => TargetDeviceSnapshot[];
  powerTracker?: PowerTrackerState;
  getLatestPlanSnapshotForUi?: () => SettingsUiPlanSnapshot | null;
  priceCoordinator?: {
    refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
    refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  };
  refreshTargetDevicesSnapshot?: (
    options?: { fast?: boolean; targeted?: boolean; recordHomeyEnergySample?: boolean },
  ) => Promise<void>;
  replacePowerTrackerForUi?: (nextState: PowerTrackerState) => void;
};
type PelsStatus = {
  headroomKw?: number;
  lastPowerUpdate?: number | null;
  priceLevel?: string | null;
  powerKnown?: boolean;
  hasLivePowerSample?: boolean;
  powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
};

const resolveRealtimePowerStatus = (
  status: PelsStatus | null,
  powerTracker: PowerTrackerState,
): PelsStatus | null => {
  const lastTimestamp = powerTracker.lastTimestamp;
  if (typeof lastTimestamp !== 'number' || !Number.isFinite(lastTimestamp)) {
    return status && typeof status === 'object' ? status : null;
  }
  return {
    ...(status && typeof status === 'object' ? status : {}),
    lastPowerUpdate: lastTimestamp,
  };
};

const getRuntimeApp = (homey: Homey.App['homey']): SettingsUiRuntimeApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiRuntimeApp;
};

export const getLatestDevicesForUiFromApp = (homey: Homey.App['homey']): TargetDeviceSnapshot[] | null => {
  const app = getRuntimeApp(homey);
  const snapshot = app?.latestTargetSnapshot;
  return Array.isArray(snapshot) ? snapshot : null;
};

export const getUiPickerDevicesFromApp = (homey: Homey.App['homey']): TargetDeviceSnapshot[] => {
  const app = getRuntimeApp(homey);
  const picker = app?.getUiPickerDevices?.();
  return Array.isArray(picker) ? picker : [];
};

export const getPlanSnapshotForUiFromHomey = (homey: Homey.App['homey']): SettingsUiPlanSnapshot | null => {
  const app = getRuntimeApp(homey);
  const appPlan = app?.getLatestPlanSnapshotForUi?.();
  if (isValidPlanSnapshot(appPlan)) return appPlan;
  if (appPlan !== null && appPlan !== undefined) {
    app?.error?.(
      'Ignoring invalid settings UI app plan snapshot: finalized devices must include structured reason',
    );
  }
  return null;
};

const hasStructuredReason = (value: unknown): boolean => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { code?: unknown }).code === 'string'
);

const isValidPlanDevice = (value: unknown): value is SettingsUiPlanDevice => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { name?: unknown }).name === 'string'
  && hasStructuredReason((value as { reason?: unknown }).reason)
);

const isValidPlanSnapshot = (value: unknown): value is SettingsUiPlanSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const devices = (value as { devices?: unknown }).devices;
  return devices === undefined || (Array.isArray(devices) && devices.every(isValidPlanDevice));
};

export const getPowerTrackerForUiFromApp = (homey: Homey.App['homey']): PowerTrackerState | null => {
  const tracker = getRuntimeApp(homey)?.powerTracker;
  return tracker && typeof tracker === 'object' ? tracker : null;
};

export const emitSettingsUiDevicesUpdatedForApp = (
  homey: Homey.App['homey'],
  onError: (message: string, error: Error) => void,
): void => {
  const api = homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
  const realtime = api?.realtime;
  if (typeof realtime !== 'function') return;
  realtime.call(api, 'devices_updated', null)
    .catch((error: unknown) => onError('Failed to emit devices_updated event', error as Error));
};

export const emitSettingsUiPowerUpdatedForApp = (
  homey: Homey.App['homey'],
  powerTracker: PowerTrackerState,
  onError: (message: string, error: Error) => void,
): void => {
  const api = homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
  const realtime = api?.realtime;
  if (typeof realtime !== 'function') return;
  const status = homey.settings.get('pels_status') as PelsStatus | null;
  realtime.call(api, 'power_updated', {
    tracker: null,
    status: resolveRealtimePowerStatus(status, powerTracker),
    heartbeat: null,
  })
    .catch((error: unknown) => onError('Failed to emit power_updated event', error as Error));
};

export const refreshSettingsUiDevicesForApp = async (homey: Homey.App['homey']): Promise<TargetDeviceSnapshot[]> => {
  const app = getRuntimeApp(homey);
  if (!app?.refreshTargetDevicesSnapshot) {
    throw appNotReadyError('Refresh devices');
  }
  await app.refreshTargetDevicesSnapshot();
  return getLatestDevicesForUiFromApp(homey) ?? [];
};

export const refreshSettingsUiPricesForApp = async (homey: Homey.App['homey']): Promise<void> => {
  const app = getRuntimeApp(homey);
  if (!app?.priceCoordinator?.refreshSpotPrices) {
    throw appNotReadyError('Refresh prices');
  }
  await app.priceCoordinator.refreshSpotPrices(true);
};

export const refreshSettingsUiGridTariffForApp = async (homey: Homey.App['homey']): Promise<void> => {
  const app = getRuntimeApp(homey);
  if (!app?.priceCoordinator?.refreshGridTariffData) {
    throw appNotReadyError('Refresh grid tariff');
  }
  await app.priceCoordinator.refreshGridTariffData(true);
};

export const resetSettingsUiPowerStatsForApp = async (homey: Homey.App['homey']): Promise<PowerTrackerState> => {
  const app = getRuntimeApp(homey);
  if (!app?.replacePowerTrackerForUi) {
    throw appNotReadyError('Reset power stats');
  }

  const currentState = app.powerTracker || {};
  const currentHourKey = getHourBucketKey();
  const preserveCurrentHour = (collection?: Record<string, number>): Record<string, number> => (
    collection && collection[currentHourKey] !== undefined
      ? { [currentHourKey]: collection[currentHourKey] }
      : {}
  );
  const nextState: PowerTrackerState = {
    ...currentState,
    buckets: preserveCurrentHour(currentState.buckets),
    hourlySampleCounts: preserveCurrentHour(currentState.hourlySampleCounts),
    controlledBuckets: preserveCurrentHour(currentState.controlledBuckets),
    uncontrolledBuckets: preserveCurrentHour(currentState.uncontrolledBuckets),
    exemptBuckets: preserveCurrentHour(currentState.exemptBuckets),
    hourlyBudgets: preserveCurrentHour(currentState.hourlyBudgets),
    dailyBudgetCaps: {},
    dailyTotals: {},
    hourlyAverages: {},
    controlledDailyTotals: {},
    uncontrolledDailyTotals: {},
    exemptDailyTotals: {},
    controlledHourlyAverages: {},
    uncontrolledHourlyAverages: {},
    exemptHourlyAverages: {},
    unreliablePeriods: [],
  };
  app.replacePowerTrackerForUi(nextState);
  return app.powerTracker ?? nextState;
};
