import { describe, expect, it } from 'vitest';
import {
  applyBandedConfidence,
  resolveBandedProfileConfidence,
  resolveProfileConfidence,
} from '../lib/objectives/stats';
import type {
  ObjectiveProfileBand,
  ObjectiveProfileStat,
} from '../lib/objectives/types';

const band = (overrides: Partial<ObjectiveProfileBand>): ObjectiveProfileBand => ({
  lowerInclusive: 0,
  upperExclusive: 1,
  sampleCount: 10,
  mean: 0.27,
  m2: 0.001,
  confidence: 'medium',
  ...overrides,
});

describe('resolveBandedProfileConfidence', () => {
  it('falls back to the non-banded resolver when no bands are present', () => {
    expect(resolveBandedProfileConfidence({
      sampleCount: 200, mean: 0.27, m2: 5.0, bands: undefined,
    })).toBe(resolveProfileConfidence({ sampleCount: 200, mean: 0.27, m2: 5.0 }));
  });

  it('falls back to the non-banded resolver when the bands array is empty', () => {
    expect(resolveBandedProfileConfidence({
      sampleCount: 200, mean: 0.27, m2: 5.0, bands: [],
    })).toBe(resolveProfileConfidence({ sampleCount: 200, mean: 0.27, m2: 5.0 }));
  });

  it('reaches `high` from tight within-band noise even when the global m2 is inflated', () => {
    // The smoking-gun case: a multi-step device whose global `m2` is inflated
    // by between-step spread. Global model: n=200, mean=0.27, m2=5.0 →
    // RSD≈0.59 → 'medium' (≤0.75, not ≤0.35). Banded model with two converged
    // step-bands (each n=100, m2=0.05, total within-band variance pooled over
    // 198 dof) → RSD≈0.083 → 'high'. This is exactly the Cause-#1 gap
    // (`TODO.md`) — the global model can't reach `high` even on a converged,
    // banded profile; the band-aware model can.
    const globalConfidence = resolveProfileConfidence({ sampleCount: 200, mean: 0.27, m2: 5.0 });
    expect(globalConfidence).toBe('medium');
    const banded = resolveBandedProfileConfidence({
      sampleCount: 200, mean: 0.27, m2: 5.0,
      bands: [
        band({ sampleCount: 100, mean: 0.20, m2: 0.05, confidence: 'high' }),
        band({ sampleCount: 100, mean: 0.34, m2: 0.05, confidence: 'high' }),
      ],
    });
    expect(banded).toBe('high');
  });

  it('returns `medium` when pooled within-band RSD sits in the medium band', () => {
    // pooled m2 = 0.2 over residualDof 18 → variance≈0.0111 → RSD≈0.39 →
    // > 0.35 but ≤ 0.75 → 'medium'. bandSampleTotal=20 still qualifies the n≥10 gate.
    expect(resolveBandedProfileConfidence({
      sampleCount: 20, mean: 0.27, m2: 1.0,
      bands: [
        band({ sampleCount: 10, mean: 0.25, m2: 0.1 }),
        band({ sampleCount: 10, mean: 0.29, m2: 0.1 }),
      ],
    })).toBe('medium');
  });

  it('stays `low` when within-band noise is genuinely high', () => {
    // pooled m2 = 2.0 over 18 dof → variance≈0.111 → RSD≈1.23 → > 0.75 → 'low'.
    // Confirms the band-aware path doesn't manufacture confidence out of noisy bands.
    expect(resolveBandedProfileConfidence({
      sampleCount: 20, mean: 0.27, m2: 5.0,
      bands: [
        band({ sampleCount: 10, m2: 1.0 }),
        band({ sampleCount: 10, m2: 1.0 }),
      ],
    })).toBe('low');
  });

  it('falls back when residual dof is non-positive (every band carries 1 sample)', () => {
    const banded = resolveBandedProfileConfidence({
      sampleCount: 2, mean: 0.27, m2: 0.01,
      bands: [
        band({ sampleCount: 1, mean: 0.20, m2: 0 }),
        band({ sampleCount: 1, mean: 0.34, m2: 0 }),
      ],
    });
    expect(banded).toBe(resolveProfileConfidence({ sampleCount: 2, mean: 0.27, m2: 0.01 }));
  });

  it('falls back when no positive reference mean is available (lifetime and every band mean are zero)', () => {
    // Degenerate: there is no positive central tendency to anchor RSD against,
    // so neither the weighted band mean nor the lifetime mean can serve as the
    // denominator and the resolver must fall back to the non-banded model.
    expect(resolveBandedProfileConfidence({
      sampleCount: 20, mean: 0, m2: 0.01,
      bands: [
        band({ sampleCount: 10, mean: 0, m2: 0.001 }),
        band({ sampleCount: 10, mean: 0, m2: 0.001 }),
      ],
    })).toBe(resolveProfileConfidence({ sampleCount: 20, mean: 0, m2: 0.01 }));
  });

  it('uses the weighted band mean as the RSD reference when the lifetime stat mean is zero but bands carry positive means', () => {
    // Edge case for the buffer-drift fix: if the lifetime running mean has not
    // yet caught up (e.g. early-life seeding) but the bands have established
    // positive means, the weighted band mean is the honest reference rather
    // than triggering a non-banded fallback against a zero global mean.
    expect(resolveBandedProfileConfidence({
      sampleCount: 20, mean: 0, m2: 0.01,
      bands: [
        band({ sampleCount: 10, mean: 0.27, m2: 0.001 }),
        band({ sampleCount: 10, mean: 0.27, m2: 0.001 }),
      ],
    })).toBe('high');
  });

  it('uses the sample-weighted band mean (not the lifetime running mean) so a drifted buffer is judged honestly', () => {
    // Lifetime stat: n=200, mean=0.30, m2=15 — RSD ≈ 0.92 → global `low`.
    // Buffered band: n=159, mean=0.10, m2=0.395 (residualDof 158) — pooled
    // σ ≈ 0.05. RSD against the buffer-weighted band mean (0.10) ≈ 0.5
    // → `medium` (correct: tight noise relative to *local* rate). RSD against
    // the lifetime mean (0.30) ≈ 0.167 → `high` — the falsely-tight answer that
    // would result from dividing pooled within-band σ by an unrelated lifetime
    // reference when the buffer has drifted toward a lower-rate band.
    expect(resolveProfileConfidence({ sampleCount: 200, mean: 0.30, m2: 15 })).toBe('low');
    expect(resolveBandedProfileConfidence({
      sampleCount: 200, mean: 0.30, m2: 15,
      bands: [band({ sampleCount: 159, mean: 0.10, m2: 0.395 })],
    })).toBe('medium');
  });
});

describe('applyBandedConfidence', () => {
  const stat = (overrides: Partial<ObjectiveProfileStat> = {}): ObjectiveProfileStat => ({
    sampleCount: 200,
    mean: 0.27,
    m2: 5.0,
    min: 0.1,
    max: 0.4,
    confidence: 'medium',
    lastUpdatedMs: 0,
    ...overrides,
  });

  it('returns the stat unchanged when no bands are present', () => {
    const input = stat();
    expect(applyBandedConfidence(input, undefined)).toBe(input);
    expect(applyBandedConfidence(input, [])).toBe(input);
  });

  it('returns undefined when the stat itself is undefined', () => {
    expect(applyBandedConfidence(undefined, [band({})])).toBeUndefined();
  });

  it('overrides only `confidence`, leaving every other stat field intact', () => {
    const input = stat({ confidence: 'medium' });
    const out = applyBandedConfidence(input, [
      band({ sampleCount: 100, mean: 0.20, m2: 0.05 }),
      band({ sampleCount: 100, mean: 0.34, m2: 0.05 }),
    ])!;
    expect(out.confidence).toBe('high');
    // every other field is preserved verbatim
    expect(out.sampleCount).toBe(input.sampleCount);
    expect(out.mean).toBe(input.mean);
    expect(out.m2).toBe(input.m2);
    expect(out.min).toBe(input.min);
    expect(out.max).toBe(input.max);
    expect(out.lastUpdatedMs).toBe(input.lastUpdatedMs);
  });
});
