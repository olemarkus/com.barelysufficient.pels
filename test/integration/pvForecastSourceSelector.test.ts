// Integration-tier: the live source-selection closure over the two forecast
// controllers. Outward seams (the controllers, the setting read, the clock)
// are faked structurally; the real selection policy + transition logging run.
import { describe, expect, it, vi } from 'vitest';
import { createPvForecastSourceSelector } from '../../setup/appInit/createPvForecastSourceSelector';
import { HomeyEnergySolarForecastSource } from '../../lib/solar/homeyEnergySolarForecast';
import { emptyPvForecastServiceState, PvForecastService } from '../../lib/solar/pvForecastService';
import type { PvForecastSourceSetting } from '../../lib/solar/pvForecastSource';

const NOW_MS = Date.UTC(2026, 7, 25, 10);

// A real Homey source over an injected fetch — resolved with one useful hour.
const homeySource = async (watts: number): Promise<HomeyEnergySolarForecastSource> => {
  const source = new HomeyEnergySolarForecastSource({
    fetchForecastDay: async (dateKey) => ({
      kind: 'resolved',
      body: { points: [{ t: `${dateKey}T10:00:00.000Z`, watts }], totalWh: watts / 4 },
    }),
    getTimeZone: () => 'Europe/Oslo',
    getNowMs: () => NOW_MS,
  });
  await source.refresh(NOW_MS);
  return source;
};

// A real learned service with no training data: active as a port, empty forecast.
const learnedService = (): PvForecastService => new PvForecastService({
  irradiance: { getIrradiance: () => ({ kind: 'absent' as const }) },
  initialState: emptyPvForecastServiceState(),
});

type SelectorSetup = {
  setting?: PvForecastSourceSetting;
  homey: HomeyEnergySolarForecastSource;
  learned: PvForecastService;
};

// Both controllers are passed by value — the production caller builds this
// closure in the step that constructs them, so there is no "not wired yet"
// state for the selector to be in.
const makeSelector = (setup: SelectorSetup) => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const state = { setting: setup.setting ?? 'auto' as PvForecastSourceSetting };
  const selector = createPvForecastSourceSelector({
    learned: { service: setup.learned },
    // The controller holds the setting; `state.setting` stands in for the value
    // it resolved at startup and re-resolves on the settings-change event.
    homey: { source: setup.homey, getSourceSetting: () => state.setting },
    getNowMs: () => NOW_MS,
    logger,
  });
  return { selector, logger, state };
};

describe('createPvForecastSourceSelector', () => {
  it('selects homey under auto while its forecast is useful and serves its kWh', async () => {
    const { selector } = makeSelector({
      homey: await homeySource(2000),
      learned: learnedService(),
    });
    const selected = selector();
    expect(selected.sourceId).toBe('homey_energy');
    expect(selected.forecast([NOW_MS])).toEqual([{ hourStartMs: NOW_MS, generationKwh: 2 }]);
    expect(selected.getConfidence()).toBe('high');
  });

  it('falls back to learned under auto when the homey forecast is all-zero', async () => {
    const { selector } = makeSelector({
      homey: await homeySource(0),
      learned: learnedService(),
    });
    const selected = selector();
    expect(selected.sourceId).toBe('learned');
    // No fit yet ⇒ the learned port honestly answers "no forecast".
    expect(selected.forecast([NOW_MS])).toEqual([]);
    expect(selected.getConfidence()).toBe('none');
  });

  it('logs pv_forecast_source_selected on transitions only', async () => {
    const { selector, logger, state } = makeSelector({
      homey: await homeySource(2000),
      learned: learnedService(),
    });
    selector();
    selector();
    selector();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({
      event: 'pv_forecast_source_selected', sourceId: 'homey_energy', setting: 'auto',
    });
    state.setting = 'learned';
    selector();
    selector();
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenLastCalledWith({
      event: 'pv_forecast_source_selected', sourceId: 'learned', setting: 'learned',
    });
  });
});
