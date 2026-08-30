import { describe, expect, it } from 'vitest';
import { selectPvForecastSource } from '../../lib/solar/pvForecastSourceSelection';
import type { PvForecastConfidence, PvForecastSourcePort } from '../../lib/solar/pvForecastSource';

const port = (kwh: number | undefined, confidence: PvForecastConfidence): PvForecastSourcePort => ({
  forecast: (hourStarts) => (
    kwh === undefined ? [] : hourStarts.map((hourStartMs) => ({ hourStartMs, generationKwh: kwh }))
  ),
  getConfidence: () => confidence,
});

describe('selectPvForecastSource', () => {
  it('pins learned when the setting says learned, even with a useful Homey forecast', () => {
    const selected = selectPvForecastSource({
      setting: 'learned',
      homey: { hasUsefulForecast: true, port: port(3, 'high') },
      learned: port(1, 'low'),
    });
    expect(selected.sourceId).toBe('learned');
    expect(selected.forecast([0])).toEqual([{ hourStartMs: 0, generationKwh: 1 }]);
    expect(selected.getConfidence()).toBe('low');
  });

  it('pins homey when the setting says homey_energy', () => {
    const selected = selectPvForecastSource({
      setting: 'homey_energy',
      homey: { hasUsefulForecast: true, port: port(3, 'high') },
      learned: port(1, 'low'),
    });
    expect(selected.sourceId).toBe('homey_energy');
    expect(selected.forecast([0])).toEqual([{ hourStartMs: 0, generationKwh: 3 }]);
  });

  it('keeps an explicit homey_energy selected when unavailable — no silent fallback', () => {
    const selected = selectPvForecastSource({
      setting: 'homey_energy',
      homey: { hasUsefulForecast: false, port: port(undefined, 'none') },
      learned: port(1, 'low'),
    });
    expect(selected.sourceId).toBe('homey_energy');
    expect(selected.forecast([0])).toEqual([]);
    expect(selected.getConfidence()).toBe('none');
  });

  it('auto prefers homey while its forecast is useful', () => {
    const selected = selectPvForecastSource({
      setting: 'auto',
      homey: { hasUsefulForecast: true, port: port(3, 'high') },
      learned: port(1, 'low'),
    });
    expect(selected.sourceId).toBe('homey_energy');
  });

  it('auto falls back to learned when the homey forecast is not useful', () => {
    const selected = selectPvForecastSource({
      setting: 'auto',
      homey: { hasUsefulForecast: false, port: port(0, 'none') },
      learned: port(1, 'low'),
    });
    expect(selected.sourceId).toBe('learned');
    expect(selected.forecast([0])).toEqual([{ hourStartMs: 0, generationKwh: 1 }]);
  });

  it('auto with a resolved-but-all-zero homey forecast (not useful) stays on learned', () => {
    // The usefulness qualifier already classified the all-zero day as not
    // useful; the policy must respect that verdict rather than re-derive it.
    const selected = selectPvForecastSource({
      setting: 'auto',
      homey: { hasUsefulForecast: false, port: port(0, 'high') },
      learned: port(1, 'high'),
    });
    expect(selected.sourceId).toBe('learned');
  });
});
