import type {
  ContinuousBatteryPlanConfig, ContinuousBatteryPlanConfigs, ContinuousBatteryPlanRead,
} from '../../../../contracts/src/continuousBatteryPlan.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PRICES_PATH,
} from '../../../../contracts/src/settingsUi/paths.ts';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, parseContinuousBatteryPlanConfig, parseContinuousBatteryPlanConfigs,
} from '../../../../shared-domain/src/settings/continuousBatteryPlan.ts';
import { asUnknownRecord } from '../../../../shared-domain/src/recordGuards.ts';
import { callApi, getApiReadModel, getSettingFresh, invalidateApiCache, setSetting } from '../homey.ts';

const finiteFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => fields.every(
  key => typeof value[key] === 'number' && Number.isFinite(value[key]),
);

const validPeriod = (raw: unknown): boolean => {
  const period = asUnknownRecord(raw);
  return period !== null && finiteFields(period, [
    'startsAtMs', 'durationMs', 'batteryPowerKW', 'energyBeforeKWh', 'energyAfterKWh',
    'gridImportKWh', 'gridExportKWh', 'importCost', 'exportRevenue', 'wearCost',
  ]) && Number(period.durationMs) > 0
    && ['charge_grid', 'store_solar', 'hold_energy', 'supply_house'].includes(String(period.reason));
};

const validPlannedRead = (read: Record<string, unknown>): boolean => {
  const plan = asUnknownRecord(read.plan);
  return finiteFields(read, ['generatedAtMs']) && typeof read.priceUnit === 'string'
    && plan !== null && plan.status === 'planned' && Array.isArray(plan.periods) && plan.periods.every(validPeriod)
    && finiteFields(plan, [
      'importCost', 'exportRevenue', 'wearCost', 'energyCost', 'terminalEnergyValue',
      'objectiveCost', 'terminalEnergyKWh', 'resolutionKWh',
    ]);
};

/** Resolve the network envelope here; an unavailable roster never means a disabled battery. */
export async function loadContinuousBatteryPlan(deviceId: string): Promise<ContinuousBatteryPlanRead> {
  const payload = asUnknownRecord(await getApiReadModel<unknown>(SETTINGS_UI_DEVICES_PATH));
  const plans = asUnknownRecord(payload?.continuousBatteryPlans);
  const read = plans !== null && Object.hasOwn(plans, deviceId) ? asUnknownRecord(plans[deviceId]) : null;
  if (asUnknownRecord(payload?.homeScope)?.state === 'unavailable' || read === null
    || parseContinuousBatteryPlanConfig(read.config) === null) throw new Error('Battery planning is unavailable.');
  if (read.status === 'disabled' || (read.status === 'waiting' && [
    'settings_unavailable', 'battery_unavailable', 'prices_unavailable', 'forecast_unavailable', 'solar_scope_shared',
    'background_unavailable', 'control_unavailable', 'smart_tasks_planning', 'horizon_infeasible', 'price_unit_changed',
  ].includes(String(read.reason))) || (read.status === 'planned' && validPlannedRead(read))) {
    return read as ContinuousBatteryPlanRead;
  }
  throw new Error('Invalid battery plan response.');
}

async function readFreshConfigs(): Promise<ContinuousBatteryPlanConfigs> {
  const raw = await getSettingFresh(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY);
  if (raw != null) {
    const configs = parseContinuousBatteryPlanConfigs(raw);
    if (configs === null) throw new Error('Battery settings could not be read. Try again.');
    return configs;
  }
  // A new owner read proves genuine absence. A WebView null or the last
  // accepted UI map cannot authorize replacing a complete persisted map.
  const bootstrap = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_BOOTSTRAP_PATH));
  const configs = parseContinuousBatteryPlanConfigs(
    asUnknownRecord(bootstrap?.settings)?.[CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY],
  );
  if (configs === null) throw new Error('Battery settings are unavailable. Try again.');
  return configs;
}

export async function saveContinuousBatteryPlanConfig(
  deviceId: string,
  raw: ContinuousBatteryPlanConfig,
): Promise<ContinuousBatteryPlanConfig> {
  const config = parseContinuousBatteryPlanConfig(raw);
  if (!deviceId || config === null) throw new Error('Enter valid battery settings before saving.');
  const current = await readFreshConfigs();
  const next = parseContinuousBatteryPlanConfigs({ ...current, [deviceId]: config });
  if (next === null) throw new Error('Turn off the other battery plan before enabling this battery.');
  if (config.enabled) {
    const prices = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_PRICES_PATH));
    const timeline = asUnknownRecord(prices?.priceTimeline);
    if (timeline?.state !== 'ready' || typeof timeline.priceUnit !== 'string') {
      throw new Error('Waiting for electricity prices. Try again when prices are available.');
    }
    if (timeline.priceUnit.trim().toLowerCase() !== config.priceUnit.trim().toLowerCase()) {
      throw new Error('The electricity price unit changed. Review the wear allowance and save again.');
    }
  }
  await setSetting(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, next);
  invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
  return config;
}
