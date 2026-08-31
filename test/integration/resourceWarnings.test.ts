import { mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';

const resolveSmapsSummaryMock = vi.fn();

vi.mock('../../lib/diagnostics/smapsRollup', () => ({
  resolveSmapsSummary: () => resolveSmapsSummaryMock(),
}));

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
    vi.clearAllTimers();
    resolveSmapsSummaryMock.mockReset();
    resolveSmapsSummaryMock.mockReturnValue({
      rssMb: 256,
      pssMb: 240,
      pssAnonMb: 180,
      pssFileMb: 60,
    });
  });

  afterEach(async () => {
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

  it('skips first cpuwarn count/limit after startup', async () => {
    const app = createApp();
    const logSpy = vi.spyOn(app, 'log');
    const errorSpy = vi.spyOn(app, 'error').mockImplementation(() => undefined);
    try {
      await app.onInit();
      // A trigger no other lane emits during this test. `unknown` is the power
      // lane's own fallback label (`rebuildScheduler/policy.ts`), so a stray
      // power sample would satisfy the count assertions below on its own.
      await app.planService.rebuildPlanFromCache('flow_card');
      logSpy.mockClear();
      errorSpy.mockClear();

      mockHomeyInstance.emit('cpuwarn', { count: 1, limit: 12 });

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
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
      await app.planService.rebuildPlanFromCache('flow_card');
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
      expect(payload.rebuilds?.window?.reasons).toEqual(expect.objectContaining({
        flow_card: expect.any(Number),
      }));
      expect(payload.rebuilds?.recent?.[0]).toEqual(expect.objectContaining({
        reason: 'flow_card',
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
});
