#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

globalThis.performance = performance;

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');
const { readOptionValue, stripScriptElements } = require('./lib/settingsUiScriptUtils.cjs');

const DEFAULT_ITERATIONS = 7;
const DEFAULT_LATENCIES = [5, 20, 50];
const DEFAULT_TIMEOUT_MS = 15_000;

export const parseArgs = (argv) => {
  const args = {
    baselineDir: null,
    build: false,
    candidateDir: process.cwd(),
    iterations: DEFAULT_ITERATIONS,
    json: false,
    latencies: DEFAULT_LATENCIES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--baseline-dir') {
      args.baselineDir = path.resolve(readOptionValue(argv, index, '--baseline-dir'));
      index += 1;
      continue;
    }
    if (value === '--candidate-dir') {
      args.candidateDir = path.resolve(readOptionValue(argv, index, '--candidate-dir'));
      index += 1;
      continue;
    }
    if (value === '--latencies') {
      args.latencies = readOptionValue(argv, index, '--latencies')
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter(Number.isFinite);
      index += 1;
      continue;
    }
    if (value === '--iterations') {
      args.iterations = Number(readOptionValue(argv, index, '--iterations', ' (expected a number)'));
      index += 1;
      continue;
    }
    if (value === '--build') {
      args.build = true;
      continue;
    }
    if (value === '--json') {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!Number.isInteger(args.iterations) || args.iterations <= 0) {
    throw new Error(`Invalid --iterations value: ${args.iterations}`);
  }

  if (!Array.isArray(args.latencies) || args.latencies.length === 0) {
    throw new Error('No valid latencies supplied');
  }

  return args;
};

const runBuild = (repoDir) => {
  const result = spawnSync('npm', ['run', 'build:settings'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build settings UI in ${repoDir}`);
  }
};

const resolveBuildDir = async (repoDir) => {
  const candidates = [
    path.join(repoDir, 'packages', 'settings-ui', 'dist'),
    path.join(repoDir, 'settings'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, 'index.html'));
      await fs.access(path.join(candidate, 'script.js'));
      return candidate;
    } catch {
      // Try the next location.
    }
  }

  throw new Error(`Could not find built settings UI assets in ${repoDir}`);
};

const deepClone = (value) => (
  value == null ? value : JSON.parse(JSON.stringify(value))
);

const buildFixture = () => {
  const settings = {
    operating_mode: 'home',
    active_mode: 'home',
    capacity_priorities: ['dev_heatpump', 'dev_waterheater'],
    mode_device_targets: {
      home: {
        dev_heatpump: { priority: 1, temperature: 22 },
        dev_waterheater: { priority: 2, temperature: 65 },
      },
      away: {
        dev_heatpump: { priority: 1, temperature: 18 },
        dev_waterheater: { priority: 2, temperature: 55 },
      },
    },
    controllable_devices: {
      dev_heatpump: true,
      dev_waterheater: true,
    },
    managed_devices: {
      dev_heatpump: true,
      dev_waterheater: true,
    },
    mode_aliases: { home: 'Home', away: 'Away' },
    device_plan_snapshot: {
      meta: {
        totalKw: 5.3,
        softLimitKw: 6,
        headroomKw: 0.7,
      },
      devices: [
        {
          id: 'dev_heatpump',
          name: 'Living Room Heat Pump',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 21,
          plannedTarget: 22,
          currentTemperature: 20.3,
          priority: 1,
          controllable: true,
          expectedPowerKw: 1.6,
          measuredPowerKw: 1.2,
          reason: 'Cheap hour, preheating',
        },
        {
          id: 'dev_waterheater',
          name: 'Water Heater',
          currentState: 'on',
          plannedState: 'shed',
          priority: 2,
          controllable: true,
          expectedPowerKw: 2,
          measuredPowerKw: 2.1,
          reason: 'Approaching capacity cap',
        },
      ],
    },
    target_devices_snapshot: [
      {
        id: 'dev_heatpump',
        name: 'Living Room Heat Pump',
        zone: 'Living room',
        class: 'heatpump',
        priority: 1,
        targetTemperature: 22,
        currentTemperature: 20.3,
        capabilities: ['measure_power', 'target_temperature'],
        available: true,
      },
      {
        id: 'dev_waterheater',
        name: 'Water Heater',
        zone: 'Utility room',
        class: 'waterheater',
        priority: 2,
        targetTemperature: 65,
        currentTemperature: 61,
        capabilities: ['measure_power', 'onoff'],
        available: true,
      },
    ],
    power_tracker_state: {
      lastTimestamp: Date.now(),
      lastPowerW: 4300,
      buckets: Object.fromEntries(
        Array.from({ length: 24 }, (_, hour) => [new Date(Date.now() - ((23 - hour) * 3600 * 1000)).toISOString(), 0.4 + ((hour % 5) * 0.08)]),
      ),
      controlledBuckets: {},
      uncontrolledBuckets: {},
      hourlyBudgets: {},
      dailyBudgetCaps: {},
      dailyTotals: {},
      unreliablePeriods: [],
    },
    capacity_limit_kw: 6,
    daily_budget_enabled: true,
    daily_budget_kwh: 12,
    daily_budget_price_shaping_enabled: true,
    daily_budget_controlled_weight: 0.7,
    daily_budget_price_flex_share: 0.3,
    daily_budget_breakdown_enabled: true,
    pels_status: {
      state: 'running',
      updatedAt: new Date().toISOString(),
    },
    app_heartbeat: Date.now(),
    overshoot_behaviors: {},
    price_optimization_settings: {
      dev_heatpump: { enabled: true, cheapDelta: 5, expensiveDelta: -5 },
      dev_waterheater: { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
    },
    price_scheme: 'homey',
    nettleie_fylke: 'Oslo',
    debug_logging_topics: [],
    debug_logging_enabled: false,
    capacity_margin_kw: 0.5,
    norway_price_model: 'spot',
    nettleie_orgnr: '123456789',
    capacity_dry_run: false,
    price_area: 'NO1',
    nettleie_tariffgruppe: 'Husholdning',
    provider_surcharge: 0.05,
    price_threshold_percent: 20,
    price_min_diff_ore: 10,
    price_optimization_enabled: true,
    homey_prices_currency: 'NOK',
    homey_prices_today: Array.from({ length: 24 }, (_, hour) => ({ startsAt: new Date(Date.now() + (hour * 3600 * 1000)).toISOString(), price: 0.8 + ((hour % 6) * 0.1) })),
    homey_prices_tomorrow: Array.from({ length: 24 }, (_, hour) => ({ startsAt: new Date(Date.now() + ((24 + hour) * 3600 * 1000)).toISOString(), price: 0.7 + ((hour % 5) * 0.1) })),
    combined_prices: {
      prices: Array.from({ length: 48 }, (_, hour) => ({
        startsAt: new Date(Date.now() + (hour * 3600 * 1000)).toISOString(),
        total: 60 + ((hour % 6) * 8),
        spotPriceExVat: 48 + ((hour % 6) * 6),
        vatMultiplier: 1.25,
      })),
      priceUnit: 'ore/kWh',
      priceScheme: 'norway',
    },
    nettleie_data: {
      updatedAt: new Date().toISOString(),
      tariffName: 'Standard',
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, cost: 0.2 + ((hour >= 6 && hour <= 22) ? 0.08 : 0.02) })),
    },
  };

  const dailyBudget = {
    dayKey: new Date().toISOString().slice(0, 10),
    timeZone: 'Europe/Oslo',
    nowUtc: new Date().toISOString(),
    currentBucketIndex: new Date().getUTCHours(),
    budget: {
      enabled: true,
      dailyBudgetKWh: 12,
      priceShapingEnabled: true,
    },
    state: {
      usedNowKWh: 3.6,
      allowedNowKWh: 4.1,
      remainingKWh: 8.4,
      deviationKWh: -0.5,
      exceeded: false,
      frozen: false,
      confidence: 0.72,
      priceShapingActive: true,
    },
    buckets: {
      startUtc: Array.from({ length: 24 }, (_, hour) => new Date(Date.now() + (hour * 3600 * 1000)).toISOString()),
      startLocalLabels: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')),
      plannedWeight: Array.from({ length: 24 }, (_, hour) => (hour >= 6 && hour <= 9) || (hour >= 17 && hour <= 21) ? 1.4 : 0.8),
      plannedKWh: Array.from({ length: 24 }, (_, hour) => ((hour >= 6 && hour <= 9) || (hour >= 17 && hour <= 21) ? 0.5 : 0.28)),
      actualKWh: Array.from({ length: 24 }, (_, hour) => (hour <= new Date().getUTCHours() ? 0.3 + ((hour % 4) * 0.05) : null)),
      allowedCumKWh: Array.from({ length: 24 }, (_, hour) => Number(((hour + 1) * 0.45).toFixed(3))),
      price: Array.from({ length: 24 }, (_, hour) => Number((0.8 + ((hour % 6) * 0.1)).toFixed(3))),
    },
  };

  const apiPayloads = {
    'GET /daily_budget': dailyBudget,
    'GET /homey_devices': [
      { id: 'dev_heatpump', name: 'Living Room Heat Pump' },
      { id: 'dev_floorheat', name: 'Bathroom Floor Heat' },
      { id: 'dev_waterheater', name: 'Water Heater' },
      { id: 'dev_evcharger', name: 'EV Charger' },
    ],
    'POST /settings_ui_log': { ok: true },
    'GET /ui_bootstrap': {
      settings,
      dailyBudget,
      devices: settings.target_devices_snapshot,
      plan: settings.device_plan_snapshot,
      power: {
        tracker: settings.power_tracker_state,
        status: {
          lastPowerUpdate: settings.power_tracker_state.lastTimestamp,
          priceLevel: 'normal',
        },
        heartbeat: Date.now(),
      },
      prices: {
        combinedPrices: settings.combined_prices,
        electricityPrices: null,
        priceArea: settings.price_area,
        gridTariffData: settings.nettleie_data,
        flowToday: null,
        flowTomorrow: null,
        homeyCurrency: settings.homey_prices_currency,
        homeyToday: settings.homey_prices_today,
        homeyTomorrow: settings.homey_prices_tomorrow,
      },
    },
    'GET /ui_devices': {
      devices: settings.target_devices_snapshot,
    },
    'GET /ui_plan': {
      plan: settings.device_plan_snapshot,
    },
    'GET /ui_power': {
      tracker: settings.power_tracker_state,
      status: {
        lastPowerUpdate: settings.power_tracker_state.lastTimestamp,
        priceLevel: 'normal',
      },
      heartbeat: Date.now(),
    },
    'GET /ui_prices': {
      combinedPrices: settings.combined_prices,
      electricityPrices: null,
      priceArea: settings.price_area,
      gridTariffData: settings.nettleie_data,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: settings.homey_prices_currency,
      homeyToday: settings.homey_prices_today,
      homeyTomorrow: settings.homey_prices_tomorrow,
    },
  };

  return { apiPayloads, settings };
};

const createCanvasContextStub = () => ({
  canvas: {},
  arc() {},
  arcTo() {},
  beginPath() {},
  bezierCurveTo() {},
  clearRect() {},
  clip() {},
  closePath() {},
  createImageData() {
    return { data: new Uint8ClampedArray(4) };
  },
  createLinearGradient() {
    return { addColorStop() {} };
  },
  createPattern() {
    return {};
  },
  createRadialGradient() {
    return { addColorStop() {} };
  },
  drawImage() {},
  fill() {},
  fillRect() {},
  fillText() {},
  getImageData() {
    return { data: new Uint8ClampedArray(4) };
  },
  getLineDash() {
    return [];
  },
  lineTo() {},
  measureText(text) {
    return { width: String(text).length * 7 };
  },
  moveTo() {},
  putImageData() {},
  quadraticCurveTo() {},
  rect() {},
  resetTransform() {},
  restore() {},
  rotate() {},
  save() {},
  scale() {},
  setLineDash() {},
  setTransform() {},
  stroke() {},
  strokeRect() {},
  strokeText() {},
  transform() {},
  translate() {},
  font: '12px sans-serif',
  globalAlpha: 1,
  textAlign: 'left',
  textBaseline: 'alphabetic',
});

const waitFor = async (check, timeoutMs) => {
  const startedAt = performance.now();
  while (!check()) {
    if ((performance.now() - startedAt) > timeoutMs) {
      throw new Error('Timed out waiting for settings UI readiness');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const getReadyState = (windowObject) => {
  if (windowObject.__PELS_SETTINGS_UI_PERF__?.ready) {
    return true;
  }
  const modeOptions = windowObject.document.getElementById('mode-select')?.options.length || 0;
  const deviceRows = windowObject.document.querySelectorAll('#device-list .device-row').length;
  return modeOptions > 0 && deviceRows > 0;
};

const runSingleIteration = async ({ html, label, latencyMs, scriptSource }) => {
  const { apiPayloads, settings } = buildFixture();
  const getKeyCounts = {};
  const apiPathCounts = {};
  let getCalls = 0;
  let apiCalls = 0;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('warn', () => {});

  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/settings/',
    virtualConsole,
  });

  const { window } = dom;
  window.performance = performance;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(window.performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  };
  window.IntersectionObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  };
  window.matchMedia = () => ({
    addEventListener() {},
    addListener() {},
    dispatchEvent() { return false; },
    matches: false,
    removeEventListener() {},
    removeListener() {},
  });
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => createCanvasContextStub();
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });

  const listeners = new Map();
  const delayResult = (value, callback) => {
    setTimeout(() => callback(null, deepClone(value)), latencyMs);
  };

  const homey = {
    __: (key) => key,
    clock: { getTimezone: () => 'Europe/Oslo' },
    off(event, callback) {
      const handlers = listeners.get(event) || [];
      listeners.set(event, handlers.filter((entry) => entry !== callback));
    },
    on(event, callback) {
      const handlers = listeners.get(event) || [];
      handlers.push(callback);
      listeners.set(event, handlers);
    },
    ready: async () => {},
    get(key, callback) {
      getCalls += 1;
      getKeyCounts[key] = (getKeyCounts[key] || 0) + 1;
      delayResult(settings[key], callback);
    },
    set(key, value, callback) {
      settings[key] = deepClone(value);
      setTimeout(() => callback(null), latencyMs);
    },
    api(method, uri, bodyOrCallback, callbackMaybe) {
      apiCalls += 1;
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : callbackMaybe;
      const routeKey = `${String(method).toUpperCase()} ${uri}`;
      apiPathCounts[routeKey] = (apiPathCounts[routeKey] || 0) + 1;
      if (typeof callback !== 'function') {
        throw new Error(`Missing callback for ${routeKey}`);
      }
      if (!(routeKey in apiPayloads)) {
        setTimeout(() => callback(new Error(`${label}: no mock for ${routeKey}`)), latencyMs);
        return;
      }
      delayResult(apiPayloads[routeKey], callback);
    },
  };

  window.Homey = homey;

  const startedAt = performance.now();
  window.eval(scriptSource);
  await waitFor(() => getReadyState(window), DEFAULT_TIMEOUT_MS);
  const bootMs = performance.now() - startedAt;
  const perfSnapshot = deepClone(window.__PELS_SETTINGS_UI_PERF__ || null);
  dom.window.close();

  return {
    apiCalls,
    apiPathCounts,
    bootMs,
    getCalls,
    getKeyCounts,
    perfSnapshot,
    roundTrips: getCalls + apiCalls,
  };
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const average = (values) => (
  values.reduce((sum, value) => sum + value, 0) / values.length
);

const runScenario = async ({ html, iterations, label, latencyMs, scriptSource }) => {
  const runs = [];
  for (let index = 0; index < iterations; index += 1) {
    runs.push(await runSingleIteration({ html, label, latencyMs, scriptSource }));
  }

  return {
    avgApiCalls: Number(average(runs.map((run) => run.apiCalls)).toFixed(1)),
    avgBootMs: Number(average(runs.map((run) => run.bootMs)).toFixed(1)),
    avgGetCalls: Number(average(runs.map((run) => run.getCalls)).toFixed(1)),
    avgRoundTrips: Number(average(runs.map((run) => run.roundTrips)).toFixed(1)),
    medianBootMs: Number(median(runs.map((run) => run.bootMs)).toFixed(1)),
    perfSnapshot: runs[0].perfSnapshot,
    sampleApiPaths: runs[0].apiPathCounts,
    sampleGetKeys: runs[0].getKeyCounts,
  };
};

const readBundle = async (repoDir) => {
  const buildDir = await resolveBuildDir(repoDir);
  const [html, scriptSource] = await Promise.all([
    fs.readFile(path.join(buildDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(buildDir, 'script.js'), 'utf8'),
  ]);
  return {
    html: stripScriptElements(html),
    scriptSource,
  };
};

const printResults = ({ baselineLabel, candidateLabel, results }) => {
  for (const [latency, row] of Object.entries(results)) {
    console.log(`Latency ${latency}ms`);
    console.log(`  ${baselineLabel}: ${row.baseline.avgBootMs}ms avg, ${row.baseline.avgRoundTrips} round-trips`);
    console.log(`  ${candidateLabel}: ${row.candidate.avgBootMs}ms avg, ${row.candidate.avgRoundTrips} round-trips`);
    const savedMs = row.baseline.avgBootMs - row.candidate.avgBootMs;
    const improvementPct = row.baseline.avgBootMs > 0
      ? ((savedMs / row.baseline.avgBootMs) * 100)
      : 0;
    console.log(`  delta: ${savedMs.toFixed(1)}ms (${improvementPct.toFixed(1)}% faster)`);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baselineDir) {
    throw new Error('Missing required --baseline-dir');
  }

  if (args.build) {
    runBuild(args.baselineDir);
    runBuild(args.candidateDir);
  }

  const [baselineBundle, candidateBundle] = await Promise.all([
    readBundle(args.baselineDir),
    readBundle(args.candidateDir),
  ]);

  const results = {};
  for (const latencyMs of args.latencies) {
    results[latencyMs] = {
      baseline: await runScenario({
        html: baselineBundle.html,
        iterations: args.iterations,
        label: 'baseline',
        latencyMs,
        scriptSource: baselineBundle.scriptSource,
      }),
      candidate: await runScenario({
        html: candidateBundle.html,
        iterations: args.iterations,
        label: 'candidate',
        latencyMs,
        scriptSource: candidateBundle.scriptSource,
      }),
    };
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  printResults({
    baselineLabel: path.basename(args.baselineDir),
    candidateLabel: path.basename(args.candidateDir),
    results,
  });
};

const isMainModule = () => {
  const entry = process.argv[1];
  return typeof entry === 'string' && pathToFileURL(entry).href === import.meta.url;
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
