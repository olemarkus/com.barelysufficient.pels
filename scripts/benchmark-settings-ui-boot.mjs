#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

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

const runSingleIteration = async ({ html, latencyMs, scriptSource }) => {
  const homeyStubSource = await fs.readFile(
    new URL('../packages/settings-ui/tests/e2e/fixtures/homey.stub.js', import.meta.url),
    'utf8',
  );
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
  window.HTMLElement.prototype.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom does not implement the form-associated APIs used by Material controls.
  window.ElementInternals.prototype.setFormValue = () => {};
  window.ElementInternals.prototype.setValidity = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => createCanvasContextStub();
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });

  window.__PELS_HOMEY_STUB__ = { latencyMs };
  window.eval(homeyStubSource);
  const homey = window.Homey;
  const get = homey.get.bind(homey);
  const api = homey.api.bind(homey);
  homey.get = (key, callback) => {
    getCalls += 1;
    getKeyCounts[key] = (getKeyCounts[key] || 0) + 1;
    return get(key, callback);
  };
  homey.api = (method, uri, ...args) => {
    apiCalls += 1;
    const routeKey = `${String(method).toUpperCase()} ${uri}`;
    apiPathCounts[routeKey] = (apiPathCounts[routeKey] || 0) + 1;
    return api(method, uri, ...args);
  };

  try {
    const startedAt = performance.now();
    window.eval(scriptSource);
    await waitFor(() => getReadyState(window), DEFAULT_TIMEOUT_MS);
    return {
      apiCalls,
      apiPathCounts,
      bootMs: performance.now() - startedAt,
      getCalls,
      getKeyCounts,
      perfSnapshot: deepClone(window.__PELS_SETTINGS_UI_PERF__ || null),
      roundTrips: getCalls + apiCalls,
    };
  } finally {
    dom.window.close();
  }
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const average = (values) => (
  values.reduce((sum, value) => sum + value, 0) / values.length
);

const runScenario = async ({ html, iterations, latencyMs, scriptSource }) => {
  const runs = [];
  for (let index = 0; index < iterations; index += 1) {
    runs.push(await runSingleIteration({ html, latencyMs, scriptSource }));
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
        latencyMs,
        scriptSource: baselineBundle.scriptSource,
      }),
      candidate: await runScenario({
        html: candidateBundle.html,
        iterations: args.iterations,
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
