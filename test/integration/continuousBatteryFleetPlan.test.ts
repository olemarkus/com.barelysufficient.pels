import { describe, expect, it } from 'vitest';
import { ContinuousBatteryPlanService } from '../../lib/battery/continuousBatteryPlanService';
import type { ContinuousBatteryEnergyHorizon, ContinuousBatteryHorizonRead } from '../../lib/ports/continuousBatteryPlan';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { BatteryEnergyModel, BatteryEnergyPeriod } from '../../packages/contracts/src/batteryPlan';
import type {
  ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead,
} from '../../packages/contracts/src/continuousBatteryPlan';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { perBatterySource } from '../helpers/batteryPlanSource';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const HOUR_MS = 3_600_000;
const config: ContinuousBatteryPlanConfig = {
  ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh',
};

const battery = (changes: Partial<BatteryEnergyModel> = {}): BatteryEnergyModel => ({
  capacityKWh: 10, storedEnergyKWh: 8, minimumEnergyKWh: 0,
  maxChargeKW: 2, chargeTaper: [], maxDischargeKW: 2, roundTripEfficiency: 1,
  wearCostPerKWh: 0, terminalValuePerKWh: 0, ...changes,
});

const period = (index: number, changes: Partial<BatteryEnergyPeriod> = {}): BatteryEnergyPeriod => ({
  startsAtMs: NOW + index * HOUR_MS, durationMs: HOUR_MS,
  importPrice: 1, exportPrice: 0, householdDemandKWh: 3, otherManagedDemandKWh: 0,
  solarKWh: 0, gridImportLimitKW: 10, maxChargeKW: 10, otherStorageKWh: 0, laterSupplyKW: 0,
  ...changes,
});

const ready = (model: BatteryEnergyModel, periods: readonly BatteryEnergyPeriod[]): ContinuousBatteryHorizonRead => {
  const [first, ...rest] = periods;
  if (first === undefined) throw new Error('A horizon needs a period');
  const horizon: ContinuousBatteryEnergyHorizon = { battery: model, periods: [first, ...rest] };
  return { kind: 'ready', horizon, priceUnit: 'EUR/kWh', exportPricing: 'complete' };
};

const settings = (configs: Record<string, ContinuousBatteryPlanConfig>): SettingsPort => ({
  get: key => (key === CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY ? configs : null),
  set: () => {},
  unset: () => {},
  getKeys: () => [CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY],
});

const fleet = (
  horizons: Record<string, ContinuousBatteryHorizonRead>,
  order: readonly string[],
  configs: Record<string, ContinuousBatteryPlanConfig> = Object.fromEntries(Object.keys(horizons).map(id => [id, config])),
) => {
  let horizonReads = 0;
  const owner = new ContinuousBatteryPlanService(settings(configs), perBatterySource({
    getNowMs: () => NOW,
    order,
    readHorizon: (deviceId) => {
      horizonReads += 1;
      const read = horizons[deviceId];
      if (read === undefined) throw new Error(`No horizon for ${deviceId}`);
      return read;
    },
  }));
  return { owner, horizonReads: () => horizonReads };
};

const planned = (read: ContinuousBatteryPlanRead) => {
  if (read.status !== 'planned') throw new Error(`Expected a plan, got ${read.status}`);
  return read.plan.periods;
};

describe('continuous battery plan across several batteries', () => {
  it('supplies the house once: a later battery covers only what the earlier one left', () => {
    const periods = [period(0)];
    const { owner } = fleet({ first: ready(battery(), periods), second: ready(battery(), periods) }, ['first', 'second']);
    const first = planned(owner.read('first'));
    const second = planned(owner.read('second'));
    expect(first[0]?.batteryPowerKW).toBeCloseTo(-2);
    expect(second[0]?.batteryPowerKW).toBeCloseTo(-1);
    expect(second[0]?.gridImportKWh).toBeCloseTo(0);
  });

  it('plans in the owner priority order, not the settings order', () => {
    const periods = [period(0)];
    const { owner } = fleet({ first: ready(battery(), periods), second: ready(battery(), periods) }, ['second', 'first']);
    expect(planned(owner.read('second'))[0]?.batteryPowerKW).toBeCloseTo(-2);
    expect(planned(owner.read('first'))[0]?.batteryPowerKW).toBeCloseTo(-1);
  });

  it('carries demand above the import limit to the next battery instead of failing the first', () => {
    // Stored energy is worth more than the import price, so each battery
    // supplies only what the limit makes it.
    const periods = [period(0, { householdDemandKWh: 4, gridImportLimitKW: 1 })];
    const keeping = battery({ terminalValuePerKWh: 1.5 });
    const alone = fleet({ first: ready(keeping, periods) }, ['first']);
    expect(alone.owner.read('first')).toMatchObject({ status: 'waiting', reason: 'horizon_infeasible' });
    const { owner } = fleet({ first: ready(keeping, periods), second: ready(keeping, periods) }, ['first', 'second']);
    const first = planned(owner.read('first'));
    const second = planned(owner.read('second'));
    expect(first[0]?.batteryPowerKW).toBeCloseTo(-2);
    expect(second[0]?.batteryPowerKW).toBeCloseTo(-1);
    expect(second[0]?.gridImportKWh).toBeCloseTo(1);
  });

  it('keeps a later battery planned when its stored energy cannot cover what the earlier one left', () => {
    const periods = [period(0, { householdDemandKWh: 4, gridImportLimitKW: 1 })];
    const keeping = battery({ terminalValuePerKWh: 1.5 });
    const { owner } = fleet({
      first: ready(keeping, periods),
      second: ready(battery({ storedEnergyKWh: 0.5, minimumEnergyKWh: 0, terminalValuePerKWh: 1.5 }), periods),
    }, ['first', 'second']);
    const first = planned(owner.read('first'));
    const second = planned(owner.read('second'));
    expect(first[0]?.batteryPowerKW).toBeCloseTo(-2);
    // It supplies all it has; the rest of the period stays on the grid.
    expect(second[0]?.batteryPowerKW).toBeCloseTo(-0.5);
    expect(second[0]?.gridImportKWh).toBeCloseTo(1.5);
  });

  it('never lets a battery charge while an earlier one supplies the house in the same period', () => {
    // Cheap now and expensive later: the second battery would like to buy now,
    // but the first already supplies the house in that period.
    const periods = [
      period(0, { importPrice: 0.5, householdDemandKWh: 2 }),
      period(1, { importPrice: 2, householdDemandKWh: 0 }),
    ];
    const { owner } = fleet({
      first: ready(battery({ storedEnergyKWh: 2, terminalValuePerKWh: 0 }), periods),
      second: ready(battery({ storedEnergyKWh: 0, terminalValuePerKWh: 1.5 }), periods),
    }, ['first', 'second']);
    const first = planned(owner.read('first'));
    const second = planned(owner.read('second'));
    expect(first[0]?.batteryPowerKW).toBeLessThan(0);
    expect(second[0]?.batteryPowerKW).toBeCloseTo(0);
  });

  it('keeps a household-only battery from supplying into a sale the battery before it plans', () => {
    const periods = [
      period(0, { householdDemandKWh: 0, importPrice: 0.1 }),
      period(1, { householdDemandKWh: 0, exportPrice: 3, importPrice: 1 }),
    ];
    const selling = { ...config, exportPolicy: { kind: 'price_export' as const, netExportCeilingKW: 5 } };
    const { owner } = fleet(
      { seller: ready(battery(), periods), keeper: ready(battery(), periods) },
      ['seller', 'keeper'],
      { seller: selling, keeper: config },
    );
    const seller = planned(owner.read('seller'));
    expect(seller[1]?.reason).toBe('export_energy');
    const keeper = planned(owner.read('keeper'));
    expect(keeper.every(entry => entry.batteryPowerKW >= 0)).toBe(true);
  });

  it('plans the remaining batteries while one waits', () => {
    const periods = [period(0)];
    const { owner } = fleet({
      first: { kind: 'waiting', reason: 'battery_unavailable' },
      second: ready(battery(), periods),
    }, ['first', 'second']);
    expect(owner.read('first')).toMatchObject({ status: 'waiting', reason: 'battery_unavailable' });
    expect(planned(owner.read('second'))[0]?.batteryPowerKW).toBeCloseTo(-2);
  });

  it('plans the fleet once for every battery read in the same cycle', () => {
    const periods = [period(0)];
    const { owner, horizonReads } = fleet({ first: ready(battery(), periods), second: ready(battery(), periods) }, ['first', 'second']);
    const first = owner.read('first');
    const second = owner.read('second');
    expect(horizonReads()).toBe(4);
    expect(owner.read('first')).toBe(first);
    expect(owner.read('second')).toBe(second);
  });
});
