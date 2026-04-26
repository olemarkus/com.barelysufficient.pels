import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import type {
  SettingsUiPlanDevice,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../utils/types';
import { getHourBucketKey } from '../utils/dateUtils';

type SettingsUiRuntimeApp = Homey.App & {
  latestTargetSnapshot?: TargetDeviceSnapshot[];
  powerTracker?: PowerTrackerState;
  getLatestPlanSnapshotForUi?: () => SettingsUiPlanSnapshot | null;
  getPlanSnapshotForUiFromPersistedPlan?: (plan: SettingsUiPlanSnapshot) => SettingsUiPlanSnapshot | null;
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

const getRuntimeApp = (homey: Homey.App['homey']): SettingsUiRuntimeApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiRuntimeApp;
};

export const getLatestDevicesForUiFromApp = (homey: Homey.App['homey']): TargetDeviceSnapshot[] | null => {
  const app = getRuntimeApp(homey);
  const snapshot = app?.latestTargetSnapshot;
  return Array.isArray(snapshot) ? snapshot : null;
};

const getSerializedPersistedPlanForUi = (
  app: SettingsUiRuntimeApp | null,
  plan: SettingsUiPlanSnapshot,
): SettingsUiPlanSnapshot | null => {
  let serializedPlan: SettingsUiPlanSnapshot | null | undefined;
  try {
    serializedPlan = app?.getPlanSnapshotForUiFromPersistedPlan?.(plan);
  } catch (error) {
    app?.error?.('Failed to serialize persisted settings UI plan snapshot', error as Error);
    return null;
  }
  if (serializedPlan === null || serializedPlan === undefined) return null;
  if (isValidPlanSnapshot(serializedPlan)) return serializedPlan;
  app?.error?.(
    'Ignoring invalid serialized settings UI plan snapshot: finalized devices must include structured reason',
  );
  return null;
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
  const plan = homey.settings.get('device_plan_snapshot') as unknown;
  if (!isValidPlanSnapshot(plan)) {
    if (plan !== null && plan !== undefined) {
      app?.error?.(
        'Ignoring invalid persisted settings UI plan snapshot: finalized devices must include structured reason',
      );
    }
    return null;
  }
  return getSerializedPersistedPlanForUi(app, plan) ?? plan;
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

export const emitSettingsUiPowerUpdatedForApp = (
  homey: Homey.App['homey'],
  powerTracker: PowerTrackerState,
  onError: (message: string, error: Error) => void,
): void => {
  const api = homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
  const realtime = api?.realtime;
  if (typeof realtime !== 'function') return;
  const status = homey.settings.get('pels_status') as PelsStatus | null;
  const heartbeat = homey.settings.get('app_heartbeat') as unknown;
  realtime.call(api, 'power_updated', {
    tracker: powerTracker,
    status: status && typeof status === 'object' ? status : null,
    heartbeat: typeof heartbeat === 'number' ? heartbeat : null,
  })
    .catch((error: unknown) => onError('Failed to emit power_updated event', error as Error));
};

export const refreshSettingsUiDevicesForApp = async (homey: Homey.App['homey']): Promise<TargetDeviceSnapshot[]> => {
  const app = getRuntimeApp(homey);
  if (!app?.refreshTargetDevicesSnapshot) {
    throw new Error('Refresh devices functionality is not available in the app.');
  }
  await app.refreshTargetDevicesSnapshot();
  return getLatestDevicesForUiFromApp(homey) ?? [];
};

export const refreshSettingsUiPricesForApp = async (homey: Homey.App['homey']): Promise<void> => {
  const app = getRuntimeApp(homey);
  if (!app?.priceCoordinator?.refreshSpotPrices) {
    throw new Error('Refresh prices functionality is not available in the app.');
  }
  await app.priceCoordinator.refreshSpotPrices(true);
};

export const refreshSettingsUiGridTariffForApp = async (homey: Homey.App['homey']): Promise<void> => {
  const app = getRuntimeApp(homey);
  if (!app?.priceCoordinator?.refreshGridTariffData) {
    throw new Error('Refresh grid tariff functionality is not available in the app.');
  }
  await app.priceCoordinator.refreshGridTariffData(true);
};

export const resetSettingsUiPowerStatsForApp = async (homey: Homey.App['homey']): Promise<PowerTrackerState> => {
  const app = getRuntimeApp(homey);
  if (!app?.replacePowerTrackerForUi) {
    throw new Error('Reset power stats functionality is not available in the app.');
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
