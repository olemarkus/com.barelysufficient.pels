import { describe, expect, it } from 'vitest';
import { planBatteryEnergy } from '../../lib/battery/planning/planBatteryEnergy';
import type {
  BatteryEnergyHorizon,
  BatteryEnergyModel,
  BatteryEnergyPeriod,
  BatteryEnergyPlan,
} from '../../packages/contracts/src/batteryPlan';

const HOUR_MS = 3_600_000;
const battery = (changes: Partial<BatteryEnergyModel> = {}): BatteryEnergyModel => ({
  capacityKWh: 4,
  storedEnergyKWh: 1,
  minimumEnergyKWh: 1,
  maxChargeKW: 3,
  maxDischargeKW: 3,
  roundTripEfficiency: 1,
  wearCostPerKWh: 0,
  terminalValuePerKWh: 0,
  ...changes,
});

const period = (index: number, changes: Partial<BatteryEnergyPeriod> = {}): BatteryEnergyPeriod => ({
  startsAtMs: index * HOUR_MS,
  durationMs: HOUR_MS,
  importPrice: 1,
  exportPrice: 0,
  householdDemandKWh: 1,
  otherManagedDemandKWh: 0,
  solarKWh: 0,
  gridImportLimitKW: 4,
  maxChargeKW: 3,
  ...changes,
});

const planned = (horizon: BatteryEnergyHorizon): Extract<BatteryEnergyPlan, { status: 'planned' }> => {
  const result = planBatteryEnergy(horizon);
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') throw new Error('Expected a feasible test horizon.');
  return result;
};

describe('continuous battery energy planning', () => {
  it('buys less overnight when solar arrives before the expensive household demand', () => {
    const periods = [
      period(0, { importPrice: 0.1, householdDemandKWh: 0 }),
      period(1, { importPrice: 0.3, solarKWh: 3 }),
      period(2, { importPrice: 0.5, householdDemandKWh: 2 }),
    ];
    const sunny = planned({ battery: battery(), periods });
    const cloudy = planned({ battery: battery(), periods: periods.map(value => ({ ...value, solarKWh: 0 })) });
    expect(sunny.periods[0].batteryPowerKW).toBeCloseTo(0);
    expect(cloudy.periods[0].batteryPowerKW).toBeCloseTo(3);
    expect(sunny.periods[1].reason).toBe('store_solar');
    expect(sunny.terminalEnergyKWh).toBeCloseTo(1);
  });

  it('does not use afternoon solar to justify leaving an expensive morning uncovered', () => {
    const result = planned({
      battery: battery(),
      periods: [
        period(0, { importPrice: 0.1, householdDemandKWh: 0 }),
        period(1, { importPrice: 1, householdDemandKWh: 2 }),
        period(2, { importPrice: 0.1, solarKWh: 4 }),
      ],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(2);
    expect(result.periods[1].gridImportKWh).toBeCloseTo(0);
  });

  it.each([
    { roundTripEfficiency: 0.81, wearCostPerKWh: 0 },
    { roundTripEfficiency: 1, wearCostPerKWh: 0.1 },
  ])('skips a price spread that cannot cover %j', (economics) => {
    const result = planned({
      battery: battery({ capacityKWh: 1, storedEnergyKWh: 0, minimumEnergyKWh: 0, ...economics }),
      periods: [period(0, { householdDemandKWh: 0 }), period(1, { importPrice: 1.05 })],
    });
    expect(result.periods.every(value => Math.abs(value.batteryPowerKW) < 1e-9)).toBe(true);
    expect(result.energyCost).toBeCloseTo(1.05);
  });

  it('accounts for both conversion directions and wear in actual energy costs', () => {
    const result = planned({
      battery: battery({
        capacityKWh: 2, storedEnergyKWh: 0, minimumEnergyKWh: 0,
        roundTripEfficiency: 0.81, wearCostPerKWh: 0.1,
      }),
      periods: [period(0, { householdDemandKWh: 0 }), period(1, { importPrice: 3, householdDemandKWh: 0.81 })],
    });
    expect(result.periods[0].gridImportKWh).toBeCloseTo(1);
    expect(result.periods[0].energyAfterKWh).toBeCloseTo(0.9);
    expect(result.periods[1].batteryPowerKW).toBeCloseTo(-0.81);
    expect(result.wearCost).toBeCloseTo(0.081);
    expect(result.energyCost).toBeCloseTo(1.081);
  });

  it('honours the grid power already booked by EV and other managed commitments', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 0, minimumEnergyKWh: 0 }),
      periods: [
        period(0, { importPrice: 0.1, householdDemandKWh: 0.5, otherManagedDemandKWh: 3.5 }),
        period(1, { importPrice: 2, householdDemandKWh: 2 }),
      ],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(0);
    expect(result.periods[0].gridImportKWh).toBeCloseTo(4);
    expect(result.periods[1].gridImportKWh).toBeCloseTo(2);
  });

  it('keeps a task physical-power reservation separate from its smaller planned energy', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 0, minimumEnergyKWh: 0 }),
      periods: [
        period(0, {
          importPrice: 0.1, householdDemandKWh: 0.5, otherManagedDemandKWh: 0.5,
          maxChargeKW: 0,
        }),
        period(1, { importPrice: 2, householdDemandKWh: 2 }),
      ],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(0);
    expect(result.periods[0].gridImportKWh).toBeCloseTo(1);
    expect(result.energyCost).toBeCloseTo(4.1);
  });

  it('can supply household demand when a physical reservation leaves no room for battery charging', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 3 }),
      periods: [period(0, { householdDemandKWh: 2, maxChargeKW: 0 })],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(-2);
    expect(result.terminalEnergyKWh).toBeCloseTo(1);
  });

  it('supplies a capacity deficit without spending the minimum reserve', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 3 }),
      periods: [period(0, { householdDemandKWh: 3, gridImportLimitKW: 1 })],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(-2);
    expect(result.periods[0].gridImportKWh).toBeCloseTo(1);
    expect(result.terminalEnergyKWh).toBeCloseTo(1);
  });

  it('reports an infeasible import ceiling rather than inventing battery energy', () => {
    expect(planBatteryEnergy({
      battery: battery(), periods: [period(0, { householdDemandKWh: 3, gridImportLimitKW: 1 })],
    })).toEqual({ status: 'infeasible', periodStartsAtMs: 0, reason: 'reserve_or_power_limit' });
    expect(planBatteryEnergy({
      battery: battery({ storedEnergyKWh: 4 }),
      periods: [period(0, { householdDemandKWh: 6, gridImportLimitKW: 1 })],
    })).toEqual({ status: 'infeasible', periodStartsAtMs: 0, reason: 'power_limit' });
  });

  it('never discharges an observed battery further below a newly configured reserve', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 0.4 }),
      periods: [period(0, { householdDemandKWh: 0, importPrice: 0.1 }), period(1, { householdDemandKWh: 2 })],
    });
    for (const value of result.periods) {
      expect(value.energyAfterKWh).toBeGreaterThanOrEqual(Math.min(value.energyBeforeKWh, 1) - 1e-9);
    }
    expect(result.terminalEnergyKWh).toBeGreaterThanOrEqual(1);
  });

  it('never discharges stored energy into solar export, even at a high export price', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 4 }),
      periods: [period(0, { householdDemandKWh: 0.25, solarKWh: 1, exportPrice: 5 })],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(0);
    expect(result.periods[0].gridExportKWh).toBeCloseTo(0.75);
    expect(result.terminalEnergyKWh).toBeCloseTo(4);
  });

  it('accounts for the export income forgone when storing solar', () => {
    const make = (laterImportPrice: number) => planned({
      battery: battery({ capacityKWh: 1, storedEnergyKWh: 0, minimumEnergyKWh: 0 }),
      periods: [
        period(0, { householdDemandKWh: 0, solarKWh: 1, exportPrice: 0.4 }),
        period(1, { importPrice: laterImportPrice }),
      ],
    });
    expect(make(0.3).periods[0].gridExportKWh).toBeCloseTo(1);
    expect(make(0.7).periods[0].reason).toBe('store_solar');
  });

  it('can store negatively priced imports without inventing a later discharge demand', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 0, minimumEnergyKWh: 0, maxChargeKW: 1 }),
      periods: [
        period(0, { householdDemandKWh: 0, importPrice: -0.2 }),
        period(1, { householdDemandKWh: 0, importPrice: 0.1 }),
      ],
    });
    expect(result.periods[0].gridImportKWh).toBeCloseTo(1);
    expect(result.terminalEnergyKWh).toBeCloseTo(1);
    expect(result.energyCost).toBeCloseTo(-0.2);
  });

  it('prices partial and quarter-hour periods by duration across midnight', () => {
    const startsAtMs = Date.parse('2026-10-26T23:50:00Z');
    const result = planned({
      battery: battery({ capacityKWh: 1, storedEnergyKWh: 0, minimumEnergyKWh: 0 }),
      periods: [
        period(0, { startsAtMs, durationMs: 600_000, householdDemandKWh: 0, importPrice: 0.1, gridImportLimitKW: 2 }),
        period(1, { startsAtMs: startsAtMs + 600_000, durationMs: 900_000, householdDemandKWh: 0.3 }),
      ],
    });
    expect(result.periods[0].batteryPowerKW).toBeCloseTo(1.8);
    expect(result.periods[1].batteryPowerKW).toBeCloseTo(-1.2);
    expect(result.periods[1].startsAtMs).toBe(startsAtMs + 600_000);
    expect(result.energyCost).toBeCloseTo(0.03);
  });

  it('credits usable energy beyond the horizon instead of forcing an empty endpoint', () => {
    const result = planned({
      battery: battery({ capacityKWh: 2, storedEnergyKWh: 0, minimumEnergyKWh: 0, terminalValuePerKWh: 0.3 }),
      periods: [period(0, { householdDemandKWh: 0, importPrice: 0.1 })],
    });
    expect(result.terminalEnergyKWh).toBeCloseTo(2);
    expect(result.energyCost).toBeCloseTo(0.2);
    expect(result.terminalEnergyValue).toBeCloseTo(0.6);
    expect(result.objectiveCost).toBeCloseTo(-0.4);
  });

  it('breaks equal-cost choices in favour of less battery cycling', () => {
    const result = planned({
      battery: battery({ storedEnergyKWh: 1 }),
      periods: [period(0, { householdDemandKWh: 0 }), period(1)],
    });
    expect(result.periods.every(value => value.reason === 'hold_energy')).toBe(true);
    expect(result.energyCost).toBeCloseTo(1);
  });

  it('matches an independent exhaustive optimum on a small integral-energy horizon', () => {
    const periods = [0.12, 0.5, 0.2].map((importPrice, index) => period(index, {
      importPrice, householdDemandKWh: 0.5, gridImportLimitKW: 1,
    }));
    const model = battery({
      capacityKWh: 1, storedEnergyKWh: 0.5, minimumEnergyKWh: 0,
      maxChargeKW: 0.5, maxDischargeKW: 0.5, terminalValuePerKWh: 0.05,
    });
    const exhaustive = (index: number, energy: number): number => {
      if (index === periods.length) return -energy * 0.05;
      return Math.min(...[-0.5, 0, 0.5].map(delta => {
        const after = energy + delta;
        if (after < 0 || after > 1) return Infinity;
        const grid = 0.5 + delta;
        return grid * periods[index].importPrice + exhaustive(index + 1, after);
      }));
    };
    expect(planned({ battery: model, periods }).objectiveCost).toBeCloseTo(exhaustive(0, 0.5));
  });
});
