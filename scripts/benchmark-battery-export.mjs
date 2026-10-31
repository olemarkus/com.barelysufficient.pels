#!/usr/bin/env node

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PERIOD_COUNT = 192;
const PERIOD_MS = 15 * 60_000;
const WARMUP_RUNS = 1;
const SAMPLE_RUNS = 3;

// Bundle only the pure economic planner; no app setup, SDK or actuator executes.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../lib/battery/planning/planBatteryEnergy.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
const { planBatteryEnergy, compareBatteryExportEconomics } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

function createHorizon(capacityKWh, maxPowerKW) {
  const startsAtMs = Date.UTC(2026, 9, 25);
  return {
    battery: {
      capacityKWh,
      storedEnergyKWh: capacityKWh * 0.5,
      minimumEnergyKWh: capacityKWh * 0.2,
      maxChargeKW: maxPowerKW,
      maxDischargeKW: maxPowerKW,
      roundTripEfficiency: 0.9,
      wearCostPerKWh: 0.02,
      terminalValuePerKWh: 0.08,
    },
    periods: Array.from({ length: PERIOD_COUNT }, (_, index) => {
      const hour = Math.floor(index / 4) % 24;
      const cheap = hour < 6;
      const expensive = hour >= 17 && hour < 21;
      return {
        startsAtMs: startsAtMs + index * PERIOD_MS,
        durationMs: PERIOD_MS,
        importPrice: cheap ? 0.1 : (expensive ? 0.45 : 0.22),
        exportPrice: cheap ? 0.06 : (expensive ? 0.32 : 0.1),
        householdDemandKWh: (expensive ? 1.2 : 0.6) / 4,
        otherManagedDemandKWh: hour >= 6 && hour < 8 ? 0.4 / 4 : 0,
        solarKWh: hour >= 10 && hour < 15 ? 3 / 4 : 0,
        gridImportLimitKW: maxPowerKW + 2,
        maxChargeKW: maxPowerKW,
      };
    }),
  };
}

function measureSolve(horizon) {
  const startedAt = performance.now();
  const baseline = planBatteryEnergy(horizon);
  const baselineMs = performance.now() - startedAt;
  assert.equal(baseline.status, 'planned', 'Benchmark baseline must be feasible');
  const candidateStartedAt = performance.now();
  const comparison = compareBatteryExportEconomics(horizon, {
    kind: 'price_export', netExportCeilingKW: horizon.battery.maxDischargeKW,
  }, baseline);
  const candidateMs = performance.now() - candidateStartedAt;
  assert.equal(comparison.kind, 'compared', 'Relaxed candidate must preserve baseline feasibility');
  assert.equal(comparison.terminalEnergyKWh, baseline.terminalEnergyKWh);
  return { baselineMs, candidateMs };
}

function durations(samples) {
  const ordered = samples.toSorted((left, right) => left - right);
  return { samplesMs: samples, medianMs: ordered[Math.floor(ordered.length / 2)], maxMs: ordered.at(-1) };
}

function benchmark(name, horizon) {
  for (let run = 0; run < WARMUP_RUNS; run += 1) measureSolve(horizon);
  const memoryBefore = process.memoryUsage();
  const samples = Array.from({ length: SAMPLE_RUNS }, () => measureSolve(horizon));
  const memoryAfter = process.memoryUsage();
  return {
    name,
    periodCount: horizon.periods.length,
    periodMinutes: PERIOD_MS / 60_000,
    horizonHours: horizon.periods.length * PERIOD_MS / 3_600_000,
    capacityKWh: horizon.battery.capacityKWh,
    maxPowerKW: horizon.battery.maxDischargeKW,
    baseline: durations(samples.map(sample => sample.baselineMs)),
    candidate: durations(samples.map(sample => sample.candidateMs)),
    combined: durations(samples.map(sample => sample.baselineMs + sample.candidateMs)),
    memorySnapshots: {
      note: 'Process snapshots around measured runs; not peak usage, with no forced garbage collection.',
      heapUsedBeforeBytes: memoryBefore.heapUsed,
      heapUsedAfterBytes: memoryAfter.heapUsed,
      rssBeforeBytes: memoryBefore.rss,
      rssAfterBytes: memoryAfter.rss,
    },
  };
}

console.log(JSON.stringify({
  benchmark: 'battery_export_economics',
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  warmupRuns: WARMUP_RUNS,
  sampleRuns: SAMPLE_RUNS,
  scenarios: [
    benchmark('household_10kwh_2.5kw', createHorizon(10, 2.5)),
    benchmark('broad_reach_stress_2kwh_12kw', createHorizon(2, 12)),
  ],
}, null, 2));
