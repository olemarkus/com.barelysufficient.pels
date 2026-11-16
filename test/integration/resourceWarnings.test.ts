import { mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { startResourceWarningListeners } from '../../lib/diagnostics/resourceWarnings';
import { AppMemoryUsageSampler } from '../../lib/diagnostics/appMemoryFootprint';
import { summarizeRecentPlanRebuildTraces } from '../../lib/utils/planRebuildTrace';
import { captureLogger } from '../utils/loggerCapture';
import { httpResponse } from '../helpers/httpResponse';

const resolveSmapsSummaryMock = vi.fn();
const MB = 1024 * 1024;
const usageBody = { mem: { rss: 148.2 * MB, pss: 92 * MB, sharedClean: 55.4 * MB, pssSwap: 1.5 * MB }, cpu: { percentage: 4 } };
const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => httpResponse(body, status);
const startListeners = () => startResourceWarningListeners({
  homey: mockHomeyInstance,
  memoryUsage: new AppMemoryUsageSampler(mockHomeyInstance),
});
const flushReads = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

vi.mock('../../lib/diagnostics/smapsRollup', () => ({
  resolveSmapsSummary: () => resolveSmapsSummaryMock(),
}));

describe('Homey resource warning perf logging', () => {
  beforeEach(() => {
    mockHomeyInstance.removeAllListeners();
    resetMockHomey();
    setMockDrivers({});
    vi.clearAllTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(answer(usageBody));
    vi.stubGlobal('fetch', fetchMock);
    resolveSmapsSummaryMock.mockReset();
    resolveSmapsSummaryMock.mockReturnValue({
      rssMb: 256,
      pssMb: 240,
      pssAnonMb: 180,
      pssFileMb: 60,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    mockHomeyInstance.removeAllListeners();
    await cleanupApps();
    vi.clearAllTimers();
  });

  // The context is ~4.7 KB of walked rebuild traces and runtime spans, serialised
  // at the moment the runtime has said memory is tight. In one production window
  // 299 of 663 warnings arrived within 60 s of the previous, each rebuilding it.
  it('warns every time but attaches the perf context at most once per interval', async () => {
    const app = createApp();
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      errorSpy.mockClear();

      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      mockHomeyInstance.emit('memwarn', { count: 3, limit: 5 });
      mockHomeyInstance.emit('memwarn', { count: 4, limit: 5 });

      const records = errorSpy.mock.calls.map(([m]) => JSON.parse(String(m)) as {
        event?: string; count?: number; perf?: unknown; perfContextSuppressed?: boolean;
      });
      // Every warning is still logged — the arrival rate is itself the signal.
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.count)).toEqual([2, 3, 4]);
      expect(records.every((r) => r.event === 'homey_memwarn')).toBe(true);
      // Only the first carries the expensive payload.
      expect(records[0]?.perf).toBeDefined();
      expect(records[1]?.perf).toBeUndefined();
      expect(records[2]?.perf).toBeUndefined();
      expect(records[1]?.perfContextSuppressed).toBe(true);
      expect(records[2]?.perfContextSuppressed).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The payload summarises the same global 120 s window whichever warning
  // carried it, so a per-kind budget would dump ~4.7 KB twice in a combined
  // pressure episode — the one moment the interval exists to protect.
  it('spends one context budget across cpuwarn and memwarn together', async () => {
    const app = createApp();
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      errorSpy.mockClear();

      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      mockHomeyInstance.emit('cpuwarn', { count: 2, limit: 12 });
      mockHomeyInstance.emit('memwarn', { count: 3, limit: 5 });

      const records = errorSpy.mock.calls.map(([m]) => JSON.parse(String(m)) as {
        event?: string; perf?: unknown; perfContextSuppressed?: boolean;
      });
      // Every warning still logged, of both kinds.
      expect(records.map((r) => r.event)).toEqual([
        'homey_memwarn', 'homey_cpuwarn', 'homey_memwarn',
      ]);
      // ...but only the first spends the context.
      expect(records[0]?.perf).toBeDefined();
      expect(records[1]?.perf).toBeUndefined();
      expect(records[1]?.perfContextSuppressed).toBe(true);
      expect(records[2]?.perf).toBeUndefined();
      expect(records[2]?.perfContextSuppressed).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The warning is the platform saying the pooled pages have to go; answering
  // it is the app's one lever. The first warning of a run is unlogged but still
  // answered, and a storm arriving every 10 s gets one reclaim per interval.
  it('answers a memwarn with one rate-limited heap reclaim, from the first warning', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      logSpy.mockClear();
      errorSpy.mockClear();
      mockHomeyInstance.emit('memwarn', { count: 1, limit: 5 });
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      mockHomeyInstance.emit('memwarn', { count: 3, limit: 5 });
      const reclaims = logSpy.mock.calls
        .map(([m]) => JSON.parse(String(m)) as {
          event?: string; trigger?: string; durationMs?: number; heapTotalBeforeMb?: number; heapTotalAfterMb?: number;
        })
        .filter((r) => r.event === 'heap_pages_reclaimed');
      expect(reclaims).toHaveLength(1);
      expect(reclaims[0]).toEqual(expect.objectContaining({
        trigger: 'memwarn',
        durationMs: expect.any(Number),
        heapTotalBeforeMb: expect.any(Number),
        heapTotalAfterMb: expect.any(Number),
      }));
      // The unlogged first warning is still the one that reclaimed: two logged
      // warnings follow it, and neither produced a second reclaim.
      const warnings = errorSpy.mock.calls.map(([m]) => (JSON.parse(String(m)) as { event?: string }).event);
      expect(warnings).toEqual(['homey_memwarn', 'homey_memwarn']);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // The backstop exists so the plateau never forms between warnings; it must
  // fire on its own clock and stop with the listeners it was started with.
  it('reclaims on the backstop interval and stops with the listeners', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log').mockImplementation(() => undefined);
    let capture: ReturnType<typeof captureLogger> | undefined;
    try {
      await app.onInit();
      capture = captureLogger('info', ['perf']);
      // A second, module-level start on the same emitter, under fake timers so
      // only ITS interval is driven — the app's own polling stays real.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
      const stop = startListeners();
      expect(stop).toBeDefined();
      logSpy.mockClear();
      const reclaims = (): number => capture?.findEvents('heap_pages_reclaimed').length ?? 0;
      vi.advanceTimersByTime(10 * 60_000);
      expect(reclaims()).toBe(1);
      stop?.();
      vi.advanceTimersByTime(10 * 60_000);
      expect(reclaims()).toBe(1);
    } finally {
      capture?.restore();
      vi.useRealTimers();
      logSpy.mockRestore();
    }
  });

  it('keeps scheduled heap cleanup out of default reports', () => {
    vi.useFakeTimers();
    const capture = captureLogger('info', []);
    const stop = startListeners();
    try {
      vi.advanceTimersByTime(10 * 60_000);
      expect(capture.findEvents('heap_pages_reclaimed')).toHaveLength(0);
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      expect(capture.findEvent('homey_memwarn')).toBeDefined();
    } finally {
      stop?.();
      capture.restore();
      vi.useRealTimers();
    }
  });

  it('skips first cpuwarn count/limit after startup', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log');
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      // A trigger no other lane emits during this test. `unknown` is the power
      // lane's own fallback label (`rebuildScheduler/policy.ts`), so a stray
      // power sample would satisfy the count assertions below on its own.
      await app.planService.rebuildPlanFromCache('target_power_probe_due');
      logSpy.mockClear();
      errorSpy.mockClear();

      mockHomeyInstance.emit('cpuwarn', { count: 1, limit: 12 });

      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs cpuwarn count/limit and perf context from the second warning onward', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log');
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      // The trace log is process-wide and outlives a test, so an earlier test's
      // rebuild may already be in the window. Count this test's own rebuild as
      // the change across it.
      const probeRebuildsBefore = summarizeRecentPlanRebuildTraces().reasons.target_power_probe_due ?? 0;
      await app.planService.rebuildPlanFromCache('target_power_probe_due');
      logSpy.mockClear();
      errorSpy.mockClear();

      mockHomeyInstance.emit('cpuwarn', { count: 2, limit: 12 });

      expect(logSpy).not.toHaveBeenCalled();
      // One structured record on the error channel, not the prose summary + prose-prefixed
      // context that used to be two calls. `homeyDestination` routes error level here.
      const errorMessages = errorSpy.mock.calls.map(([message]) => String(message));
      expect(errorMessages).toHaveLength(1);
      const record = JSON.parse(errorMessages[0]!) as {
        event?: string;
        kind?: string;
        count?: number;
        limit?: number;
        perf?: Record<string, unknown>;
      };
      expect(record.event).toBe('homey_cpuwarn');
      expect(record.kind).toBe('cpuwarn');
      expect(record.count).toBe(2);
      expect(record.limit).toBe(12);
      expect(errorMessages[0]).not.toContain('\n');

      const payload = record.perf as {
        uptimeSec?: number;
        counts?: Record<string, number>;
        durations?: Record<string, { count: number; avgMs: number; maxMs: number }>;
        rebuilds?: {
          window?: { count?: number; reasons?: Record<string, number> };
        recent?: Array<{ reason?: string; totalMs?: number; ageMs?: number }>;
        };
        active?: { name: string; runningMs: number }[];
        recent?: { name: string; durationMs: number; endedAgoMs: number }[];
        smaps?: Record<string, number> | null;
      };
      expect(typeof payload.uptimeSec).toBe('number');
      expect(payload.smaps).toEqual({
        rssMb: 256,
        pssMb: 240,
        pssAnonMb: 180,
        pssFileMb: 60,
      });
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
      expect(payload.rebuilds?.window?.reasons?.target_power_probe_due).toBe(probeRebuildsBefore + 1);
      expect(payload.rebuilds?.recent?.[0]).toEqual(expect.objectContaining({
        reason: 'target_power_probe_due',
        totalMs: expect.any(Number),
        ageMs: expect.any(Number),
      }));
      expect(Array.isArray(payload.active)).toBe(true);
      expect(Array.isArray(payload.recent)).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('removes warning listeners on uninit', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log');
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);

    try {
      await app.onInit();
      await app.onUninit();
      logSpy.mockClear();
      errorSpy.mockClear();

      mockHomeyInstance.emit('cpuwarn', { count: 2, limit: 12 });
      mockHomeyInstance.emit('memwarn', { count: 3, limit: 12 });
      mockHomeyInstance.emit('unload');

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // Homey's warning compares the app's RSS, shared Node pages included, with
  // its line. The sandbox cannot read that RSS, so the warning asks Homey.
  it('records Homey\'s reading of the app\'s memory when a warning arrives', async () => {
    const capture = captureLogger('info', []);
    const stop = startListeners();
    try {
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      await flushReads();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [URL, { headers: Record<string, string> }];
      expect(url.pathname).toBe('/api/manager/apps/app/com.barelysufficient.pels/usage');
      expect(init.headers.Authorization).toBe('Bearer mock-token');
      expect(capture.findEvent('app_memory_footprint')).toMatchObject({
        trigger: 'memwarn',
        warningCount: 2,
        usage: { rssMb: 148.2, pssMb: 92, sharedCleanMb: 55.4, swapMb: 1.5, ageSec: 0 },
        faults: { maxRssMb: expect.any(Number), minorFaults: expect.any(Number), majorFaults: expect.any(Number) },
      });
    } finally {
      stop?.();
      capture.restore();
    }
  });

  // Warnings come every 10 s in a run; each reading is a local request made
  // while memory is tight, so one per 30 s is enough to show how far over it is.
  it('asks Homey at most once per 30 s during a run of warnings', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const capture = captureLogger('info', []);
    const stop = startListeners();
    try {
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      vi.advanceTimersByTime(10_000);
      mockHomeyInstance.emit('memwarn', { count: 3, limit: 5 });
      vi.advanceTimersByTime(10_000);
      mockHomeyInstance.emit('memwarn', { count: 4, limit: 5 });
      await flushReads();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(15_000);
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      await flushReads();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      stop?.();
      capture.restore();
      vi.useRealTimers();
    }
  });

  it('writes the footprint every 30 minutes with V8\'s heap beside Homey\'s reading', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const capture = captureLogger('info', []);
    const stop = startListeners();
    try {
      vi.advanceTimersByTime(30 * 60_000);
      await flushReads();
      const line = capture.findEvent('app_memory_footprint');
      expect(line).toMatchObject({
        trigger: 'interval',
        usage: { rssMb: 148.2, sharedCleanMb: 55.4 },
        heap: { heapUsedMb: expect.any(Number), codeMb: expect.any(Number) },
      });
      expect(line).not.toHaveProperty('warningCount');
    } finally {
      stop?.();
      capture.restore();
      vi.useRealTimers();
    }
  });

  // A failed or malformed read keeps the last good reading and says so once;
  // it never invents a footprint.
  it('keeps the last good reading when Homey\'s answer is unusable', async () => {
    const capture = captureLogger('info', []);
    const sampler = new AppMemoryUsageSampler(mockHomeyInstance);
    await sampler.refresh();
    fetchMock.mockResolvedValue(answer({ mem: { rss: 'lots' } }));
    await sampler.refresh();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await sampler.refresh();
    try {
      expect(sampler.latest()).toMatchObject({ rssMb: 148.2 });
      expect(capture.findEvents('app_memory_usage_unavailable')).toHaveLength(1);
      expect(capture.findEvent('app_memory_usage_unavailable')).toMatchObject({ reason: 'malformed' });
    } finally {
      capture.restore();
    }
  });

  // The report and the warnings share one request; a stalled SDK call must not
  // leave it pending for every later caller.
  it('gives up on a stalled SDK read after 10 s and reads again later', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const capture = captureLogger('info', []);
    const sampler = new AppMemoryUsageSampler(mockHomeyInstance);
    try {
      await sampler.refresh();
      const getToken = vi.spyOn(mockHomeyInstance.api, 'getOwnerApiToken')
        .mockImplementationOnce(() => new Promise<string>(() => undefined));
      const stalled = sampler.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(stalled).resolves.toBeNull();
      expect(sampler.latest()).toMatchObject({ rssMb: 148.2 });
      expect(capture.findEvent('app_memory_usage_unavailable')).toMatchObject({ reason: 'Homey app manager request timed out' });
      fetchMock.mockResolvedValue(answer({ mem: { rss: 120 * MB, pss: 80 * MB, sharedClean: 50 * MB, pssSwap: 0 } }));
      await expect(sampler.refresh()).resolves.toMatchObject({ rssMb: 120 });
      expect(getToken).toHaveBeenCalledTimes(2);
    } finally {
      capture.restore();
      vi.useRealTimers();
    }
  });

  it('reports no Homey reading until Homey has answered once', async () => {
    fetchMock.mockResolvedValue(answer('Not Found', 404));
    const capture = captureLogger('info', []);
    const stop = startListeners();
    try {
      mockHomeyInstance.emit('memwarn', { count: 2, limit: 5 });
      await flushReads();
      // The line still states V8's view, so a home Homey will not answer is not a blank.
      expect(capture.findEvent('app_memory_footprint')).toMatchObject({
        usage: null, heap: { heapUsedMb: expect.any(Number) },
      });
      expect(capture.findEvent('app_memory_usage_unavailable')).toMatchObject({ reason: 'HTTP 404' });
    } finally {
      stop?.();
      capture.restore();
    }
  });
});
