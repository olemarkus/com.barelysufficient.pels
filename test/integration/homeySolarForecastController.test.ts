import { describe, expect, it, vi } from 'vitest';
import {
  HomeySolarForecastController,
  type HomeySolarForecastLogger,
} from '../../lib/solar/homeySolarForecastController';
import { summaryHourCount } from '../../lib/solar/homeyEnergySolarForecast';
import type { SolarForecastDayRead } from '../../lib/solar/homeyEnergySolarForecast';
import type { PvForecastSourceSetting } from '../../lib/solar/pvForecastSource';

// 2026-08-25T10:00:00Z — noon in Europe/Oslo (UTC+2 in August).
const NOW_MS = Date.UTC(2026, 7, 25, 10);

const resolvedDay = (dateKey: string): SolarForecastDayRead => ({
  kind: 'resolved',
  body: { points: [{ t: `${dateKey}T10:00:00.000Z`, watts: 2000 }], totalWh: 500 },
});

type Harness = {
  controller: HomeySolarForecastController;
  fetches: string[];
  logger: LoggerSpy;
};

type LoggerSpy = {
  info: ReturnType<typeof vi.fn<(obj: Record<string, unknown>) => void>>;
  warn: ReturnType<typeof vi.fn<(obj: Record<string, unknown>) => void>>;
};

const createLogger = (): LoggerSpy => ({
  info: vi.fn<(obj: Record<string, unknown>) => void>(),
  warn: vi.fn<(obj: Record<string, unknown>) => void>(),
});

type TestControllerArgs = {
  fetchForecastDay: (localDateKey: string) => Promise<SolarForecastDayRead>;
  getTimeZone: () => string;
  getNowMs: () => number;
  readSourceSetting: () => PvForecastSourceSetting;
  hasSolarProductionCandidate: () => boolean;
  isLearnedActive: () => boolean;
  logger: HomeySolarForecastLogger;
};

const createController = (args: TestControllerArgs): HomeySolarForecastController => (
  new HomeySolarForecastController(
    args.fetchForecastDay,
    args.getTimeZone,
    args.getNowMs,
    args.readSourceSetting,
    args.hasSolarProductionCandidate,
    args.isLearnedActive,
    args.logger,
  )
);

const makeController = (overrides: {
  setting?: PvForecastSourceSetting;
  hasSolarCandidate?: boolean;
  learnedActive?: boolean;
  read?: (dateKey: string) => SolarForecastDayRead;
} = {}): Harness => {
  const fetches: string[] = [];
  const logger = createLogger();
  const args: TestControllerArgs = {
    fetchForecastDay: async (dateKey) => {
      fetches.push(dateKey);
      return overrides.read?.(dateKey) ?? resolvedDay(dateKey);
    },
    getTimeZone: () => 'Europe/Oslo',
    getNowMs: () => NOW_MS,
    readSourceSetting: () => overrides.setting ?? 'auto',
    hasSolarProductionCandidate: () => overrides.hasSolarCandidate ?? true,
    isLearnedActive: () => overrides.learnedActive ?? true,
    logger,
  };
  return { controller: createController(args), fetches, logger };
};

const loggedEvents = (logger: Harness['logger']): string[] => (
  [...logger.info.mock.calls, ...logger.warn.mock.calls].map(
    (call) => (call[0] as { event: string }).event,
  )
);

describe('HomeySolarForecastController', () => {
  it('refreshes and emits the pv_forecast_homey observability event on fresh points', async () => {
    const { controller, fetches, logger } = makeController();
    await controller.refresh();
    expect(fetches).toEqual(['2026-08-25', '2026-08-26']);
    const okCall = logger.info.mock.calls.find(
      (call) => (call[0] as { event: string }).event === 'pv_forecast_homey',
    );
    expect(okCall?.[0]).toMatchObject({
      hourCount: 2, next24hKwh: 2, totalWhReported: { kind: 'reported', wh: 1000 },
    });
  });

  describe('probe gating', () => {
    it('never probes when the source is pinned to learned', async () => {
      const { controller, fetches } = makeController({ setting: 'learned' });
      await controller.refresh();
      expect(fetches).toEqual([]);
    });

    it('probes ONCE for an eligible device without learned production, then stays quiet without a success', async () => {
      // A configured panel that has not fed the learned lane must still
      // discover Homey's forecast.
      const { controller, fetches } = makeController({
        learnedActive: false,
        read: () => ({ kind: 'unavailable' }),
      });
      await controller.refresh();
      expect(fetches).toHaveLength(2);
      await controller.refresh();
      await controller.refresh();
      expect(fetches).toHaveLength(2);
    });

    it('keeps discovering: the one unconditional probe that succeeds arms probing for good', async () => {
      const { controller, fetches } = makeController({ learnedActive: false });
      await controller.refresh(); // unconditional first probe → resolves ok
      await controller.refresh(); // hasSucceeded latch keeps it probing
      expect(fetches).toHaveLength(4);
    });

    it('probes an explicit homey_energy with an eligible device even without learned production', async () => {
      const { controller, fetches } = makeController({ setting: 'homey_energy', learnedActive: false });
      await controller.refresh();
      expect(fetches).toHaveLength(2);
    });

    it('skips Homey forecast requests when no eligible solar device exists', async () => {
      const automatic = makeController({ hasSolarCandidate: false });
      const explicit = makeController({ setting: 'homey_energy', hasSolarCandidate: false });
      await automatic.controller.refresh();
      await explicit.controller.refresh();
      expect(automatic.fetches).toEqual([]);
      expect(explicit.fetches).toEqual([]);
      expect(loggedEvents(automatic.logger)).toEqual([]);
      expect(loggedEvents(explicit.logger)).toEqual([]);
    });

    it('discovers Homey forecast after an eligible solar device appears', async () => {
      let hasSolarCandidate = false;
      const fetches: string[] = [];
      const controller = createController({
        fetchForecastDay: async (dateKey) => { fetches.push(dateKey); return resolvedDay(dateKey); },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => hasSolarCandidate,
        isLearnedActive: () => false,
        logger: createLogger(),
      });
      await controller.refresh();
      expect(fetches).toEqual([]);
      hasSolarCandidate = true;
      await controller.refreshEligibility();
      await controller.refreshEligibility(); // unchanged snapshot ⇒ no extra forecast fetch
      expect(fetches).toHaveLength(2);
    });

    it('keeps auto-probing after a prior success even if the learned lane goes quiet', async () => {
      let learnedActive = true;
      const fetches: string[] = [];
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => learnedActive,
        logger,
      });
      await controller.refresh();
      learnedActive = false;
      await controller.refresh();
      expect(fetches).toHaveLength(4);
    });

    it('one transient failure does not disarm the sticky success latch', async () => {
      let read: SolarForecastDayRead['kind'] = 'resolved';
      let learnedActive = true;
      const fetches: string[] = [];
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return read === 'resolved' ? resolvedDay(dateKey) : { kind: read };
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => learnedActive,
        logger,
      });
      await controller.refresh(); // ok → sticky latch armed
      learnedActive = false;
      read = 'failed';
      await controller.refresh(); // transient failure — must NOT disarm
      read = 'resolved';
      await controller.refresh(); // still probing
      expect(fetches).toHaveLength(6);
    });

    it('a transiently FAILED first probe does not consume the unconditional allowance', async () => {
      // The home this allowance exists for is the one that cannot re-arm it:
      // only Homey knows about the panels, so `isLearnedActive()` stays false
      // forever. Letting one flaky fetch spend the one-shot probe would leave
      // the source undiscoverable until an app restart.
      let read: SolarForecastDayRead['kind'] = 'failed';
      const fetches: string[] = [];
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return read === 'resolved' ? resolvedDay(dateKey) : { kind: read };
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => false,
        logger,
      });
      await controller.refresh(); // first probe fails transiently
      expect(fetches).toHaveLength(2);
      read = 'resolved';
      await controller.refresh(); // allowance unspent → retries and discovers
      expect(fetches).toHaveLength(4);
    });

    it('a conclusive unavailable DOES spend the allowance (a genuinely non-solar home pays one read)', async () => {
      const { controller, fetches } = makeController({
        learnedActive: false,
        read: () => ({ kind: 'unavailable' }),
      });
      await controller.refresh();
      await controller.refresh();
      expect(fetches).toHaveLength(2);
    });

    it('holds the setting: the probe gate reads it once at construction, not per refresh', async () => {
      // The setting is configuration behind its own change event, so a live
      // per-call read only opened a window for a transient SDK miss to un-pin
      // the owner's choice. One read at construction, then the held value.
      const readSourceSetting = vi.fn(() => 'learned' as const);
      const fetches: string[] = [];
      const controller = createController({
        fetchForecastDay: async (dateKey) => { fetches.push(dateKey); return resolvedDay(dateKey); },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting,
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => true,
        logger: createLogger(),
      });
      expect(readSourceSetting).toHaveBeenCalledTimes(1);
      await controller.refresh();
      await controller.refresh();
      expect(readSourceSetting).toHaveBeenCalledTimes(1); // still one — held
      expect(controller.getSourceSetting()).toBe('learned');
      expect(fetches).toEqual([]); // pinned to learned ⇒ never probes
    });

    it('re-resolves the held setting only on the change event, and then acts on it', async () => {
      let stored: 'learned' | 'homey_energy' = 'learned';
      const fetches: string[] = [];
      const controller = createController({
        fetchForecastDay: async (dateKey) => { fetches.push(dateKey); return resolvedDay(dateKey); },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => stored,
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => false,
        logger: createLogger(),
      });
      await controller.refresh();
      expect(fetches).toEqual([]); // pinned to learned

      // The owner flips the setting; the store changes but the held value does
      // not until the settings handler tells it to re-resolve.
      stored = 'homey_energy';
      await controller.refresh();
      expect(fetches).toEqual([]);

      controller.refreshSourceSetting();
      expect(controller.getSourceSetting()).toBe('homey_energy');
      await controller.refresh();
      expect(fetches).toHaveLength(2);
    });
  });

  describe('outcome logging', () => {
    it('latches the unavailable event to state transitions', async () => {
      const { controller, logger } = makeController({ read: () => ({ kind: 'unavailable' }) });
      await controller.refresh();
      await controller.refresh();
      await controller.refresh();
      expect(loggedEvents(logger).filter((event) => event === 'pv_forecast_homey_unavailable')).toHaveLength(1);
    });

    it('warns on a transient failure without clearing anything', async () => {
      const { controller, logger } = makeController({ read: () => ({ kind: 'failed' }) });
      await controller.refresh();
      expect(loggedEvents(logger)).toContain('pv_forecast_homey_refresh_failed');
    });
  });

  describe('completion hook + stop latch', () => {
    it('fires the hook only when fresh points landed', async () => {
      const readKind: { kind: 'resolved' | 'unavailable' } = { kind: 'unavailable' };
      const { controller } = makeController({
        read: (dateKey) => (readKind.kind === 'resolved' ? resolvedDay(dateKey) : { kind: 'unavailable' }),
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh();
      expect(onRefreshed).not.toHaveBeenCalled();
      readKind.kind = 'resolved';
      await controller.refresh();
      expect(onRefreshed).toHaveBeenCalledTimes(1);
    });

    it('also fires the hook when a populated cache is cleared (forecast vanished)', async () => {
      const readKind: { kind: 'resolved' | 'unavailable' } = { kind: 'resolved' };
      const { controller } = makeController({
        read: (dateKey) => (readKind.kind === 'resolved' ? resolvedDay(dateKey) : { kind: 'unavailable' }),
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh(); // points landed → hook
      expect(onRefreshed).toHaveBeenCalledTimes(1);
      readKind.kind = 'unavailable';
      await controller.refresh(); // populated → cleared: a real planning-input change → hook
      expect(onRefreshed).toHaveBeenCalledTimes(2);
      await controller.refresh(); // still empty → nothing changed → no hook
      expect(onRefreshed).toHaveBeenCalledTimes(2);
    });

    it('clears a populated Homey forecast when the solar device is removed', async () => {
      let hasSolarCandidate = true;
      const controller = createController({
        fetchForecastDay: async (dateKey) => resolvedDay(dateKey),
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => hasSolarCandidate,
        isLearnedActive: () => true,
        logger: createLogger(),
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh();
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(2);
      expect(onRefreshed).toHaveBeenCalledTimes(1);

      hasSolarCandidate = false;
      await controller.refreshEligibility();
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(0);
      expect(onRefreshed).toHaveBeenCalledTimes(2);
      await controller.refreshEligibility();
      expect(onRefreshed).toHaveBeenCalledTimes(2);
    });

    it('clears the forecast immediately when its solar device disappears during a refresh', async () => {
      let hasSolarCandidate = true;
      let releaseFetch: (() => void) | undefined;
      let markFetchStarted: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      let shouldWait = false;
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          if (shouldWait) {
            markFetchStarted?.();
            await gate;
          }
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => hasSolarCandidate,
        isLearnedActive: () => true,
        logger,
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh();
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(2);
      expect(onRefreshed).toHaveBeenCalledTimes(1);

      shouldWait = true;
      const inFlight = controller.refresh();
      await fetchStarted;
      hasSolarCandidate = false;
      const eligibilityRefresh = controller.refreshEligibility();
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(0);
      expect(onRefreshed).toHaveBeenCalledTimes(2);
      releaseFetch?.();
      await Promise.all([inFlight, eligibilityRefresh]);

      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(0);
      expect(loggedEvents(logger)).toEqual(['pv_forecast_homey']);
      expect(onRefreshed).toHaveBeenCalledTimes(3);
    });

    it('rejects an in-flight response that crosses a false-to-true eligibility transition', async () => {
      let hasSolarCandidate = true;
      let releaseFetch: (() => void) | undefined;
      let markFetchStarted: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      let calls = 0;
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          calls += 1;
          if (calls <= 2) {
            markFetchStarted?.();
            await gate;
            return resolvedDay(dateKey);
          }
          return { kind: 'unavailable' };
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
        hasSolarProductionCandidate: () => hasSolarCandidate,
        isLearnedActive: () => false,
        logger: createLogger(),
      });

      const inFlight = controller.refresh();
      await fetchStarted;
      hasSolarCandidate = false;
      const removal = controller.refreshEligibility();
      hasSolarCandidate = true;
      const addition = controller.refreshEligibility();
      releaseFetch?.();
      await Promise.all([inFlight, removal, addition]);

      expect(calls).toBe(4);
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(0);
    });

    it('fires the hook when ONE day is dropped while the other is retained', async () => {
      // The cache stays non-empty, so an emptied-cache predicate would miss it —
      // yet tomorrow's solar adjustment is gone and the planning price must
      // stop using it.
      let phase: 'both' | 'split' = 'both';
      const { controller } = makeController({
        read: (dateKey) => {
          if (phase === 'both') return resolvedDay(dateKey);
          // today: transient failure → last-good retained; tomorrow: gone.
          return dateKey === '2026-08-25' ? { kind: 'failed' } : { kind: 'unavailable' };
        },
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh();
      expect(onRefreshed).toHaveBeenCalledTimes(1);
      phase = 'split';
      await controller.refresh();
      expect(onRefreshed).toHaveBeenCalledTimes(2);
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(1);
    });

    it('serializes overlapping refreshes so a slow pass cannot wipe a newer one', async () => {
      // A settings write can land while the boot fetch or the 3 h tick is in
      // flight. `HomeyEnergySolarForecastSource.refresh` rebuilds the whole
      // per-day cache from the reads it started with, so an older pass
      // resolving `unavailable` after a newer one stored points would discard
      // them — and its stale `hourCountBefore` would skip the completion hook too.
      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          calls += 1;
          if (calls <= 2) {
            await gate;
            return { kind: 'unavailable' };
          }
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'homey_energy',
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => true,
        logger,
      });
      const first = controller.refresh();
      const second = controller.refresh();
      releaseFirst?.();
      await Promise.all([first, second]);
      // Serialized: the stale unavailable lands first, the fresh points last.
      expect(summaryHourCount(controller.source.summarize(NOW_MS))).toBe(2);
    });

    it('drops a completion that lands after stop()', async () => {
      let releaseFetch: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
      const logger = createLogger();
      const controller = createController({
        fetchForecastDay: async (dateKey) => {
          await gate;
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'homey_energy',
        hasSolarProductionCandidate: () => true,
        isLearnedActive: () => true,
        logger,
      });
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      const inFlight = controller.refresh();
      controller.stop();
      releaseFetch?.();
      await inFlight;
      expect(onRefreshed).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
