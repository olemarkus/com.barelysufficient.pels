import { describe, expect, it, vi } from 'vitest';
import {
  HomeySolarForecastController,
  type HomeySolarForecastControllerCtx,
} from '../../lib/solar/homeySolarForecastController';
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
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
};

const makeController = (overrides: {
  setting?: PvForecastSourceSetting;
  learnedActive?: boolean;
  read?: (dateKey: string) => SolarForecastDayRead;
} = {}): Harness => {
  const fetches: string[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const ctx: HomeySolarForecastControllerCtx = {
    fetchForecastDay: async (dateKey) => {
      fetches.push(dateKey);
      return overrides.read?.(dateKey) ?? resolvedDay(dateKey);
    },
    getTimeZone: () => 'Europe/Oslo',
    getNowMs: () => NOW_MS,
    readSourceSetting: () => overrides.setting ?? 'auto',
    isLearnedActive: () => overrides.learnedActive ?? true,
    logger,
  };
  return { controller: new HomeySolarForecastController(ctx), fetches, logger };
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
    expect(okCall?.[0]).toMatchObject({ hourCount: 2, next24hKwh: 2, totalWhReported: 1000 });
  });

  describe('probe gating', () => {
    it('never probes when the source is pinned to learned', async () => {
      const { controller, fetches } = makeController({ setting: 'learned' });
      await controller.refresh();
      expect(fetches).toEqual([]);
    });

    it('probes ONCE at start even without solar production, then stays quiet without a success', async () => {
      // A home whose panels only Homey Energy knows about must still discover
      // the forecast; a genuinely non-solar home pays one local read and stops.
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

    it('probes an explicit homey_energy even without solar production', async () => {
      const { controller, fetches } = makeController({ setting: 'homey_energy', learnedActive: false });
      await controller.refresh();
      expect(fetches).toHaveLength(2);
    });

    it('keeps auto-probing after a prior success even if the learned lane goes quiet', async () => {
      let learnedActive = true;
      const fetches: string[] = [];
      const logger = { info: vi.fn(), warn: vi.fn() };
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
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
      const logger = { info: vi.fn(), warn: vi.fn() };
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return read === 'resolved' ? resolvedDay(dateKey) : { kind: read };
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
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
      const logger = { info: vi.fn(), warn: vi.fn() };
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => {
          fetches.push(dateKey);
          return read === 'resolved' ? resolvedDay(dateKey) : { kind: read };
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'auto',
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
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => { fetches.push(dateKey); return resolvedDay(dateKey); },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting,
        isLearnedActive: () => true,
        logger: { info: vi.fn(), warn: vi.fn() },
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
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => { fetches.push(dateKey); return resolvedDay(dateKey); },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => stored,
        isLearnedActive: () => false,
        logger: { info: vi.fn(), warn: vi.fn() },
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
      expect(controller.source.summarize(NOW_MS).hourCount).toBe(1);
    });

    it('serializes overlapping refreshes so a slow pass cannot wipe a newer one', async () => {
      // A settings write can land while the boot fetch or the 3 h tick is in
      // flight. `HomeyEnergySolarForecastSource.refresh` rebuilds the whole
      // per-day cache from the reads it started with, so an older pass
      // resolving `unavailable` after a newer one stored points would discard
      // them — and its stale `hadPoints` would skip the completion hook too.
      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      const logger = { info: vi.fn(), warn: vi.fn() };
      const controller = new HomeySolarForecastController({
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
        isLearnedActive: () => true,
        logger,
      });
      const first = controller.refresh();
      const second = controller.refresh();
      releaseFirst?.();
      await Promise.all([first, second]);
      // Serialized: the stale unavailable lands first, the fresh points last.
      expect(controller.source.summarize(NOW_MS).hourCount).toBe(2);
    });

    it('drops a completion that lands after stop()', async () => {
      let releaseFetch: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
      const logger = { info: vi.fn(), warn: vi.fn() };
      const controller = new HomeySolarForecastController({
        fetchForecastDay: async (dateKey) => {
          await gate;
          return resolvedDay(dateKey);
        },
        getTimeZone: () => 'Europe/Oslo',
        getNowMs: () => NOW_MS,
        readSourceSetting: () => 'homey_energy',
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
