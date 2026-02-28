import { mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';

describe('Homey resource warning perf logging', () => {
  beforeEach(() => {
    mockHomeyInstance.removeAllListeners();
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockDrivers({});
    jest.clearAllTimers();
  });

  afterEach(async () => {
    mockHomeyInstance.removeAllListeners();
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('logs cpuwarn count/limit and perf context after startup', async () => {
    const app = createApp();
    const logSpy = jest.spyOn(app, 'log');

    await app.onInit();
    await (app as any).planService.rebuildPlanFromCache('test_warning_measurement');
    logSpy.mockClear();

    mockHomeyInstance.emit('cpuwarn', { count: 1, limit: 12 });

    const messages = logSpy.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('[perf] homey cpuwarn count=1 limit=12'),
    ]));

    const contextLine = messages.find((message) => message.includes('[perf] homey cpuwarn context '));
    expect(contextLine).toBeDefined();
    const jsonStart = contextLine!.indexOf('{');
    const payload = JSON.parse(contextLine!.slice(jsonStart)) as {
      uptimeSec?: number;
      counts?: Record<string, number>;
      durations?: Record<string, { count: number; avgMs: number; maxMs: number }>;
      rebuilds?: {
        window?: { count?: number; reasons?: Record<string, number> };
        recent?: Array<{ reason?: string; totalMs?: number; ageMs?: number }>;
      };
      active?: string[];
      recent?: string[];
    };
    expect(typeof payload.uptimeSec).toBe('number');
    expect(payload.counts).toEqual(expect.objectContaining({
      planRebuildRequested: expect.any(Number),
      planRebuild: expect.any(Number),
      dailyBudgetUpdate: expect.any(Number),
      powerSample: expect.any(Number),
    }));
    expect(payload.durations).toEqual(expect.objectContaining({
      planBuild: expect.any(Object),
      planRebuild: expect.any(Object),
      planRebuildBuild: expect.any(Object),
      planRebuildSnapshot: expect.any(Object),
      planRebuildStatus: expect.any(Object),
      deviceRefresh: expect.any(Object),
      deviceFetch: expect.any(Object),
      dailyBudgetUpdate: expect.any(Object),
    }));
    expect(payload.rebuilds?.window?.count).toBeGreaterThanOrEqual(1);
    expect(payload.rebuilds?.window?.reasons).toEqual(expect.objectContaining({
      test_warning_measurement: expect.any(Number),
    }));
    expect(payload.rebuilds?.recent?.[0]).toEqual(expect.objectContaining({
      reason: 'test_warning_measurement',
      totalMs: expect.any(Number),
      ageMs: expect.any(Number),
    }));
    expect(Array.isArray(payload.active)).toBe(true);
    expect(Array.isArray(payload.recent)).toBe(true);
  });

  it('removes warning listeners on uninit', async () => {
    const app = createApp();
    const logSpy = jest.spyOn(app, 'log');

    await app.onInit();
    await app.onUninit();
    logSpy.mockClear();

    mockHomeyInstance.emit('cpuwarn', { count: 2, limit: 12 });
    mockHomeyInstance.emit('memwarn', { count: 3, limit: 12 });
    mockHomeyInstance.emit('unload');

    expect(logSpy).not.toHaveBeenCalled();
  });
});
