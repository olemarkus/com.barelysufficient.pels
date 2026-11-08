import type {
  BatteryEfficiencyMeasurement, ContinuousBatteryPlanConfig, ContinuousBatteryPlanConfigs, ContinuousBatteryPlanRead,
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
    && ['charge_grid', 'store_solar', 'hold_energy', 'supply_house', 'export_energy'].includes(String(period.reason));
};

const validExportDecision = (raw: unknown): boolean => {
  const decision = asUnknownRecord(raw);
  if (decision === null) return false;
  if (decision.kind === 'kept_household') return true;
  if (decision.kind === 'selling') return finiteFields(decision, ['estimatedSavings']);
  return decision.kind === 'waiting'
    && ['export_prices_incomplete', 'evaluation_budget_exceeded'].includes(String(decision.reason));
};

/** An export decision exactly when the owner authorized selling, and none otherwise. */
const validExportOutcome = (read: Record<string, unknown>, config: ContinuousBatteryPlanConfig): boolean => (
  config.exportPolicy.kind === 'price_export'
    ? validExportDecision(read.exportDecision)
    : !Object.hasOwn(read, 'exportDecision')
);

const validPlannedRead = (read: Record<string, unknown>, config: ContinuousBatteryPlanConfig): boolean => {
  const plan = asUnknownRecord(read.plan);
  return finiteFields(read, ['generatedAtMs']) && typeof read.priceUnit === 'string'
    && typeof read.unpricedSolarExport === 'boolean'
    && validExportOutcome(read, config)
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
  const config = read === null ? null : parseContinuousBatteryPlanConfig(read.config);
  if (asUnknownRecord(payload?.homeScope)?.state === 'unavailable' || read === null || config === null) {
    throw new Error('Battery planning is unavailable.');
  }
  if (read.status === 'disabled' || (read.status === 'waiting' && [
    'settings_unavailable', 'battery_unavailable', 'prices_unavailable', 'forecast_unavailable', 'solar_scope_shared',
    'background_unavailable', 'control_unavailable', 'smart_tasks_planning', 'horizon_infeasible', 'price_unit_changed',
  ].includes(String(read.reason))) || (read.status === 'planned' && validPlannedRead(read, config))) {
    // The parsed config, never the wire's: it is what the form edits and saves.
    return { ...read, config } as ContinuousBatteryPlanRead;
  }
  throw new Error('Invalid battery plan response.');
}

/**
 * How many other batteries have the plan on, from the same device read. It
 * only adds an explanation, so an unreadable roster counts none.
 */
export async function countOtherEnabledBatteryPlans(deviceId: string): Promise<number> {
  const payload = asUnknownRecord(await getApiReadModel<unknown>(SETTINGS_UI_DEVICES_PATH));
  const plans = asUnknownRecord(payload?.continuousBatteryPlans);
  if (plans === null) return 0;
  return Object.entries(plans).filter(([id, entry]) => (
    id !== deviceId && parseContinuousBatteryPlanConfig(asUnknownRecord(entry)?.config)?.enabled === true
  )).length;
}

const isCycleCount = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
);

const isEfficiency = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 1
);

const parseEfficiencyMeasurement = (entry: Record<string, unknown> | null): BatteryEfficiencyMeasurement => {
  if (entry === null || !isCycleCount(entry.cycles)) return { status: 'unavailable' };
  if (entry.status === 'measuring' && isCycleCount(entry.cyclesNeeded) && entry.cyclesNeeded > 0) {
    return { status: 'measuring', cycles: entry.cycles, cyclesNeeded: entry.cyclesNeeded };
  }
  if (entry.status === 'measured' && isEfficiency(entry.roundTripEfficiency)) {
    return { status: 'measured', roundTripEfficiency: entry.roundTripEfficiency, cycles: entry.cycles };
  }
  return { status: 'unavailable' };
};

/**
 * The battery owner's efficiency measurement for one battery. It only adds a
 * suggestion, so an absent or malformed entry reads as `unavailable` and never
 * fails the plan load.
 */
export async function loadBatteryEfficiencyMeasurement(deviceId: string): Promise<BatteryEfficiencyMeasurement> {
  const payload = asUnknownRecord(await getApiReadModel<unknown>(SETTINGS_UI_DEVICES_PATH));
  const measurements = asUnknownRecord(payload?.batteryEfficiencyMeasurements);
  return parseEfficiencyMeasurement(measurements !== null && Object.hasOwn(measurements, deviceId)
    ? asUnknownRecord(measurements[deviceId]) : null);
}

/**
 * Every battery's saved plan settings, read fresh. A battery with no entry has
 * never had its plan saved, so nothing about it (its capacity included) is
 * known yet; an unreadable map throws rather than reading as empty.
 */
export async function loadSavedContinuousBatteryPlanConfigs(): Promise<ContinuousBatteryPlanConfigs> {
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

/**
 * The price unit the runtime plans in now, read fresh: an enabled plan is saved
 * in it. Throws while the prices are not ready.
 */
export async function loadBatteryPlanPriceUnit(): Promise<string> {
  const prices = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_PRICES_PATH));
  const timeline = asUnknownRecord(prices?.priceTimeline);
  if (timeline?.state !== 'ready' || typeof timeline.priceUnit !== 'string' || timeline.priceUnit.trim() === '') {
    throw new Error('Waiting for electricity prices. Try again when prices are available.');
  }
  return timeline.priceUnit;
}

export async function saveContinuousBatteryPlanConfig(
  deviceId: string,
  raw: ContinuousBatteryPlanConfig,
): Promise<ContinuousBatteryPlanConfig> {
  const config = parseContinuousBatteryPlanConfig(raw);
  if (!deviceId || config === null) throw new Error('Enter valid battery settings before saving.');
  const current = await loadSavedContinuousBatteryPlanConfigs();
  const next = parseContinuousBatteryPlanConfigs({ ...current, [deviceId]: config });
  if (next === null) throw new Error('Enter valid battery settings before saving.');
  if (config.enabled) {
    const priceUnit = await loadBatteryPlanPriceUnit();
    if (priceUnit.trim().toLowerCase() !== config.priceUnit.trim().toLowerCase()) {
      throw new Error('The electricity price unit changed. Review the wear allowance and save again.');
    }
  }
  await setSetting(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, next);
  invalidateApiCache(SETTINGS_UI_DEVICES_PATH);
  document.dispatchEvent(new CustomEvent<ContinuousBatteryPlanConfigs>(
    'continuous-battery-plan-changed', { detail: next },
  ));
  return config;
}
