/**
 * Isolated tracker allocation benchmark; never connects to Homey or writes state.
 * Run from the repo root: node scripts/benchmark-power-tracker.mjs [--ref <git-ref>]
 * Compare the same script and Node version against a fixed base and the worktree.
 * Samples run back-to-back: RSS is a transient footprint, not a production saving.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative } from 'node:path';
import { constants, PerformanceObserver, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const MB = 1024 * 1024;
const SAMPLE_COUNT = 300;
const DEVICE_COUNT = 20;
const { values } = parseArgs({ options: {
  ref: { type: 'string' },
  hours: { type: 'string' },
} });

const createHistory = (hours) => {
  const nowMs = Date.UTC(2026, 8, 14, 12);
  const keys = Array.from({ length: hours }, (_, i) => new Date(nowMs - i * 3600000).toISOString());
  const buckets = () => Object.fromEntries(keys.map((key) => [key, 1]));
  const powers = Object.fromEntries(Array.from({ length: DEVICE_COUNT }, (_, i) => [`device${i}`, 100]));
  return {
    nowMs, powers,
    state: {
      buckets: buckets(), hourlySampleCounts: buckets(), hourlyBudgets: buckets(),
      controlledBuckets: buckets(), uncontrolledBuckets: buckets(), exemptBuckets: buckets(),
      deviceBuckets: Object.fromEntries(Object.keys(powers).map((id) => [id, buckets()])),
      lastTimestamp: nowMs, lastPowerW: 3000, lastControlledPowerW: 2000,
      lastUncontrolledPowerW: 1000, lastExemptPowerW: 0, lastDevicePowerWById: powers,
    },
  };
};

const flushObserver = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

const measure = async (hours) => {
  const require = createRequire(`${process.cwd()}/package.json`);
  const Module = require('node:module');
  const compiled = new Module(`${process.cwd()}/tracker-benchmark.cjs`);
  compiled.filename = `${process.cwd()}/tracker-benchmark.cjs`;
  compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(readFileSync(0, 'utf8'), compiled.filename);
  let minorGc = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGc++;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  const fixture = createHistory(hours);
  let state = fixture.state;
  globalThis.gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  await flushObserver();
  minorGc = 0;
  const before = process.memoryUsage();
  const started = performance.now();
  for (let i = 1; i <= SAMPLE_COUNT; i++) {
    await compiled.exports.recordPowerSample({
      state, currentPowerW: 3000, controlledPowerW: 2000, exemptPowerW: 0,
      currentDevicePowerWById: fixture.powers, nowMs: fixture.nowMs + i * 10000, hourBudgetKWh: 5,
      saveState: (next) => { state = next; }, rebuildPlanFromCache: async () => {},
    });
  }
  const durationMs = performance.now() - started;
  await flushObserver();
  const after = process.memoryUsage();
  observer.disconnect();
  globalThis.gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  const collected = process.memoryUsage();
  console.log(JSON.stringify({
    node: process.version, hours, devices: DEVICE_COUNT, samples: SAMPLE_COUNT,
    durationMs, minorGc, rssBeforeMiB: before.rss / MB, rssAfterMiB: after.rss / MB,
    rssCollectedMiB: collected.rss / MB, heapBeforeMiB: before.heapUsed / MB,
    heapAfterMiB: after.heapUsed / MB, heapCollectedMiB: collected.heapUsed / MB,
    // Keep the final history live through collection, and expose its numerical result.
    finalEnergyKWh: state.buckets[new Date(fixture.nowMs).toISOString()],
  }));
};

const compareHistories = async () => {
  const plugins = values.ref ? [{
    name: 'git-baseline',
    setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, ({ path }) => ({
        contents: execFileSync('git', ['show', `${values.ref}:${relative(process.cwd(), path)}`], {
          encoding: 'utf8', maxBuffer: 10 * MB,
        }),
        loader: 'ts',
      }));
    },
  }] : [];
  const result = await build({
    entryPoints: ['lib/power/tracker.ts'], bundle: true, platform: 'node', format: 'cjs',
    write: false, packages: 'external', logLevel: 'silent', plugins,
  });
  for (const hours of [6, 168, 720]) {
    const child = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--hours', String(hours)], {
      input: result.outputFiles[0].text, encoding: 'utf8',
    });
    process.stdout.write(child.stdout ?? '');
    if (child.status !== 0) throw new Error(child.stderr || `Benchmark worker failed: ${child.signal}`);
  }
};

if (values.hours) await measure(Number(values.hours));
else await compareHistories();
