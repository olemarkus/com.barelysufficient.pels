import { startCpuSpikeMonitor } from '../lib/utils/cpuSpikeMonitor';
import { getPerfSnapshot, type PerfSnapshot } from '../lib/utils/perfCounters';
import {
  MockDevice,
  MockDriver,
  mockHomeyApiInstance,
  mockHomeyInstance,
  setMockDrivers,
} from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';

const wait = async (ms: number): Promise<void> => (
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  })
);

const readDurationTotal = (snapshot: PerfSnapshot, key: string): number => (
  snapshot.durations[key]?.totalMs ?? 0
);

const buildHeavyDriverFixture = (count: number): Record<string, MockDriver> => {
  const heatDevices: MockDevice[] = [];
  const socketDevices: MockDevice[] = [];
  for (let index = 0; index < count; index += 1) {
    const device = new MockDevice(
      `dev-${index}`,
      `Device ${index}`,
      index % 2 === 0 ? ['target_temperature'] : ['onoff'],
      index % 2 === 0 ? 'heater' : 'socket',
    );
    if (index % 2 === 0) {
      heatDevices.push(device);
    } else {
      socketDevices.push(device);
    }
  }
  return {
    heating: new MockDriver('heating', heatDevices),
    sockets: new MockDriver('sockets', socketDevices),
  };
};

const buildLargeCachedSnapshot = (count: number): unknown[] => (
  Array.from({ length: count }, (_, index) => ({
    id: `cached-${index}`,
    name: `Cached Device ${index}`,
    priority: (index % 7) + 1,
    controllable: true,
    managed: true,
    caps: ['target_temperature', 'measure_power'],
    targets: [{ id: 'target_temperature', value: 20 + (index % 4), unit: 'C' }],
    measuredPowerKw: (index % 10) / 10,
    expectedPowerKw: ((index + 3) % 10) / 10,
    meta: {
      zone: `zone-${index % 12}`,
      aliases: Array.from({ length: 4 }, (__, entryIndex) => `alias-${index}-${entryIndex}`),
    },
  }))
);

const buildPowerTrackerHistory = (hours: number): {
  lastTimestamp: number;
  lastPowerW: number;
  buckets: Record<string, number>;
  controlledBuckets: Record<string, number>;
  uncontrolledBuckets: Record<string, number>;
  hourlyBudgets: Record<string, number>;
  dailyBudgetCaps: Record<string, number>;
} => {
  const nowMs = Date.now();
  const hourMs = 60 * 60 * 1000;
  const buckets: Record<string, number> = {};
  const controlledBuckets: Record<string, number> = {};
  const uncontrolledBuckets: Record<string, number> = {};
  const hourlyBudgets: Record<string, number> = {};
  const dailyBudgetCaps: Record<string, number> = {};

  for (let index = 0; index < hours; index += 1) {
    const ts = nowMs - ((hours - index) * hourMs);
    const key = new Date(ts - (ts % hourMs)).toISOString();
    const total = 0.4 + ((index % 7) * 0.05);
    const controlled = total * (0.45 + ((index % 3) * 0.1));
    buckets[key] = total;
    controlledBuckets[key] = controlled;
    uncontrolledBuckets[key] = Math.max(0, total - controlled);
    hourlyBudgets[key] = 0.8 + ((index % 5) * 0.1);
    dailyBudgetCaps[key] = 0.7 + ((index % 4) * 0.08);
  }

  return {
    lastTimestamp: nowMs,
    lastPowerW: 4300,
    buckets,
    controlledBuckets,
    uncontrolledBuckets,
    hourlyBudgets,
    dailyBudgetCaps,
  };
};

const captureStartupMetrics = async (params: {
  deviceCount: number;
  historyHours: number;
}): Promise<{
  onInitMs: number;
  maxCpuPct: number;
  maxWallMs: number;
  deviceFetchMs: number;
  deviceRefreshMs: number;
  dailyBudgetUpdateMs: number;
}> => {
  const { deviceCount, historyHours } = params;
  await cleanupApps();
  mockHomeyInstance.settings.removeAllListeners();
  mockHomeyInstance.settings.clear();
  setMockDrivers(buildHeavyDriverFixture(deviceCount));
  mockHomeyInstance.settings.set('price_scheme', 'flow');
  mockHomeyInstance.settings.set('daily_budget_enabled', true);
  mockHomeyInstance.settings.set('daily_budget_kwh', 120);
  mockHomeyInstance.settings.set('daily_budget_price_shaping_enabled', true);
  mockHomeyInstance.settings.set('target_devices_snapshot', buildLargeCachedSnapshot(deviceCount));
  mockHomeyInstance.settings.set('power_tracker_state', buildPowerTrackerHistory(historyHours));

  const cpuSamples: Array<{ cpuPct: number; wallMs: number }> = [];
  const stopMonitor = startCpuSpikeMonitor({
    log: (...args: unknown[]) => {
      const line = args.map((entry) => String(entry)).join(' ');
      if (!line.includes('[perf] cpu spike cpu=')) return;
      const match = line.match(/cpu=([0-9.]+)%.*wall=([0-9]+)ms/);
      if (!match) return;
      cpuSamples.push({ cpuPct: Number(match[1]), wallMs: Number(match[2]) });
    },
    sampleIntervalMs: 100,
    cpuThresholdPct: 0,
    minConsecutiveSamples: 1,
    minLogIntervalMs: 0,
  });

  const beforePerf = getPerfSnapshot();
  const app = createApp();
  let onInitMs = 0;
  try {
    const onInitStart = Date.now();
    await app.onInit();
    onInitMs = Date.now() - onInitStart;
    await wait(2200);
  } finally {
    stopMonitor();
    await cleanupApps();
  }
  const afterPerf = getPerfSnapshot();

  return {
    onInitMs,
    maxCpuPct: cpuSamples.reduce((max, entry) => Math.max(max, entry.cpuPct), 0),
    maxWallMs: cpuSamples.reduce((max, entry) => Math.max(max, entry.wallMs), 0),
    deviceFetchMs: readDurationTotal(afterPerf, 'device_fetch_ms') - readDurationTotal(beforePerf, 'device_fetch_ms'),
    deviceRefreshMs: readDurationTotal(afterPerf, 'device_refresh_ms') - readDurationTotal(beforePerf, 'device_refresh_ms'),
    dailyBudgetUpdateMs: readDurationTotal(afterPerf, 'daily_budget_update_ms') - readDurationTotal(beforePerf, 'daily_budget_update_ms'),
  };
};

describe('startup cpu spike perf reproduction', () => {
  beforeEach(() => {
    process.env.PELS_ASYNC_STARTUP = '1';
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterEach(async () => {
    delete process.env.PELS_ASYNC_STARTUP;
    await cleanupApps();
    jest.useRealTimers();
  });

  it('shows materially higher startup work for heavy fixtures vs light fixtures', async () => {
    const light = await captureStartupMetrics({
      deviceCount: 120,
      historyHours: 24 * 7,
    });
    const heavy = await captureStartupMetrics({
      deviceCount: 3200,
      historyHours: 24 * 180,
    });

    expect(heavy.deviceFetchMs).toBeGreaterThan(light.deviceFetchMs);
    expect(heavy.deviceRefreshMs).toBeGreaterThan(light.deviceRefreshMs);
    // Startup skips observed-stat refresh, so daily-budget work should stay bounded
    // even when the stored power-tracker history grows significantly.
    expect(heavy.dailyBudgetUpdateMs).toBeLessThanOrEqual(light.dailyBudgetUpdateMs + 75);
    expect(heavy.dailyBudgetUpdateMs).toBeLessThan(200);
  }, 60_000);

  it('skips live power fetch during startup bootstrap snapshot', async () => {
    const energyApi = mockHomeyApiInstance.energy as {
      getLiveReport?: (args: unknown) => Promise<unknown>;
    };
    const originalGetLiveReport = energyApi.getLiveReport;
    const liveReportSpy = jest.fn(async () => {
      await wait(250);
      return {};
    });
    energyApi.getLiveReport = liveReportSpy;

    try {
      const deviceCount = 1800;
      setMockDrivers(buildHeavyDriverFixture(deviceCount));
      mockHomeyInstance.settings.set('price_scheme', 'flow');
      mockHomeyInstance.settings.set('target_devices_snapshot', buildLargeCachedSnapshot(deviceCount));

      const app = createApp();
      await app.onInit();
      await wait(500);

      expect(liveReportSpy).not.toHaveBeenCalled();
    } finally {
      energyApi.getLiveReport = originalGetLiveReport;
    }
  }, 30_000);
});
