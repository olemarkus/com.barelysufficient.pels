import { resolveFreshGenerationW, resolveGenerationSegments } from '../../lib/observer/generationFreshness';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

const NOW = Date.UTC(2026, 5, 19, 12, 0, 0);

describe('resolveFreshGenerationW', () => {
  it('carries a reading taken within the freshness window', () => {
    expect(resolveFreshGenerationW({
      generationW: 4200,
      observedAtMs: NOW - 5_000,
      nowMs: NOW,
    })).toBe(4200);
  });

  it('drops a reading older than the window rather than inheriting it', () => {
    // The bound is what stops a dead poll's last value being integrated across
    // every later sample. `accrueSolarSample` integrates the HELD generation
    // over the whole interval between samples, so a stale value does not
    // mislabel one sample — it writes kWh-scale error into `generationBuckets`.
    expect(resolveFreshGenerationW({
      generationW: 4200,
      observedAtMs: NOW - POWER_SAMPLE_STALE_THRESHOLD_MS,
      nowMs: NOW,
    })).toBeUndefined();
    expect(resolveFreshGenerationW({
      generationW: 4200,
      observedAtMs: NOW - (POWER_SAMPLE_STALE_THRESHOLD_MS + 1),
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('admits a reading at the last instant inside the window', () => {
    expect(resolveFreshGenerationW({
      generationW: 1,
      observedAtMs: NOW - (POWER_SAMPLE_STALE_THRESHOLD_MS - 1),
      nowMs: NOW,
    })).toBe(1);
  });

  it('treats a future-dated reading as absent', () => {
    // A clock change or a restart can leave a stamp ahead of now; that is as
    // untrustworthy as an expired one, and cheaper to drop than to reason about.
    expect(resolveFreshGenerationW({
      generationW: 4200,
      observedAtMs: NOW + 1,
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('reports absence when the report carried no generation', () => {
    // A `null` reading is a real observation ("nothing is being produced"), but
    // the sample contract is known-vs-unknown, and a home with no PV must not
    // start writing zero-generation samples.
    expect(resolveFreshGenerationW({
      generationW: null,
      observedAtMs: NOW,
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('reports absence before anything has ever been read', () => {
    expect(resolveFreshGenerationW({
      generationW: null,
      observedAtMs: null,
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('rejects non-finite inputs rather than passing them to the accrual', () => {
    expect(resolveFreshGenerationW({
      generationW: Number.NaN,
      observedAtMs: NOW,
      nowMs: NOW,
    })).toBeUndefined();
    expect(resolveFreshGenerationW({
      generationW: 4200,
      observedAtMs: Number.NaN,
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('rejects a NEGATIVE reading — production is +-only, so this is malformed, not export', () => {
    // Rejected at the resolution point rather than floored downstream: a floor
    // turns junk into a zero-production observation that accrues as fact.
    expect(resolveFreshGenerationW({
      generationW: -250,
      observedAtMs: NOW,
      nowMs: NOW,
    })).toBeUndefined();
  });

  it('admits a genuine zero — production of 0 W is a measurement, not absence', () => {
    expect(resolveFreshGenerationW({
      generationW: 0,
      observedAtMs: NOW,
      nowMs: NOW,
    })).toBe(0);
  });
});

describe('resolveGenerationSegments', () => {
  const reading = (watts: number | null, secondsBefore: number) => ({
    watts,
    observedAtMs: NOW - secondsBefore * 1000,
  });

  it('holds each reading until the next one', () => {
    expect(resolveGenerationSegments([reading(7000, 30), reading(3000, 20), reading(1000, 10)], NOW)).toEqual([
      { startMs: NOW - 30_000, endMs: NOW - 20_000, watts: 7000 },
      { startMs: NOW - 20_000, endMs: NOW - 10_000, watts: 3000 },
      { startMs: NOW - 10_000, endMs: NOW, watts: 1000 },
    ]);
  });

  it('holds a reading for at most the freshness window when the poll stops', () => {
    // The whole point: a stopped poll's last value vouches for one minute of
    // production, not for the rest of a 30-minute Flow interval.
    expect(resolveGenerationSegments([reading(7000, 30 * 60)], NOW)).toEqual([
      { startMs: NOW - 30 * 60_000, endMs: NOW - 30 * 60_000 + POWER_SAMPLE_STALE_THRESHOLD_MS, watts: 7000 },
    ]);
  });

  it('lets "no generator" and zero readings end the reading before them without adding a segment', () => {
    expect(resolveGenerationSegments([reading(7000, 30), reading(0, 20), reading(null, 10)], NOW)).toEqual([
      { startMs: NOW - 30_000, endMs: NOW - 20_000, watts: 7000 },
    ]);
  });

  it('drops malformed readings', () => {
    expect(resolveGenerationSegments([reading(-50, 30), reading(Number.NaN, 20)], NOW)).toEqual([]);
  });

  it('ignores readings stamped at or after the sample time', () => {
    expect(resolveGenerationSegments([reading(7000, 10), reading(5000, 0), reading(4000, -5)], NOW)).toEqual([
      { startMs: NOW - 10_000, endMs: NOW, watts: 7000 },
    ]);
  });
});

describe('ObservedHomePower reading history', () => {
  it('keeps readings in stamp order when a producer pushes an older stamp late', () => {
    // On flow the poll stamps at issue and the snapshot path at completion, so
    // an arrival can carry an earlier stamp than the reading before it.
    const holder = new ObservedHomePower();
    holder.setGenerationW(3000, NOW - 5_000);
    holder.setGenerationW(2000, NOW - 8_000);
    expect(holder.getGenerationReadings().map((held) => held.observedAtMs)).toEqual([NOW - 8_000, NOW - 5_000]);
    // The latest-value accessors still report the last push.
    expect(holder.getGenerationW()).toBe(2000);
  });

  it('forgets readings older than an hour', () => {
    const holder = new ObservedHomePower();
    holder.setGenerationW(1000, NOW - 61 * 60_000);
    holder.setGenerationW(2000, NOW - 59 * 60_000);
    holder.setGenerationW(3000, NOW);
    expect(holder.getGenerationReadings().map((held) => held.watts)).toEqual([2000, 3000]);
  });
});
