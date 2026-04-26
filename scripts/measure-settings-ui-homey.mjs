#!/usr/bin/env node

import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { SETTINGS_UI_BOOTSTRAP_KEYS } = require('./lib/settingsUiBootstrapKeys.cjs');
const { readOptionValue } = require('./lib/settingsUiScriptUtils.cjs');

const DEFAULT_APP_ID = 'com.barelysufficient.pels';
const DEFAULT_ITERATIONS = 3;
const DEFAULT_VIEWPORT = { width: 480, height: 900 };
const ATHOM_CLI_SETTINGS_PATH = path.join(process.env.HOME || '', '.athom-cli', 'settings.json');
const DEFAULT_OVERVIEW_REDESIGN_TOGGLE_HOMEY_ID_HASHES = new Set([
  '3c9207efba429629030489371722f72f8e96bff1cf8c106c304bb1f055e22a8b',
  '4e57091f5b42550e7bf53b206cf5ffa4b548b40aad7d3a1999e4ebf7677abd4b',
]);

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export const parseArgs = (argv) => {
  const args = {
    appId: DEFAULT_APP_ID,
    baselineDir: null,
    build: false,
    candidateDir: process.cwd(),
    headed: false,
    homeyId: null,
    iterations: DEFAULT_ITERATIONS,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app-id') {
      args.appId = readOptionValue(argv, index, '--app-id');
      index += 1;
      continue;
    }
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
    if (value === '--homey-id') {
      args.homeyId = readOptionValue(argv, index, '--homey-id');
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
    if (value === '--headed') {
      args.headed = true;
      continue;
    }
    if (value === '--json') {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!args.baselineDir) {
    throw new Error('Missing required --baseline-dir');
  }
  if (!Number.isInteger(args.iterations) || args.iterations <= 0) {
    throw new Error(`Invalid --iterations value: ${args.iterations}`);
  }

  return args;
};

const deepClone = (value) => (
  value == null ? value : JSON.parse(JSON.stringify(value))
);

const getAllowedOverviewRedesignHomeyIdHashes = () => {
  const hashes = new Set(DEFAULT_OVERVIEW_REDESIGN_TOGGLE_HOMEY_ID_HASHES);
  const raw = String(process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES ?? '');
  raw.split(',').forEach((value) => {
    const trimmed = value.trim();
    if (trimmed) hashes.add(trimmed);
  });
  return hashes;
};

const hashHomeyId = (homeyId) => (
  createHash('sha256').update(homeyId).digest('hex')
);

const getFeatureAccess = (homeyId) => ({
  canToggleOverviewRedesign: typeof homeyId === 'string'
    && getAllowedOverviewRedesignHomeyIdHashes().has(hashHomeyId(homeyId)),
});

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
      // Try the next candidate.
    }
  }
  throw new Error(`Could not find built settings UI assets in ${repoDir}`);
};

const getContentType = (filePath) => (
  CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream'
);

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const send = (res, statusCode, payload, contentType = 'application/json; charset=utf-8') => {
  const body = Buffer.isBuffer(payload)
    ? payload
    : contentType.includes('application/json')
      ? Buffer.from(JSON.stringify(payload))
      : Buffer.from(String(payload));
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  res.end(body);
};

const createStats = () => ({
  homeyOps: {},
  proxyPaths: {},
  proxyRequests: 0,
});

const recordCount = (map, key, value = 1) => {
  map[key] = (map[key] || 0) + value;
};

const createHomeyContext = async ({ appId, homeyId }) => {
  let homeyApiModule;
  try {
    homeyApiModule = require('homey-api');
  } catch {
    throw new Error(
      'homey-api is required for this benchmarking script but is not installed. '
      + 'Install it with: npm install --no-save homey-api',
    );
  }
  const { AthomCloudAPI, HomeyAPI } = homeyApiModule;
  const cliSettings = JSON.parse(await fs.readFile(ATHOM_CLI_SETTINGS_PATH, 'utf8'));
  const selectedHomeyId = homeyId || cliSettings.activeHomey?.id;
  if (!selectedHomeyId) {
    throw new Error('No active Homey found. Run `homey select` or pass --homey-id.');
  }

  const homeySession = cliSettings.homeyApi?.[`homey-${selectedHomeyId}`]?.session;
  const clientId = homeySession?.clientId;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('Could not read Homey CLI clientId from ~/.athom-cli/settings.json');
  }

  const cloudApi = new AthomCloudAPI({
    autoRefreshTokens: false,
    clientId,
    token: new AthomCloudAPI.Token(cliSettings.homeyApi.token),
  });

  const user = await cloudApi.getAuthenticatedUser();
  const homey = await user.getHomeyById(selectedHomeyId);
  const homeyApi = await homey.authenticate({
    strategy: [
      HomeyAPI.DISCOVERY_STRATEGIES.LOCAL_SECURE,
      HomeyAPI.DISCOVERY_STRATEGIES.LOCAL,
      HomeyAPI.DISCOVERY_STRATEGIES.CLOUD,
    ],
  });
  const app = await homeyApi.apps.getApp({ id: appId });
  const stats = createStats();

  const recordAsync = async (name, work) => {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      const totalMs = performance.now() - startedAt;
      const current = stats.homeyOps[name] || { count: 0, totalMs: 0 };
      current.count += 1;
      current.totalMs += totalMs;
      stats.homeyOps[name] = current;
    }
  };

  const getAllSettings = async () => (
    recordAsync('getAppSettings', async () => homeyApi.apps.getAppSettings({ id: appId }))
  );

  const getSetting = async (key) => (
    recordAsync(`getAppSetting:${key}`, async () => homeyApi.apps.getAppSetting({ id: appId, name: key }))
  );

  const setSetting = async (key, value) => (
    recordAsync(`setAppSetting:${key}`, async () => {
      await homeyApi.apps.setAppSetting({ id: appId, name: key, value });
      return null;
    })
  );

  const callInstalledAppApi = async (method, uri, body) => {
    const normalizedMethod = String(method).toUpperCase();
    const opName = `appApi:${normalizedMethod} ${uri}`;
    return recordAsync(opName, async () => {
      if (normalizedMethod === 'GET') {
        return app.get({ path: uri });
      }
      if (normalizedMethod === 'POST') {
        return app.post({ path: uri, body: body ?? {} });
      }
      if (normalizedMethod === 'PUT') {
        return app.put({ path: uri, body: body ?? {} });
      }
      if (normalizedMethod === 'DELETE') {
        return app.delete({ path: uri });
      }
      throw new Error(`Unsupported app API method: ${normalizedMethod}`);
    });
  };

  const getArraySetting = (allSettings, key) => (
    Array.isArray(allSettings[key]) ? allSettings[key] : []
  );

  const buildPowerPayload = (allSettings) => {
    const tracker = allSettings.power_tracker_state;
    const status = allSettings.pels_status;
    const heartbeat = allSettings.app_heartbeat;
    return {
      heartbeat: typeof heartbeat === 'number' ? heartbeat : null,
      status: status && typeof status === 'object' ? status : null,
      tracker: tracker && typeof tracker === 'object' ? tracker : null,
    };
  };

  const buildPricesPayload = (allSettings) => {
    const priceArea = allSettings.price_area;
    const homeyCurrency = allSettings.homey_prices_currency;
    return {
      combinedPrices: allSettings.combined_prices ?? null,
      electricityPrices: allSettings.electricity_prices ?? null,
      flowToday: allSettings.flow_prices_today ?? null,
      flowTomorrow: allSettings.flow_prices_tomorrow ?? null,
      gridTariffData: allSettings.nettleie_data ?? null,
      homeyCurrency: typeof homeyCurrency === 'string' ? homeyCurrency : null,
      homeyToday: allSettings.homey_prices_today ?? null,
      homeyTomorrow: allSettings.homey_prices_tomorrow ?? null,
      priceArea: typeof priceArea === 'string' ? priceArea : null,
    };
  };

  const getDailyBudgetPayload = async () => {
    try {
      return await callInstalledAppApi('GET', '/daily_budget');
    } catch {
      return null;
    }
  };

  const buildUiBootstrap = async () => {
    const [allSettings, dailyBudget] = await Promise.all([
      getAllSettings(),
      getDailyBudgetPayload(),
    ]);
    const settings = Object.fromEntries(
      SETTINGS_UI_BOOTSTRAP_KEYS.map((key) => [key, allSettings[key]]),
    );
    const plan = allSettings.device_plan_snapshot;
    return {
      dailyBudget,
      featureAccess: getFeatureAccess(selectedHomeyId),
      devices: getArraySetting(allSettings, 'target_devices_snapshot'),
      plan: plan && typeof plan === 'object' ? plan : null,
      power: buildPowerPayload(allSettings),
      prices: buildPricesPayload(allSettings),
      settings,
    };
  };

  return {
    destroy: async () => {
      await homeyApi.destroy();
    },
    getStats: () => deepClone(stats),
    getTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    handleAppApi: async (method, uri, body) => {
      const normalizedMethod = String(method).toUpperCase();
      if (normalizedMethod === 'GET' && uri === '/ui_bootstrap') {
        return buildUiBootstrap();
      }
      if (normalizedMethod === 'GET' && uri === '/ui_devices') {
        const allSettings = await getAllSettings();
        return { devices: getArraySetting(allSettings, 'target_devices_snapshot') };
      }
      if (normalizedMethod === 'GET' && uri === '/ui_plan') {
        const allSettings = await getAllSettings();
        const plan = allSettings.device_plan_snapshot;
        return { plan: plan && typeof plan === 'object' ? plan : null };
      }
      if (normalizedMethod === 'GET' && uri === '/ui_power') {
        const allSettings = await getAllSettings();
        return buildPowerPayload(allSettings);
      }
      if (normalizedMethod === 'GET' && uri === '/ui_prices') {
        const allSettings = await getAllSettings();
        return buildPricesPayload(allSettings);
      }
      if (normalizedMethod === 'POST' && uri === '/settings_ui_log') {
        return { ok: true };
      }
      return callInstalledAppApi(normalizedMethod, uri, body);
    },
    readSetting: getSetting,
    resetStats: () => {
      stats.proxyRequests = 0;
      stats.proxyPaths = {};
      stats.homeyOps = {};
    },
    setSetting,
    stats,
  };
};

const createHomeyShim = (timeZone) => `
(() => {
  const listeners = Object.create(null);

  const emit = (event, ...args) => {
    const callbacks = listeners[event];
    if (!Array.isArray(callbacks)) return;
    callbacks.forEach((callback) => {
      try {
        callback(...args);
      } catch (error) {
        console.error('homey.js listener error', event, error);
      }
    });
  };

  const request = async (method, url, body) => {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const payload = await response.json();
        if (payload && typeof payload.error === 'string') {
          message = payload.error;
        }
      } catch {
        // Ignore invalid JSON error bodies.
      }
      throw new Error(message || 'Homey proxy request failed');
    }

    if (response.status === 204) return undefined;
    return response.json();
  };

  const toCallback = (promise, callback, onSuccess) => {
    promise
      .then((value) => {
        if (typeof onSuccess === 'function') {
          onSuccess(value);
        }
        if (typeof callback === 'function') {
          callback(null, value);
        }
      })
      .catch((error) => {
        if (typeof callback === 'function') {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      });
  };

  window.Homey = {
    __: (key) => key,
    alert: () => {},
    clock: {
      getTimezone: () => ${JSON.stringify(timeZone)},
    },
    confirm: async () => true,
    emit,
    get: (key, callback) => {
      toCallback(
        request('GET', '/__homey/settings/' + encodeURIComponent(key)),
        callback,
      );
    },
    off: (event, callback) => {
      const callbacks = listeners[event];
      if (!Array.isArray(callbacks)) return;
      listeners[event] = callbacks.filter((entry) => entry !== callback);
    },
    on: (event, callback) => {
      if (!Array.isArray(listeners[event])) listeners[event] = [];
      listeners[event].push(callback);
    },
    popup: async () => {},
    ready: async () => {},
    set: (key, value, callback) => {
      toCallback(
        request('PUT', '/__homey/settings/' + encodeURIComponent(key), { value }),
        callback,
        () => emit('settings.set', key),
      );
    },
    api: (method, uri, bodyOrCallback, callbackMaybe) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : callbackMaybe;
      const body = typeof bodyOrCallback === 'function' ? undefined : bodyOrCallback;
      toCallback(
        request('POST', '/__homey/api', { method, uri, body }),
        callback,
      );
    },
  };
})();
`;

const createServer = ({ homeyContext, initialBuildDir }) => {
  const state = {
    buildDir: initialBuildDir,
    timeZone: homeyContext.getTimezone(),
  };

  const resolveStaticPath = async (pathname) => {
    if (pathname === '/') {
      return path.join(state.buildDir, 'index.html');
    }
    const relativePath = pathname.replace(/^\/+/, '');
    const candidate = path.resolve(state.buildDir, relativePath);
    const relative = path.relative(state.buildDir, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return candidate;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/__homey/')) {
      recordCount(homeyContext.stats.proxyPaths, `${req.method} ${pathname}`);
      homeyContext.stats.proxyRequests += 1;
    }

    try {
      if (pathname === '/homey.js' && req.method === 'GET') {
        send(res, 200, createHomeyShim(state.timeZone), 'application/javascript; charset=utf-8');
        return;
      }

      if (pathname.startsWith('/__homey/settings/')) {
        const key = pathname.slice('/__homey/settings/'.length);
        if (req.method === 'GET') {
          const value = await homeyContext.readSetting(key);
          send(res, 200, value);
          return;
        }
        if (req.method === 'PUT') {
          const payload = await readJsonBody(req);
          await homeyContext.setSetting(key, payload?.value);
          send(res, 200, { ok: true });
          return;
        }
        send(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      if (pathname === '/__homey/api' && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const result = await homeyContext.handleAppApi(payload?.method, payload?.uri, payload?.body);
        send(res, 200, result);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'Method Not Allowed' });
        return;
      }

      const filePath = await resolveStaticPath(pathname);
      if (!filePath) {
        send(res, 403, { error: 'Forbidden' });
        return;
      }

      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': getContentType(filePath),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(data);
    } catch (error) {
      console.error('Local measurement proxy error:', error instanceof Error ? error.message : String(error));
      send(res, 500, { error: 'Internal Server Error' });
    }
  });

  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
    listen: async () => {
      await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Could not determine local server address');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    setBuildDir: (buildDir) => {
      state.buildDir = buildDir;
    },
  };
};

const average = (values) => (
  values.reduce((sum, value) => sum + value, 0) / values.length
);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const sumHomeyOps = (homeyOps) => (
  Object.values(homeyOps).reduce((sum, entry) => sum + entry.count, 0)
);

const waitForSettingsUi = async (page) => {
  await page.waitForFunction(
    () => (
      globalThis.document.documentElement.dataset.settingsUiReady === 'true'
      || globalThis.window.__PELS_SETTINGS_UI_PERF__?.ready === true
      || (
        (globalThis.document.getElementById('mode-select')?.options.length || 0) > 0
        && globalThis.document.querySelectorAll('#device-list .device-row').length > 0
      )
    ),
    { timeout: 30_000 },
  );
};

const measureScenario = async ({ baseUrl, browser, homeyContext, iterations }) => {
  const runs = [];

  for (let index = 0; index < iterations; index += 1) {
    homeyContext.resetStats();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: DEFAULT_VIEWPORT,
    });
    const page = await context.newPage();

    const startedAt = performance.now();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForSettingsUi(page);
    await page.waitForTimeout(150);
    const pageReadyMs = performance.now() - startedAt;
    const pageSnapshot = await page.evaluate(() => ({
      deviceRows: globalThis.document.querySelectorAll('#device-list .device-row').length,
      modeOptions: globalThis.document.getElementById('mode-select')?.options.length || 0,
      perf: globalThis.window.__PELS_SETTINGS_UI_PERF__ ?? null,
    }));
    const serverStats = homeyContext.getStats();
    runs.push({
      pageReadyMs,
      pageSnapshot,
      serverStats,
    });

    await context.close();
  }

  return {
    avgBrowserHomeyApiCalls: Number(average(runs.map((run) => run.pageSnapshot.perf?.homey?.apiCalls ?? 0)).toFixed(1)),
    avgBrowserHomeyGetCalls: Number(average(runs.map((run) => run.pageSnapshot.perf?.homey?.getCalls ?? 0)).toFixed(1)),
    avgPageReadyMs: Number(average(runs.map((run) => run.pageReadyMs)).toFixed(1)),
    avgProxyRequests: Number(average(runs.map((run) => run.serverStats.proxyRequests)).toFixed(1)),
    avgRealHomeyOps: Number(average(runs.map((run) => sumHomeyOps(run.serverStats.homeyOps))).toFixed(1)),
    avgUiBootMs: Number(average(runs.map((run) => run.pageSnapshot.perf?.measures?.['boot:total'] ?? run.pageReadyMs)).toFixed(1)),
    medianPageReadyMs: Number(median(runs.map((run) => run.pageReadyMs)).toFixed(1)),
    sampleBrowserPerf: runs[0].pageSnapshot.perf,
    sampleProxyPaths: runs[0].serverStats.proxyPaths,
    sampleRealHomeyOps: runs[0].serverStats.homeyOps,
  };
};

const printResults = ({ results }) => {
  for (const [label, result] of Object.entries(results)) {
    console.log(label);
    console.log(`  page ready: ${result.avgPageReadyMs}ms avg (${result.medianPageReadyMs}ms median)`);
    console.log(`  ui boot total: ${result.avgUiBootMs}ms avg`);
    console.log(`  browser Homey calls: get=${result.avgBrowserHomeyGetCalls}, api=${result.avgBrowserHomeyApiCalls}`);
    console.log(`  proxy requests: ${result.avgProxyRequests}`);
    console.log(`  real Homey ops behind proxy: ${result.avgRealHomeyOps}`);
  }

  const baseline = results.baseline;
  const candidate = results.candidate;
  if (!baseline || !candidate) return;

  const pageDeltaMs = baseline.avgPageReadyMs - candidate.avgPageReadyMs;
  const pageDeltaPct = baseline.avgPageReadyMs > 0 ? (pageDeltaMs / baseline.avgPageReadyMs) * 100 : 0;
  console.log(`delta`);
  console.log(`  page ready: ${pageDeltaMs.toFixed(1)}ms (${pageDeltaPct.toFixed(1)}% faster)`);
  console.log(`  proxy requests: ${baseline.avgProxyRequests} -> ${candidate.avgProxyRequests}`);
  console.log(`  real Homey ops: ${baseline.avgRealHomeyOps} -> ${candidate.avgRealHomeyOps}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.build) {
    runBuild(args.baselineDir);
    runBuild(args.candidateDir);
  }

  const [baselineBuildDir, candidateBuildDir] = await Promise.all([
    resolveBuildDir(args.baselineDir),
    resolveBuildDir(args.candidateDir),
  ]);

  const homeyContext = await createHomeyContext({
    appId: args.appId,
    homeyId: args.homeyId,
  });

  const server = createServer({
    homeyContext,
    initialBuildDir: baselineBuildDir,
  });
  const baseUrl = await server.listen();
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({
    headless: !args.headed,
  });

  try {
    const results = {};

    server.setBuildDir(baselineBuildDir);
    results.baseline = await measureScenario({
      baseUrl,
      browser,
      homeyContext,
      iterations: args.iterations,
    });

    server.setBuildDir(candidateBuildDir);
    results.candidate = await measureScenario({
      baseUrl,
      browser,
      homeyContext,
      iterations: args.iterations,
    });

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    printResults({ results });
  } finally {
    await browser.close();
    await server.close();
    await homeyContext.destroy();
  }
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
