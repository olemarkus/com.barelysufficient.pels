import { resolveFreshGenerationW } from '../../lib/observer/generationFreshness';
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
