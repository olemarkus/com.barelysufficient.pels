import {
  OBJECTIVE_PROFILE_MAX_BANDS,
  OBJECTIVE_PROFILE_MIN_BAND_SAMPLES,
  OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE,
  appendSampleToBuffer,
  fitBandsFromSamples,
} from '../../lib/objectives/bands';
import type { ObjectiveProfileSampleObservation } from '../../lib/objectives/types';

const baseMs = Date.UTC(2026, 0, 1);

const sample = (
  inputValue: number,
  kwhPerUnit: number,
  ageOffsetMs = 0,
): ObjectiveProfileSampleObservation => ({
  observedAtMs: baseMs + ageOffsetMs,
  inputValue,
  kwhPerUnit,
});

const buildLinearSamples = (count: number, kwhPerUnit: number): ObjectiveProfileSampleObservation[] => {
  const out: ObjectiveProfileSampleObservation[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(sample(30 + i, kwhPerUnit, i));
  }
  return out;
};

describe('appendSampleToBuffer', () => {
  it('caps the buffer at the maximum size and drops the oldest entry', () => {
    let buffer: ObjectiveProfileSampleObservation[] | undefined;
    for (let i = 0; i < OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE + 5; i += 1) {
      buffer = appendSampleToBuffer(buffer, sample(i, 0.1, i));
    }
    expect(buffer).toHaveLength(OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE);
    expect(buffer?.[0].inputValue).toBe(5);
    expect(buffer?.[buffer.length - 1].inputValue).toBe(OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE + 4);
  });

  it('preserves insertion order when below the cap', () => {
    const buffer = [sample(1, 0.1, 0), sample(2, 0.2, 1)];
    const next = appendSampleToBuffer(buffer, sample(3, 0.3, 2));
    expect(next.map((entry) => entry.inputValue)).toEqual([1, 2, 3]);
  });
});

describe('fitBandsFromSamples', () => {
  it('returns undefined when the buffer is below the split threshold', () => {
    const samples = buildLinearSamples(OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2 - 1, 0.5);
    expect(fitBandsFromSamples({ samples, kind: 'temperature' })).toBeUndefined();
  });

  it('returns a single band when the data is homogeneous', () => {
    const samples = buildLinearSamples(20, 0.5);
    const bands = fitBandsFromSamples({ samples, kind: 'temperature' });
    expect(bands).toBeDefined();
    expect(bands).toHaveLength(1);
    expect(bands?.[0].mean).toBeCloseTo(0.5, 6);
    expect(bands?.[0].lowerInclusive).toBe(30);
  });

  it('splits the range where kWh-per-unit jumps significantly', () => {
    // Lower half cheap (0.1 kWh/°C), upper half expensive (0.5 kWh/°C).
    const samples: ObjectiveProfileSampleObservation[] = [];
    for (let i = 0; i < 12; i += 1) samples.push(sample(30 + i, 0.1, i));
    for (let i = 0; i < 12; i += 1) samples.push(sample(42 + i, 0.5, 12 + i));
    const bands = fitBandsFromSamples({ samples, kind: 'temperature' });
    expect(bands).toBeDefined();
    expect(bands!.length).toBeGreaterThanOrEqual(2);
    const sortedBands = [...bands!].sort((a, b) => a.lowerInclusive - b.lowerInclusive);
    expect(sortedBands[0].mean).toBeCloseTo(0.1, 3);
    expect(sortedBands[sortedBands.length - 1].mean).toBeCloseTo(0.5, 3);
  });

  it('never emits a band with fewer than the minimum samples', () => {
    // Strongly bimodal data; the fitter is free to pick whatever splits it
    // wants, but no resulting band may contain fewer than
    // OBJECTIVE_PROFILE_MIN_BAND_SAMPLES rows. This is the invariant the
    // min-samples constraint protects.
    const samples: ObjectiveProfileSampleObservation[] = [];
    for (let i = 0; i < 8; i += 1) samples.push(sample(30 + i, 0.1, i));
    for (let i = 0; i < 12; i += 1) samples.push(sample(40 + i, 0.9, 8 + i));
    const bands = fitBandsFromSamples({ samples, kind: 'temperature' });
    expect(bands).toBeDefined();
    for (const band of bands!) {
      expect(band.sampleCount).toBeGreaterThanOrEqual(OBJECTIVE_PROFILE_MIN_BAND_SAMPLES);
    }
  });

  it('caps the band count at OBJECTIVE_PROFILE_MAX_BANDS', () => {
    // Construct strongly multimodal data: four clusters of distinct means.
    const samples: ObjectiveProfileSampleObservation[] = [];
    const means = [0.1, 0.3, 0.6, 1.0, 1.5];
    means.forEach((mean, clusterIdx) => {
      for (let i = 0; i < 10; i += 1) {
        samples.push(sample(clusterIdx * 20 + i, mean, clusterIdx * 10 + i));
      }
    });
    const bands = fitBandsFromSamples({ samples, kind: 'temperature' });
    expect(bands).toBeDefined();
    expect(bands!.length).toBeLessThanOrEqual(OBJECTIVE_PROFILE_MAX_BANDS);
  });

  it('forces an anchor split at 80% SoC for EV profiles when data straddles taper', () => {
    // Constant 0.15 kWh/% on both sides — without the anchor, no split would
    // be picked because there is no variance to reduce.
    const samples: ObjectiveProfileSampleObservation[] = [];
    for (let i = 0; i < 12; i += 1) samples.push(sample(60 + i, 0.15, i));
    for (let i = 0; i < 12; i += 1) samples.push(sample(80 + i, 0.15, 12 + i));
    const bands = fitBandsFromSamples({ samples, kind: 'ev_soc' });
    expect(bands).toBeDefined();
    expect(bands!.length).toBeGreaterThanOrEqual(2);
    const sortedBands = [...bands!].sort((a, b) => a.lowerInclusive - b.lowerInclusive);
    expect(sortedBands[0].upperExclusive).toBe(80);
    expect(sortedBands[1].lowerInclusive).toBe(80);
  });

  it('does not force a band edge at 80% when one side is too sparse', () => {
    // 16 below 80% and only 3 at/above — the EV anchor would violate min
    // samples on the upper side, so no produced band may have an edge
    // exactly at 80. (Greedy splits elsewhere are allowed if they reduce
    // variance, but they will not coincide with the anchor.)
    const samples: ObjectiveProfileSampleObservation[] = [];
    for (let i = 0; i < 16; i += 1) samples.push(sample(60 + i, 0.15, i));
    for (let i = 0; i < 3; i += 1) samples.push(sample(82 + i, 0.5, 16 + i));
    const bands = fitBandsFromSamples({ samples, kind: 'ev_soc' });
    expect(bands).toBeDefined();
    for (const band of bands!) {
      expect(band.lowerInclusive).not.toBe(80);
      expect(band.upperExclusive).not.toBe(80);
    }
  });
});
