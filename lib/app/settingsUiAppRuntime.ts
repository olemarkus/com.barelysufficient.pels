import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../utils/types';
import { getHourBucketKey } from '../utils/dateUtils';

type SettingsUiRuntimeApp = Homey.App & {
  latestTargetSnapshot?: TargetDeviceSnapshot[];
  powerTracker?: PowerTrackerState;
  getLatestPlanSnapshotForUi?: () => SettingsUiPlanSnapshot | null;
  priceCoordinator?: {
    refreshSpotPrices: (forceRefresh?: boolean) => Promise<void>;
    refreshGridTariffData: (forceRefresh?: boolean) => Promise<void>;
  };
  refreshTargetDevicesSnapshot?: (options?: { fast?: boolean }) => Promise<void>;
  replacePowerTrackerForUi?: (nextState: PowerTrackerState) => void;
};
type PelsStatus = { lastPowerUpdate?: number | null; priceLevel?: string | null };

const getRuntimeApp = (homey: Homey.App['homey']): SettingsUiRuntimeApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiRuntimeApp;
};

export const getLatestDevicesForUiFromApp = (homey: Homey.App['homey']): TargetDeviceSnapshot[] | null => {
  const app = getRuntimeApp(homey);
  return Array.isArray(app?.latestTargetSnapshot) ? app.latestTargetSnapshot : null;
};

export const getPlanSnapshotForUiFromHomey = (homey: Homey.App['homey']): SettingsUiPlanSnapshot | null => {
  const appPlan = getRuntimeApp(homey)?.getLatestPlanSnapshotForUi?.();
  if (appPlan && typeof appPlan === 'object') {
    return appPlan;
  }
  const plan = homey.settings.get('device_plan_snapshot') as unknown;
  return plan && typeof plan === 'object' ? plan as SettingsUiPlanSnapshot : null;
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
