/**
 * Scenario benchmark of the inspected Ultimate EMS charging-window method.
 *
 * Usage: node scripts/benchmark-battery-plan.mjs /path/to/ultimate-ems-2.5.119
 * No competitor source is copied. The external method chooses grid-charge
 * windows, then a common physical replay applies the same reserve, usable
 * capacity, conversion loss, wear and tariff to its windows. This is a focused
 * method comparison under perfect fixture forecasts, not an end-to-end EMS
 * comparison, a field savings claim, or an annual business-case estimate.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.argv[2];
if (!directory) throw new Error('Pass the inspected Ultimate EMS app directory as the first argument.');
const sourcePath = resolve(directory, 'managers/PlanningEngine.js');
const require = createRequire(import.meta.url);
const UltimatePlanningEngine = require(sourcePath);
const compiled = await build({
  entryPoints: [resolve(root, 'lib/battery/planning/planBatteryEnergy.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { planBatteryEnergy } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);

const model = {
  capacityKWh: 9, storedEnergyKWh: 2, minimumEnergyKWh: 2,
  maxChargeKW: 2.5, maxDischargeKW: 2.5,
  roundTripEfficiency: 0.9, wearCostPerKWh: 0.03, terminalValuePerKWh: 0.1,
};

function makeHorizon(solarTiming, smallSpread = false) {
  const periods = Array.from({ length: 24 }, (_, hour) => {
    let solarKWh = 0;
    if (solarTiming === 'afternoon' && hour >= 11 && hour < 16) solarKWh = 2.4;
    if (solarTiming === 'morning' && hour >= 5 && hour < 10) solarKWh = 2.4;
    const evening = hour >= 17 && hour < 22;
    const importPrice = smallSpread ? 0.2 + (hour >= 4 ? 0.01 : 0) : (evening ? 0.5 : 0.3);
    return {
      startsAtMs: hour * 3_600_000, durationMs: 3_600_000,
      importPrice: hour < 4 && !smallSpread ? 0.05 + hour * 0.02 : importPrice,
      exportPrice: 0.02,
      householdDemandKWh: 0.2 + (evening ? 1 : 0),
      otherManagedDemandKWh: 0, solarKWh, gridImportLimitKW: 8, maxChargeKW: model.maxChargeKW,
    };
  });
  return { battery: model, periods };
}

function ultimateChargeWindows(horizon) {
  const engine = new UltimatePlanningEngine({ log() {} });
  return engine._computeChargeBlocks({
    pvHourly: horizon.periods.map((period, hour) => ({ hour, pvKwh: period.solarKWh })),
    consumptionHourly: horizon.periods.map((period, hour) => ({
      hour, expectedKwh: period.householdDemandKWh + period.otherManagedDemandKWh,
    })),
    prices: horizon.periods.map((period, hour) => ({ hour, price: period.importPrice, isExpensive: false })),
    evNeededKwh: 0, evMinPowerW: 1_400, evMaxPowerW: 7_400, evCanUseSolar: false,
    batAvailKwh: model.storedEnergyKWh, batMaxKwh: model.capacityKWh, batMaxChargeKw: model.maxChargeKW,
    canNightChargeFromGrid: true, nightStart: 0, nightEnd: 4,
    sunriseH: 5, cheapBlocks: {
      day: { start: 0, end: 4, midpoint: 2, durationH: 4 },
      night: { start: 0, end: 4, midpoint: 2, durationH: 4, segments: [[0, 1, 2, 3]] },
    },
    isDynamic: true, minHour: 0,
    tripTargetSoc: 80, evDefaultSoc: 80, evCapacityKwh: 60, departureH: 7,
    peak1: { start: 7, end: 9 }, peak2: { start: 17, end: 22 },
  }).batBlocks;
}

function replayChargeWindows(horizon, windows) {
  const battery = horizon.battery;
  const efficiency = Math.sqrt(battery.roundTripEfficiency);
  let energy = battery.storedEnergyKWh;
  let energyCost = 0;
  let gridChargedKWh = 0;
  for (const [hour, period] of horizon.periods.entries()) {
    const netDemand = period.householdDemandKWh + period.otherManagedDemandKWh - period.solarKWh;
    const charging = windows.some(window => hour >= window.start && hour < window.end);
    let acEnergy;
    if (charging || netDemand < 0) {
      const chargeLimitKW = Math.min(battery.maxChargeKW, period.maxChargeKW);
      const available = charging ? chargeLimitKW : Math.min(chargeLimitKW, -netDemand);
      acEnergy = Math.min(available, (battery.capacityKWh - energy) / efficiency);
      acEnergy = Math.min(acEnergy, Math.max(0, period.gridImportLimitKW - netDemand));
    } else {
      acEnergy = -Math.min(netDemand, battery.maxDischargeKW,
        Math.max(0, energy - battery.minimumEnergyKWh) * efficiency);
    }
    energy += acEnergy >= 0 ? acEnergy * efficiency : acEnergy / efficiency;
    const grid = netDemand + acEnergy;
    if (grid > period.gridImportLimitKW + 1e-9) throw new Error('Baseline violates the shared grid constraint.');
    energyCost += Math.max(0, grid) * period.importPrice - Math.max(0, -grid) * period.exportPrice
      + Math.max(0, -acEnergy) * battery.wearCostPerKWh;
    gridChargedKWh += Math.min(Math.max(0, acEnergy), Math.max(0, grid));
  }
  return {
    energyCost, objectiveCost: energyCost - Math.max(0, energy - battery.minimumEnergyKWh) * battery.terminalValuePerKWh,
    gridChargedKWh, terminalEnergyKWh: energy,
  };
}

const scenarios = [
  ['Solar before morning demand', makeHorizon('morning')],
  ['Solar after morning demand', makeHorizon('afternoon')],
  ['Cloudy with uneven cheap prices', makeHorizon('none')],
  ['Spread below losses and wear', makeHorizon('none', true)],
];

const results = scenarios.map(([scenario, horizon]) => {
  const windows = ultimateChargeWindows(horizon);
  const baseline = replayChargeWindows(horizon, windows);
  const started = performance.now();
  const plan = planBatteryEnergy(horizon);
  const runtimeMs = performance.now() - started;
  if (plan.status !== 'planned') throw new Error(`Unexpected infeasible scenario: ${scenario}`);
  return {
    scenario,
    baselineMethodObjective: Number(baseline.objectiveCost.toFixed(4)),
    pelsObjective: Number(plan.objectiveCost.toFixed(4)),
    difference: Number((baseline.objectiveCost - plan.objectiveCost).toFixed(4)),
    ultimateGridChargeWindows: windows.map(window => `${window.start}–${window.end}`).join(', ') || 'none',
    pelsRuntimeMs: Number(runtimeMs.toFixed(1)),
  };
});

console.log(JSON.stringify({
  comparison: 'Exact _computeChargeBlocks plus common replay, versus the PELS horizon optimizer',
  sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
  currency: 'fixture currency units; same tariff and terminal value for both',
  scope: 'Deterministic scenario comparison only; excludes full Ultimate EMS dispatch and forecast quality.',
  results,
}, null, 2));
