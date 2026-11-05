import type {
  ContinuousBatteryPlanConfig, ContinuousBatteryPlanConfigs,
} from '../../../contracts/src/continuousBatteryPlan.ts';
import {
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../../shared-domain/src/settings/continuousBatteryPlan.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { resolveBatteryPlanControlBlock } from './deviceDetail/continuousBatteryPlan.tsx';
import {
  loadBatteryPlanPriceUnit, loadSavedContinuousBatteryPlanConfigs, saveContinuousBatteryPlanConfig,
} from './deviceDetail/continuousBatteryPlanTransport.ts';
import { state } from './state.ts';

/**
 * The battery plan as `Choose what PELS does` offers it: the same
 * `continuous_battery_plan` setting the battery's device page writes, through
 * the same save. The page shows only whether the plan is on and the battery's
 * usable capacity, which the plan cannot run without; everything else keeps
 * what the device page saved, or its form defaults.
 *
 * The saved map is read here, not from the plan read model: that read fills a
 * battery never saved with the form default (10 kWh), and a capacity PELS
 * assumed must not be offered as the owner's. A battery with no saved entry has
 * no known capacity, so the owner enters it before the plan can be turned on.
 */
type SavedBatteryPlans =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; configs: ContinuousBatteryPlanConfigs };

let saved: SavedBatteryPlans = { state: 'loading' };
let generation = 0;
const listeners = new Set<() => void>();

/** Repaint whoever shows the battery plan once the saved map arrives or changes. */
export const onSetupBatteryPlansChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const publish = (next: SavedBatteryPlans): void => {
  saved = next;
  for (const listener of listeners) listener();
};

/** Read the saved map again; a failed read is `unavailable`, never an empty map. */
export const loadSetupBatteryPlans = async (): Promise<void> => {
  const current = ++generation;
  try {
    const configs = await loadSavedContinuousBatteryPlanConfigs();
    if (current === generation) publish({ state: 'ready', configs });
  } catch {
    if (current === generation) publish({ state: 'unavailable' });
  }
};

/** The battery's saved plan settings, or `null` while none were ever saved (or the map is unread). */
const readSavedConfig = (deviceId: string): ContinuousBatteryPlanConfig | null => (
  saved.state === 'ready' && Object.hasOwn(saved.configs, deviceId) ? saved.configs[deviceId] ?? null : null
);

export type SetupBatteryGoal =
  | { state: 'loading' | 'unavailable' }
  /** Why PELS cannot run this battery's plan, in the device page's words. */
  | { state: 'blocked'; reason: string }
  /**
   * `capacityKWh` is the saved usable capacity, `null` while none was ever
   * saved; `simulating` while Simulation mode holds back battery commands.
   */
  | { state: 'ready'; enabled: boolean; capacityKWh: number | null; simulating: boolean };

/** The battery row's state, or `null` for a device that is not a home battery. */
export const resolveSetupBatteryGoal = (device: SettingsUiDeviceListItem): SetupBatteryGoal | null => {
  if (!isHomeBatteryClassKey(device.deviceClass)) return null;
  const reason = resolveBatteryPlanControlBlock(device);
  if (reason !== '') return { state: 'blocked', reason };
  if (saved.state !== 'ready') return { state: saved.state };
  const config = readSavedConfig(device.id);
  return config === null
    ? { state: 'ready', enabled: false, capacityKWh: null, simulating: state.dryRun }
    : { state: 'ready', enabled: config.enabled, capacityKWh: config.usableCapacityKWh, simulating: state.dryRun };
};

/** Whether the battery's plan is saved on; `false` while the map has not been read. */
export const isSetupBatteryPlanOn = (deviceId: string): boolean => readSavedConfig(deviceId)?.enabled === true;

const PLACEHOLDER_UNIT = 'price units';

/**
 * Turn the battery's plan on with this usable capacity, or off. Turning it on
 * keeps the rest of what the device page saved; a battery never saved starts
 * from the form defaults with no wear allowance, as its device page does. A
 * wear allowance saved in another price unit is not carried over silently: the
 * owner reviews it on the device page.
 */
export const saveSetupBatteryPlan = async (
  deviceId: string,
  enabled: boolean,
  capacityKWh: number | null,
): Promise<void> => {
  if (saved.state !== 'ready') throw new Error('Battery settings could not be read. Try again.');
  const current = readSavedConfig(deviceId);
  const base = current ?? DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG;
  if (!enabled) {
    if (current !== null) await saveContinuousBatteryPlanConfig(deviceId, { ...current, enabled: false });
  } else {
    if (capacityKWh === null) throw new Error('Enter the battery’s usable capacity first.');
    const priceUnit = await loadBatteryPlanPriceUnit();
    const unitless = base.priceUnit === PLACEHOLDER_UNIT;
    if (!unitless && base.priceUnit.trim().toLowerCase() !== priceUnit.trim().toLowerCase()) {
      throw new Error('The electricity price unit changed. Review the wear allowance on the battery’s device page.');
    }
    await saveContinuousBatteryPlanConfig(deviceId, {
      ...base,
      enabled: true,
      usableCapacityKWh: capacityKWh,
      priceUnit,
      wearCostPerKWh: unitless ? 0 : base.wearCostPerKWh,
    });
  }
  await loadSetupBatteryPlans();
};

