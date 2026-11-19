import {
  OBJECTIVE_PROFILE_MIN_BAND_SAMPLES,
  fitBandsFromSamples,
} from '../../lib/objectives/bands';
import type { ObjectiveProfileSampleObservation } from '../../lib/objectives/types';

// Six observations form two clear clusters, with too few samples to fit bands.
const samples: readonly ObjectiveProfileSampleObservation[] = [
  { observedAtMs: 0, inputValue: 20.25, kwhPerUnit: 0.30 },
  { observedAtMs: 360_000, inputValue: 20.75, kwhPerUnit: 0.30 },
  { observedAtMs: 720_000, inputValue: 21.25, kwhPerUnit: 0.31 },
  { observedAtMs: 1_080_000, inputValue: 21.75, kwhPerUnit: 0.50 },
  { observedAtMs: 1_440_000, inputValue: 22.25, kwhPerUnit: 0.50 },
  { observedAtMs: 1_800_000, inputValue: 22.75, kwhPerUnit: 0.50 },
];

describe('fitBandsFromSamples with sparse observations', () => {
  it('returns undefined because the buffer is below the min-samples gate', () => {
    expect(samples).toHaveLength(6);
    expect(samples.length).toBeLessThan(OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2);
    expect(
      fitBandsFromSamples({
        samples: [...samples],
      }),
    ).toBeUndefined();
  });
});
