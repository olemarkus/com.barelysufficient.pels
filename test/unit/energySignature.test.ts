import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  fitEnergySignature,
  predictDailyKwh,
} from '../../packages/shared-domain/src/energySignature/energySignature';

const NOW_MS = Date.UTC(2026, 5, 1, 0, 0, 0);

const day = (index: number, tempC: number, kwh: number, overrides: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
  kwhTotal: kwh,
  tempMeanC: tempC,
  tempMinC: tempC - 3,
  tempMaxC: tempC + 3,
  tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
  ...overrides,
});

// Deterministic "noise": ±1.5 kWh alternating, with a slow ±0.5 wobble.
const noise = (index: number): number => (index % 2 === 0 ? 1.5 : -1.5) + (index % 3 === 0 ? 0.5 : -0.25);

/** House: 20 kWh base + 2 kWh per °C below 15. Temps sweep −10..+22 °C. */
const heatingDays = (count: number): WeatherDailyRecord[] => Array.from({ length: count }, (_, index) => {
  const tempC = -10 + (32 * index) / (count - 1);
  const kwh = 20 + 2 * Math.max(0, 15 - tempC) + noise(index);
  return day(index, tempC, kwh);
});

describe('fitEnergySignature', () => {
  it('recovers base load, slope, and balance point from a clean heating signature', () => {
    const fit = fitEnergySignature(heatingDays(60), NOW_MS);
    expect(fit).not.toBeNull();
    expect(fit?.model).toBe('changepoint');
    expect(fit?.slopeKwhPerDegree).toBeGreaterThan(1.7);
    expect(fit?.slopeKwhPerDegree).toBeLessThan(2.3);
    expect(fit?.balancePointC).toBeGreaterThanOrEqual(13);
    expect(fit?.balancePointC).toBeLessThanOrEqual(17);
    expect(fit?.baseLoadKwhPerDay).toBeGreaterThan(17);
    expect(fit?.baseLoadKwhPerDay).toBeLessThan(23);
    expect(fit?.confidence === 'medium' || fit?.confidence === 'high').toBe(true);
    expect(fit?.heatLossWPerK).toBeGreaterThan(60);
    expect(fit?.driftSuspected).toBe(false);
    // A straight resistive home must NOT read as curved: the hinge itself
    // once leaked into the curvature test (heating-regime-only regression).
    expect(fit?.curvatureSteeperWhenCold).toBe(false);
  });

  it('shrugs off 20% contaminated days (vacations) without losing the slope', () => {
    const days = heatingDays(60).map((record, index) => (
      index % 5 === 0 ? { ...record, kwhTotal: 6 } : record
    ));
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.slopeKwhPerDegree).toBeGreaterThan(1.6);
    expect(fit?.slopeKwhPerDegree).toBeLessThan(2.4);
  });

  it('refuses to fabricate a balance point from a winter window with a tied warm-end plateau', () => {
    // True balance 15, but observations only span −10..13: every τ ≥ 13 fits
    // identically, and the tie must NOT resolve to a confident changepoint.
    const days = Array.from({ length: 90 }, (_, index) => {
      const tempC = -10 + (23 * index) / 89;
      return day(index, tempC, 20 + 2 * (15 - tempC) + noise(index));
    });
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.model).toBe('linear');
    expect(fit?.balancePointC).toBeUndefined();
  });

  it('degenerates to a linear model on winter-only data (no identifiable balance point)', () => {
    const days = Array.from({ length: 40 }, (_, index) => {
      const tempC = -15 + (index % 12); // −15..−4 °C only
      return day(index, tempC, 20 + 2 * (15 - tempC) + noise(index));
    });
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.model).toBe('linear');
    expect(fit?.balancePointC).toBeUndefined();
    expect(fit?.baseLoadKwhPerDay).toBeUndefined();
    expect(fit?.slopeKwhPerDegree).toBeGreaterThan(1.6);
  });

  it('reports an uncorrelated model when usage ignores temperature', () => {
    const days = Array.from({ length: 50 }, (_, index) => (
      day(index, -10 + (30 * index) / 49, 30 + noise(index))
    ));
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.model).toBe('uncorrelated');
    expect(fit?.confidence).toBe('learning');
    expect(fit?.heatLossWPerK).toBeUndefined();
    expect(fit?.medianDayKwh).toBeGreaterThan(28);
    // The rejected linear line must not leak: the headline slope is zero and
    // residuals center on the median-day anchor the suggestion uses.
    expect(fit?.slopeKwhPerDegree).toBe(0);
    expect(fit?.slopeCiLow).toBeUndefined();
    expect(Math.abs(fit?.residualQ50 ?? 99)).toBeLessThan(2);
  });

  it('detects drift even at the minimum data gate (baseline excludes the recent window)', () => {
    const days = heatingDays(28).map((record, index) => (
      index >= 14 ? { ...record, kwhTotal: (record.kwhTotal ?? 0) + 9 } : record
    ));
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.driftSuspected).toBe(true);
  });

  it('returns null below the minimum usable-day gate', () => {
    expect(fitEnergySignature(heatingDays(20), NOW_MS)).toBeNull();
  });

  it('excludes quality-flagged and non-positive days from the fit', () => {
    const days = [
      ...heatingDays(30).map((record) => ({
        ...record,
        quality: { ...record.quality, missingKwh: true },
      })),
      ...heatingDays(15),
    ];
    // 30 flagged + 15 usable < 21 usable ⇒ no fit.
    expect(fitEnergySignature(days, NOW_MS)).toBeNull();
  });

  it('flags drift when recent days run above what is typical for their temperature', () => {
    const days = heatingDays(60).map((record, index) => (
      index >= 46 ? { ...record, kwhTotal: (record.kwhTotal ?? 0) + 9 } : record
    ));
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.driftSuspected).toBe(true);
  });

  it('flags cold-side curvature (heat-pump-like convexity)', () => {
    const days = Array.from({ length: 60 }, (_, index) => {
      const tempC = -12 + (30 * index) / 59;
      const coldExtra = tempC < 0 ? 2.5 * -tempC : 0; // steeper below 0 °C
      return day(index, tempC, 20 + 1.2 * Math.max(0, 15 - tempC) + coldExtra + noise(index));
    });
    const fit = fitEnergySignature(days, NOW_MS);
    expect(fit?.curvatureSteeperWhenCold).toBe(true);
  });
});

describe('predictDailyKwh', () => {
  it('predicts along the hinge for changepoint fits and undefined when uncorrelated', () => {
    const fit = fitEnergySignature(heatingDays(60), NOW_MS);
    if (!fit) throw new Error('expected fit');
    const coldDay = predictDailyKwh(fit, -5) ?? 0;
    const warmDay = predictDailyKwh(fit, 20) ?? 0;
    expect(coldDay).toBeGreaterThan(warmDay + 25);
    expect(Math.abs(warmDay - (fit.baseLoadKwhPerDay ?? 0))).toBeLessThan(0.01);

    const flat = fitEnergySignature(
      Array.from({ length: 50 }, (_, index) => day(index, -10 + (30 * index) / 49, 30 + noise(index))),
      NOW_MS,
    );
    if (!flat) throw new Error('expected flat fit');
    expect(predictDailyKwh(flat, -5)).toBeUndefined();
  });
});
