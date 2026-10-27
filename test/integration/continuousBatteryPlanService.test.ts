import { describe, expect, it } from 'vitest';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import type { ContinuousBatteryEnergyHorizon, ContinuousBatteryPlanSource } from '../../lib/ports/continuousBatteryPlan';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY,
  DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
  parseContinuousBatteryPlanConfig,
  parseContinuousBatteryPlanConfigs,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const config: ContinuousBatteryPlanConfig = {
  ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh',
};
const horizon: ContinuousBatteryEnergyHorizon = {
  battery: {
    capacityKWh: 10, storedEnergyKWh: 4, minimumEnergyKWh: 2,
    maxChargeKW: 2.5, maxDischargeKW: 2.5, roundTripEfficiency: 0.9,
    wearCostPerKWh: 0.03, terminalValuePerKWh: 0.1,
  },
  periods: [{
    startsAtMs: NOW, durationMs: 3_600_000,
    importPrice: 0.2, exportPrice: 0, householdDemandKWh: 0.5, otherManagedDemandKWh: 0,
    solarKWh: 0, gridImportLimitKW: 5, maxChargeKW: 2.5,
  }],
};
const source: ContinuousBatteryPlanSource = {
  getNowMs: () => NOW,
  readHorizon: () => ({ kind: 'ready', horizon, priceUnit: 'EUR/kWh' }),
};

const settingsStore = (initial: Record<string, unknown> = {}) => {
  const values = new Map<string, unknown>([['capacity_limit_kw', 5], ...Object.entries(initial)]);
  let unavailable = false;
  const settings: SettingsPort = {
    get: key => unavailable ? null : (values.get(key) ?? null),
    set: (key, value) => { values.set(key, value); },
    unset: key => { values.delete(key); },
    getKeys: () => unavailable ? [] : [...values.keys()],
  };
  return { settings, values, loseReads: () => { unavailable = true; } };
};

describe('continuous battery plan owner', () => {
  it('defaults to disabled only for a genuinely never-written setting', () => {
    const store = settingsStore();
    const owner = new ContinuousBatteryPlanService(store.settings, source);
    expect(owner.read('battery')).toEqual({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
    store.loseReads();
    const unread = new ContinuousBatteryPlanService(store.settings, source);
    expect(unread.read('battery')).toMatchObject({ status: 'waiting', reason: 'settings_unavailable' });
  });

  it('never resolves inherited map keys as configured batteries', () => {
    const owner = new ContinuousBatteryPlanService(settingsStore().settings, source);
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(owner.read(id)).toEqual({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
    }
  });

  it('retains the last accepted configuration through a transient settings read failure', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    const owner = new ContinuousBatteryPlanService(store.settings, source);
    const plan = owner.read('battery');
    expect(plan.status).toBe('planned');
    store.loseReads();
    expect(owner.read('battery')).toBe(plan);
    expect(() => owner.save('battery', { ...config, enabled: false })).toThrow('could not be read');
    expect(store.values.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)).toEqual({ battery: config });
  });

  it('merges a valid owner save with the actual map and refuses a second continuous battery', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { other: { ...config, enabled: false } } });
    const owner = new ContinuousBatteryPlanService(store.settings, source);
    owner.save('battery', config);
    expect(store.values.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)).toEqual({ other: { ...config, enabled: false }, battery: config });
    expect(() => owner.save('other', config)).toThrow('one home battery');
    owner.save('battery', { ...config, enabled: false });
    expect(owner.read('battery').status).toBe('disabled');
  });

  it('stops returning an executable plan when its input becomes unavailable', () => {
    const store = settingsStore({ [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY]: { battery: config } });
    let available = true;
    const owner = new ContinuousBatteryPlanService(store.settings, {
      getNowMs: () => NOW,
      readHorizon: () => available
        ? { kind: 'ready', horizon, priceUnit: 'EUR/kWh' }
        : { kind: 'waiting', reason: 'forecast_unavailable' },
    });
    expect(owner.read('battery').status).toBe('planned');
    available = false;
    expect(owner.read('battery')).toEqual({ status: 'waiting', config, reason: 'forecast_unavailable' });
  });

  it('strictly rejects malformed capacity, reserve, efficiency, price unit and wear', () => {
    for (const invalid of [
      { ...config, usableCapacityKWh: Number.NaN }, { ...config, minimumReservePercent: 100 },
      { ...config, roundTripEfficiency: 0 }, { ...config, wearCostPerKWh: -1 }, { ...config, priceUnit: '' },
    ]) expect(parseContinuousBatteryPlanConfig(invalid)).toBeNull();
    expect(parseContinuousBatteryPlanConfigs({ battery: config, other: { enabled: true } })).toBeNull();
  });
});
