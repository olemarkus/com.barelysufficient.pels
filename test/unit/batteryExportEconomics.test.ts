import { describe, expect, it } from 'vitest';
import {
  compareBatteryExportEconomics, planBatteryEnergy,
  type BatteryExportEconomicsPolicy,
} from '../../lib/battery/planning/planBatteryEnergy';
import { batteryEnergyFlow } from '../../lib/battery/planning/batteryEnergyFlow';
import type {
  BatteryEnergyHorizon, BatteryEnergyModel, BatteryEnergyPeriod,
} from '../../packages/contracts/src/batteryPlan';

const HOUR_MS = 3_600_000;
const policy: BatteryExportEconomicsPolicy = { kind: 'price_export', netExportCeilingKW: 1 };
const battery = (changes: Partial<BatteryEnergyModel> = {}): BatteryEnergyModel => ({
  capacityKWh: 2, storedEnergyKWh: 0, minimumEnergyKWh: 0,
  maxChargeKW: 2, maxDischargeKW: 2, roundTripEfficiency: 1,
  wearCostPerKWh: 0, terminalValuePerKWh: 0, ...changes,
});
const period = (index: number, changes: Partial<BatteryEnergyPeriod> = {}): BatteryEnergyPeriod => ({
  startsAtMs: index * HOUR_MS, durationMs: HOUR_MS,
  importPrice: 1, exportPrice: 0, householdDemandKWh: 0,
  otherManagedDemandKWh: 0, solarKWh: 0, gridImportLimitKW: 2,
  maxChargeKW: 2, ...changes,
});
const compare = (horizon: BatteryEnergyHorizon, exportPolicy = policy) => {
  const baseline = planBatteryEnergy(horizon);
  if (baseline.status !== 'planned') throw new Error('Expected a feasible household baseline.');
  const result = compareBatteryExportEconomics(horizon, exportPolicy, baseline);
  if (result.kind !== 'compared') throw new Error('Relaxing discharge must preserve the baseline trajectory.');
  expect(result.terminalEnergyKWh).toBe(baseline.terminalEnergyKWh);
  expect(result.candidateEnergyCost).toBeLessThanOrEqual(baseline.energyCost + 1e-9);
  expect(planBatteryEnergy(horizon)).toEqual(baseline);
  return result;
};

describe('battery export shadow economics', () => {
  it('values a complete profitable cycle and respects the net-export ceiling', () => {
    const result = compare({ battery: battery(), periods: [
      period(0, { importPrice: 0.1 }), period(1, { exportPrice: 0.4 }),
    ] });
    expect(result.selection).toBe('export_candidate');
    expect(result.estimatedSavings).toBeCloseTo(0.3);
    expect(result.exportPeriods).toEqual([{
      startsAtMs: HOUR_MS, durationMs: HOUR_MS, batteryPowerKW: -1, batteryExportKWh: 1,
    }]);
  });

  it('accounts for reserve, both conversion losses and wear per AC kWh supplied', () => {
    const result = compare({
      battery: battery({
        storedEnergyKWh: 0.2, minimumEnergyKWh: 0.2, maxChargeKW: 1,
        roundTripEfficiency: 0.81, wearCostPerKWh: 0.02,
      }),
      periods: [period(0, { importPrice: 0.1 }), period(1, { exportPrice: 0.4 })],
    });
    expect(result.terminalEnergyKWh).toBe(0.2);
    expect(result.exportPeriods[0].batteryExportKWh).toBeCloseTo(0.81);
    expect(result.estimatedSavings).toBeCloseTo(0.81 * 0.4 - 0.1 - 0.81 * 0.02);
  });

  it.each([
    { importPrice: 0.4, exportPrice: 0.3, roundTripEfficiency: 1, wearCostPerKWh: 0 },
    { importPrice: 0.1, exportPrice: 0.12, roundTripEfficiency: 0.81, wearCostPerKWh: 0 },
    { importPrice: 0.1, exportPrice: 0.12, roundTripEfficiency: 1, wearCostPerKWh: 0.03 },
    { importPrice: 0.1, exportPrice: 0.1, roundTripEfficiency: 1, wearCostPerKWh: 0 },
  ])('retains the household plan when settled prices, losses or wear erase the spread: %j', (prices) => {
    const result = compare({
      battery: battery({ roundTripEfficiency: prices.roundTripEfficiency, wearCostPerKWh: prices.wearCostPerKWh }),
      periods: [period(0, { importPrice: prices.importPrice }), period(1, { exportPrice: prices.exportPrice })],
    });
    expect(result.selection).toBe('household');
    expect(result.estimatedSavings).toBe(0);
    expect(result.exportPeriods).toEqual([]);
  });

  it('keeps energy for more valuable household and committed task demand', () => {
    const result = compare({
      battery: battery({ capacityKWh: 1, storedEnergyKWh: 1 }),
      periods: [period(0, { exportPrice: 0.5 }), period(1, {
        importPrice: 2, householdDemandKWh: 0.5, otherManagedDemandKWh: 0.5, maxChargeKW: 0,
      })],
    });
    expect(result.selection).toBe('household');
    expect(result.baselineEnergyCost).toBe(0);
    expect(result.exportPeriods).toEqual([]);
  });

  it('does not manufacture savings by liquidating initial inventory at the horizon end', () => {
    const result = compare({
      battery: battery({ storedEnergyKWh: 1.237, minimumEnergyKWh: 0.413 }),
      periods: [period(0, { exportPrice: 100 })],
    });
    expect(result.terminalEnergyKWh).toBe(1.237);
    expect(result.selection).toBe('household');
    expect(result.exportPeriods).toEqual([]);
  });

  it('subtracts existing solar revenue when comparing delayed sales', () => {
    const result = compare({ battery: battery(), periods: [
      period(0, { solarKWh: 1, exportPrice: 0.1 }), period(1, { exportPrice: 0.6 }),
    ] });
    expect(result.baselineEnergyCost).toBeCloseTo(-0.1);
    expect(result.candidateEnergyCost).toBeCloseTo(-0.6);
    expect(result.estimatedSavings).toBeCloseTo(0.5);
    expect(result.exportPeriods[0].startsAtMs).toBe(HOUR_MS);
    expect(result.exportPeriods[0].batteryExportKWh).toBeCloseTo(1);
  });

  it('keeps independent PV export above the ceiling feasible without adding battery discharge', () => {
    const result = compare({ battery: battery({ storedEnergyKWh: 1 }), periods: [
      period(0, { solarKWh: 3, exportPrice: 2 }), period(1, { importPrice: 0.1 }),
    ] });
    expect(result.baselineEnergyCost).toBeCloseTo(-6);
    expect(result.selection).toBe('household');
    expect(result.exportPeriods).toEqual([]);
  });

  it('counts only battery-added export when the house already exports solar', () => {
    const result = compare({ battery: battery({ storedEnergyKWh: 1 }), periods: [
      period(0, { solarKWh: 0.4, exportPrice: 1 }), period(1, { importPrice: 0.1 }),
    ] });
    expect(result.exportPeriods[0].batteryPowerKW).toBeCloseTo(-0.6);
    expect(result.exportPeriods[0].batteryExportKWh).toBeCloseTo(0.6);
    expect(result.estimatedSavings).toBeCloseTo(0.54);
  });

  it.each([0, -0.1])('does not export at %s even if a later negative import price would pay for it', (exportPrice) => {
    const result = compare({ battery: battery({ capacityKWh: 1, storedEnergyKWh: 1 }), periods: [
      period(0, { exportPrice }), period(1, { importPrice: -0.2 }),
    ] });
    expect(result.selection).toBe('household');
    expect(result.exportPeriods).toEqual([]);
    const householdFlow = batteryEnergyFlow(
      battery({ storedEnergyKWh: 1 }), period(0, { householdDemandKWh: 1, exportPrice }), 1, 0, policy,
    );
    expect(householdFlow).not.toBe(false);
  });

  it('accepts negative charging prices while replenishing the baseline terminal inventory', () => {
    const result = compare({ battery: battery({ capacityKWh: 1 }), periods: [
      period(0, { importPrice: -0.1 }), period(1, { exportPrice: 0.5 }), period(2, { importPrice: 0.1 }),
    ] });
    expect(result.terminalEnergyKWh).toBe(1);
    expect(result.estimatedSavings).toBeCloseTo(0.4);
  });

  it('cannot spend a reserve or discharge farther below a newly raised reserve', () => {
    const model = battery({ storedEnergyKWh: 0.2, minimumEnergyKWh: 0.5 });
    expect(batteryEnergyFlow(model, period(0, { exportPrice: 10 }), 0.2, 0.1, policy)).toBe(false);
    expect(batteryEnergyFlow(model, period(0, { exportPrice: 10 }), 0.6, 0.4, policy)).toBe(false);
  });

  it.each(['2026-03-29T00:50:00Z', '2026-10-25T00:50:00Z'])('uses actual partial and quarter-hour durations across DST at %s', (start) => {
    const startsAtMs = Date.parse(start);
    const result = compare({ battery: battery(), periods: [
      period(0, { startsAtMs, durationMs: 600_000, importPrice: 0.1 }),
      period(1, { startsAtMs: startsAtMs + 600_000, durationMs: 900_000, exportPrice: 1 }),
    ] });
    expect(result.exportPeriods).toEqual([{
      startsAtMs: startsAtMs + 600_000, durationMs: 900_000,
      batteryPowerKW: -1, batteryExportKWh: 0.25,
    }]);
    expect(result.estimatedSavings).toBeCloseTo(0.225);
  });

  it.each([
    { maxChargeKW: 0, otherManagedDemandKWh: 1 },
    { gridImportLimitKW: 1, otherManagedDemandKWh: 1 },
  ])('preserves physical task reservations and grid-import limits: %j', (limits) => {
    const result = compare({ battery: battery(), periods: [
      period(0, { importPrice: 0.1, ...limits }),
      period(1, { exportPrice: 1 }),
    ] });
    expect(result.selection).toBe('household');
    expect(result.exportPeriods).toEqual([]);
  });

  it('retains the baseline for improvements within money comparison tolerance', () => {
    const result = compare({ battery: battery(), periods: [
      period(0, { importPrice: 0.1 }), period(1, { exportPrice: 0.1 + 5e-10 }),
    ] });
    expect(result.selection).toBe('household');
    expect(result.estimatedSavings).toBe(0);
  });
});
