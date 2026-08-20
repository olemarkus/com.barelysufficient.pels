import type Homey from 'homey';
import type { PowerTrackerState } from '../lib/power/tracker';
import type {
  SettingsUiPlanDevice,
  SettingsUiPlanSnapshot,
} from '../packages/contracts/src/settingsUiApi';
import type {
  AssociatedCarSnapshot,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import { getHourBucketKey } from '../lib/utils/dateUtils';

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
  deviceManager?: { getAssociatedCar?: (chargerId: string) => AssociatedCarSnapshot | undefined };
  getObservedState?: (deviceId: string) => ProjectedObservedDeviceState | undefined;
  powerTracker?: PowerTrackerState;
  canContributeCurtailmentSurplus?: () => boolean;
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
  powerNowKw?: number | null;
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

/**
 * The live car-association read. Resolved per call by the transport (never held
 * on a snapshot), so the settings UI sees a plug-in within the probe's ~90 s
 * settle rather than at the next :25/:55 refresh.
 */
export const getAssociatedCarForUiFromApp = (
  homey: Homey.App['homey'],
  chargerId: string,
): AssociatedCarSnapshot | undefined => (
  getRuntimeApp(homey)?.deviceManager?.getAssociatedCar?.(chargerId)
);

/**
 * The live observed-state read, from the observer projection that owns it.
 *
 * Same reason as the car association above: the stored device snapshot is
 * rebuilt only at :25/:55, so its observed half is up to half an hour stale by
 * the time the settings UI reads it. The projection is the observer's current
 * answer, so `/ui_devices` overlays it per read rather than serving the stored
 * copy.
 *
 * `undefined` means the projection holds no entry for this device yet (never
 * observed). That is an absence, not a reading — the caller keeps the stored
 * snapshot rather than blanking it.
 */
export const getObservedStateForUiFromApp = (
  homey: Homey.App['homey'],
  deviceId: string,
): ProjectedObservedDeviceState | undefined => (
  getRuntimeApp(homey)?.getObservedState?.(deviceId)
);

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

/**
 * Whether the curtailment-surplus estimator can structurally contribute for this
 * home — one half of `resolveSurplusPoolReachable`, which decides whether the
 * "Use solar surplus" toggle is offered at all.
 *
 * The seam is TOTAL: it reads two in-memory bits (a dormancy latch and
 * `hasBatteryDevices()`, itself an in-memory observation producer) and cannot
 * throw. So this is a plain read, matching the producer on the plan path
 * (`setup/appInit/toPlanDevice.ts`) — the two must resolve identically, or the
 * toggle and the posture disagree about the same home. Only ABSENCE is handled,
 * via the optional call: before the post-startup wiring runs there is no answer
 * yet, and false is the safe one.
 */
export const getCurtailmentCanContributeForUiFromApp = (
  homey: Homey.App['homey'],
): boolean => getRuntimeApp(homey)?.canContributeCurtailmentSurplus?.() === true;

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
    // Solar families (generation + export). Without these the `...currentState`
    // spread leaves them intact, so "Reset usage history" would leave the Solar
    // card's produced/exported history behind. Clear history, keep the current
    // hour, matching the consumption buckets above.
    generationBuckets: preserveCurrentHour(currentState.generationBuckets),
    exportBuckets: preserveCurrentHour(currentState.exportBuckets),
    generationDailyTotals: {},
    exportDailyTotals: {},
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
