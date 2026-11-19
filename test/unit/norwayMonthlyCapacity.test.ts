import { resolveNorwayMonthlyCapacity, norwayMonthStartMs } from '../../lib/power/norwayMonthlyCapacity';
import { projectNorwayMonthHistory, type NorwayMonthHistory } from '../../lib/power/norwayMonthlyCapacityHistory';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const tariff = { identity: 'grid:2026', boundariesKw: [0, 2, 5, 10, 15, 20], thresholdIncluded: true };
const settings: CapacityScalarSettings = {
  limitKw: 5, marginKw: 0.2, periodMinutes: 60, capacityEnabled: true,
  gridImportLimitKw: null, followMonthPeak: false, dryRun: false,
};
const now = Date.parse('2026-11-04T12:00:00+01:00');
const monthWith = (values: number[], complete = true): NorwayMonthHistory => ({
  monthKey: '2026-11', coverage: complete ? 'complete' : 'partial',
  peaks: values.map((kw, i) => ({ dateKey: `2026-11-0${i + 1}`,
    hourStartMs: Date.parse(`2026-11-0${i + 1}T10:00:00+01:00`), kw })),
});
const resolve = (values: number[], complete = true) => (
  resolveNorwayMonthlyCapacity(monthWith(values, complete), tariff, settings, 5, now)
);
const completeBuckets = (atMs: number): Record<string, number> => Object.fromEntries(
  Array.from({ length: Math.floor((atMs - norwayMonthStartMs(atMs)) / 3_600_000) + 1 }, (_, hour) => (
    [new Date(norwayMonthStartMs(atMs) + hour * 3_600_000).toISOString(), 0] as const
  )),
);

describe('Norway monthly capacity', () => {
  it.each([
    [5, 4.9, 4.9, 'set'],
    [4.5, 4.9, 4.5, 'keep'],
  ] as const)('keeps the saved %s nominal cap stable after an actual monthly hard-cap choice',
    (normalCap, target, recommended, state) => {
      const normal = { ...settings, limitKw: normalCap, marginKw: 0.3 };
      const history = monthWith([]);
      expect(resolveNorwayMonthlyCapacity(history, tariff, normal, normalCap, now)).toMatchObject({
        targetBoundaryKw: 5,
        remainingMonthCap: { state: 'bounded', limitKw: target },
        hardCapRecommendation: { state, limitKw: recommended },
      });
      expect(resolveNorwayMonthlyCapacity(history, tariff, normal, recommended, now)).toMatchObject({
        remainingMonthCap: { state: 'bounded', limitKw: target },
        hardCapRecommendation: { state: 'keep', limitKw: recommended }, advice: { state: 'none' },
      });
      expect(normal.limitKw).toBe(normalCap);
    });
  it('derives existing daily peaks before a new capacity feature was installed', () => {
    const atMs = Date.parse('2026-11-18T16:30:00+01:00');
    const tracker: PowerTrackerState = { buckets: {
      '2026-10-31T12:00:00.000Z': 25,
      '2026-11-17T08:00:00.000Z': 4.1,
      '2026-11-17T09:00:00.000Z': 4.3,
      '2026-11-18T06:00:00.000Z': 5.17,
      '2026-11-18T15:00:00.000Z': 1.42,
      '2026-11-19T09:00:00.000Z': 30,
    } };
    const history = projectNorwayMonthHistory(tracker, atMs);
    expect(history.peaks).toEqual([
      { dateKey: '2026-11-17', hourStartMs: Date.parse('2026-11-17T09:00:00Z'), kw: 4.3 },
      { dateKey: '2026-11-18', hourStartMs: Date.parse('2026-11-18T06:00:00Z'), kw: 5.17 },
    ]);
    expect(resolveNorwayMonthlyCapacity(history, tariff, settings, 5, atMs)).toMatchObject({
      average: { state: 'collecting', days: 2 }, coverage: 'partial',
      remainingMonthCap: { state: 'bounded', limitKw: 4.8 },
      hardCapRecommendation: { state: 'set', limitKw: 4.8, marginKw: 0.2 },
      advice: { state: 'suggestion', actionable: true },
    });
    expect(Object.keys(tracker)).toEqual(['buckets']);
  });
  it('reserves the margin below the actual 4.8 kW cap for recorded peaks, including partial history', () => {
    const result = resolveNorwayMonthlyCapacity(monthWith([5.17249, 4.93678, 4.65847], false), tariff,
      { ...settings, marginKw: 0.3 }, 5, now);
    expect(result).toMatchObject({
      targetBoundaryKw: 5, targetLost: false,
      remainingMonthCap: { state: 'bounded', limitKw: 4.8 },
      hardCapRecommendation: { state: 'set', limitKw: 4.8, marginKw: 0.3 },
      advice: { state: 'suggestion', limitKw: 4.8, actionable: true, direction: 'lower' },
    });
  });
  it('keeps a deliberately lower current hard cap instead of raising it within the same tier', () => {
    expect(resolveNorwayMonthlyCapacity(monthWith([5.17249, 4.93678, 4.65847]), tariff,
      { ...settings, marginKw: 0.3 }, 4.7, now)).toMatchObject({
      remainingMonthCap: { state: 'bounded', limitKw: 4.8 },
      hardCapRecommendation: { state: 'keep', limitKw: 4.7, marginKw: 0.3 }, advice: { state: 'none' },
    });
  });
  it('protects the tier selected by the raw hard cap rather than its margin-reduced planning pace', () => {
    const configured = { ...settings, limitKw: 5.1, marginKw: 0.3 };
    expect(resolveNorwayMonthlyCapacity(monthWith([5.17, 4.3]), tariff, configured, 5.1, now))
      .toMatchObject({ targetBoundaryKw: 10,
        hardCapRecommendation: { state: 'keep', limitKw: 5.1, marginKw: 0.3 }, advice: { state: 'none' },
      });
  });
  it('loses the lower tier if two later days reach 5 kW even though the present average is below 5', () => {
    const present = resolveNorwayMonthlyCapacity(monthWith([5.17249, 4.93678, 4.65847]), tariff, settings, 5, now);
    expect(present).toMatchObject({ targetLost: false, average: { state: 'recorded' } });
    if (present.state !== 'ready' || present.average.state !== 'recorded') throw new Error('Expected average');
    expect(present.average.kw).toBeCloseTo(4.92258, 8);
    const later = resolveNorwayMonthlyCapacity(monthWith([5.17249, 4.93678, 4.65847, 5, 5]),
      tariff, settings, 5, Date.parse('2026-11-06T12:00:00+01:00'));
    expect(later).toMatchObject({ targetLost: true, tier: { lowerKw: 5, upperKw: 10 },
      advice: { state: 'suggestion', direction: 'raise', limitKw: 9.9 } });
  });
  it('includes the safety margin in the revision used to validate an action', () => {
    const first = resolveNorwayMonthlyCapacity(monthWith([5.17, 4.3]), tariff, settings, 5, now);
    const second = resolveNorwayMonthlyCapacity(monthWith([5.17, 4.3]), tariff, { ...settings, marginKw: 0.3 }, 5, now);
    if (first.state !== 'ready' || second.state !== 'ready'
      || first.advice.state !== 'suggestion' || second.advice.state !== 'suggestion') throw new Error('Expected advice');
    expect(second.advice.version).not.toBe(first.advice.version);
  });
  it('publishes a current-hour lower bound consistently with the loss advice', () => {
    const history = monthWith([4.9, 4.9, 4.9]);
    const partial = { dateKey: '2026-11-04', hourStartMs: now, kw: 6, lowerBound: true as const };
    const result = resolveNorwayMonthlyCapacity({ ...history, peaks: [...history.peaks, partial] },
      tariff, settings, 5, now + 30 * 60 * 1000);
    expect(result).toMatchObject({ state: 'ready', targetLost: true,
      average: { state: 'recorded', kw: 15.8 / 3 }, tier: { lowerKw: 5, upperKw: 10 },
      advice: { state: 'suggestion', limitKw: 9.9 },
    });
    if (result.state !== 'ready') throw new Error('Expected monthly facts');
    expect(result.peaks[0]).toEqual(partial);
    expect(history.peaks.map((peak) => peak.kw)).toEqual([4.9, 4.9, 4.9]);
  });
  it('groups repeated DST hours into one day, choosing the highest clock hour', () => {
    const history = projectNorwayMonthHistory({ buckets: {
      '2026-10-24T09:00:00.000Z': 5,
      '2026-10-25T00:00:00.000Z': 6,
      '2026-10-25T01:00:00.000Z': 7,
      '2026-10-26T09:00:00.000Z': 4,
    } }, Date.parse('2026-10-26T12:00:00Z'));
    expect(history.peaks.map((peak) => peak.kw)).toEqual([5, 7, 4]);
    expect(history.peaks[1]?.hourStartMs).toBe(Date.parse('2026-10-25T01:00:00Z'));
  });
  it('requires recorded hours throughout the elapsed month and honours unreliable periods', () => {
    const buckets = completeBuckets(now);
    expect(projectNorwayMonthHistory({ buckets }, now).coverage).toBe('complete');
    expect(projectNorwayMonthHistory({ buckets, unreliablePeriods: [{ start: now - 1000, end: now }] }, now).coverage)
      .toBe('partial');
    const missing = { ...buckets }; delete missing[new Date(now).toISOString()];
    expect(projectNorwayMonthHistory({ buckets: missing }, now).coverage).toBe('complete');
    delete missing[new Date(norwayMonthStartMs(now)).toISOString()];
    expect(projectNorwayMonthHistory({ buckets: missing }, now).coverage).toBe('partial');
    expect(projectNorwayMonthHistory({}, now).coverage).toBe('partial');
  });
  it('does not manufacture the first day after the 30-day retention window moves past it', () => {
    const end = Date.parse('2026-12-31T12:00:00+01:00');
    const retained = Object.fromEntries(Object.entries(completeBuckets(end))
      .filter(([key]) => Date.parse(key) >= end - 30 * 24 * 3_600_000));
    expect(projectNorwayMonthHistory({ buckets: retained }, end).coverage).toBe('partial');
  });
  it('skips invalid keys and values without treating them as zero or complete coverage', () => {
    const buckets = { ...completeBuckets(now),
      'invalid': 8, '2026-11-01T10:00:00.000Z': -1, '2026-11-02T10:00:00.000Z': Number.NaN,
    };
    const history = projectNorwayMonthHistory({ buckets }, now);
    expect(history.coverage).toBe('partial');
    expect(history.peaks.every((peak) => Number.isFinite(peak.kw) && peak.kw >= 0)).toBe(true);
  });
  it('ignores invalid values outside the current month', () => {
    const buckets = { ...completeBuckets(now), '2026-10-31T10:00:00.000Z': Number.NaN };
    expect(projectNorwayMonthHistory({ buckets }, now).coverage).toBe('complete');
  });
  it('marks the current bucket as a lower bound only if it sets its day’s highest hour', () => {
    const atMs = Date.parse('2026-11-04T12:30:00+01:00');
    const history = projectNorwayMonthHistory({ buckets: { [new Date(now).toISOString()]: 6 } }, atMs);
    expect(history.peaks[0]).toEqual({ dateKey: '2026-11-04', hourStartMs: now, kw: 6, lowerBound: true });
  });
  it('keeps one 5.01 kW day recoverable and proposes 4.9 for future hours', () => {
    expect(resolve([5.01])).toMatchObject({ state: 'ready', targetLost: false,
      remainingMonthCap: { state: 'bounded', limitKw: 4.9 },
      hardCapRecommendation: { state: 'set', limitKw: 4.9, marginKw: 0.2 },
      advice: { state: 'suggestion', limitKw: 4.9, actionable: true, direction: 'lower' } });
  });
  it('offers the next tier only after irreversible loss with a buffer', () => {
    expect(resolve([5.5, 5.3, 5.1])).toMatchObject({ state: 'ready', targetLost: true,
      advice: { state: 'suggestion', limitKw: 9.9, actionable: true } });
    expect(resolve([5.01, 5.01, 5.01])).toMatchObject({ state: 'ready', targetLost: true,
      remainingMonthCap: { state: 'keep_current', limitKw: 5 }, advice: { state: 'none' } });
  });
  it('withholds apply for missing elapsed-month hours', () => {
    expect(resolve([5.5, 5.3, 5.1], false)).toMatchObject({ state: 'ready', coverage: 'partial',
      advice: { state: 'suggestion', actionable: false } });
  });
  it('can lose a tier before three days and skips tiers already lost', () => {
    expect(resolve([31])).toMatchObject({ state: 'ready', targetLost: true,
      average: { state: 'collecting', days: 1 }, advice: { limitKw: 6.9 } });
  });
  it('offers tightening when later peaks consume an accepted tier’s available capacity', () => {
    expect(resolveNorwayMonthlyCapacity(monthWith([10.2, 10.1, 9.6]), tariff, settings, 9.9, now))
      .toMatchObject({ advice: { state: 'suggestion', limitKw: 9.6, direction: 'lower', actionable: true } });
  });
  it('publishes the cap even when no change or tightening is needed', () => {
    expect(resolve([4.7, 4.6, 4.5])).toMatchObject({ hardCapRecommendation: { state: 'set', limitKw: 4.9 },
      remainingMonthCap: { state: 'bounded', limitKw: 4.9 } });
    expect(resolveNorwayMonthlyCapacity(monthWith([4.7, 4.6, 4.5]), tariff, settings, 4.9, now))
      .toMatchObject({ hardCapRecommendation: { state: 'keep', limitKw: 4.9, marginKw: 0.2 }, advice: { state: 'none' }, remainingMonthCap: { state: 'bounded', limitKw: 4.9 } });
  });
  it('floors the remaining-day cap when two earlier peaks consume most of the allowance', () => {
    const lastDay = Date.parse('2026-11-30T12:00:00+01:00');
    const history: NorwayMonthHistory = { monthKey: '2026-11', coverage: 'complete', peaks: [
      { dateKey: '2026-11-28', hourStartMs: Date.parse('2026-11-28T10:00:00+01:00'), kw: 5.51 },
      { dateKey: '2026-11-29', hourStartMs: Date.parse('2026-11-29T10:00:00+01:00'), kw: 5.51 },
      { dateKey: '2026-11-30', hourStartMs: Date.parse('2026-11-30T10:00:00+01:00'), kw: 3 },
    ] };
    expect(resolveNorwayMonthlyCapacity(history, tariff, settings, 5, lastDay))
      .toMatchObject({ targetLost: false, remainingMonthCap: { state: 'bounded', limitKw: 3.9 } });
  });
  it('keeps evidence when the normal target is the unbounded highest tier', () => {
    expect(resolveNorwayMonthlyCapacity(monthWith([22, 21, 20]), tariff, { ...settings, limitKw: 25 }, 25, now))
      .toMatchObject({ state: 'ready', targetBoundaryKw: null, advice: { state: 'none' },
        remainingMonthCap: { state: 'unbounded_tier' } });
  });
});
