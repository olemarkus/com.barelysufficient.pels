import {
  OBJECTIVE_PROFILE_MIN_BAND_SAMPLES,
  fitBandsFromSamples,
} from '../../lib/objectives/bands';
import type { ObjectiveProfileSampleObservation } from '../../lib/objectives/types';

// Captured 2026-05-23 from a Mill v2 mock driven through two consecutive
// regimes designed to produce two clearly separated `kwhPerUnit` clusters:
//   * 4 walks at 1500 W in the 19–21 °C band → ≈0.30 kWh/°C
//   * 4 walks at 2500 W in the 21–23 °C band → ≈0.50 kWh/°C
// Six samples landed in the ring buffer at audit time. Verbatim from
// `/tmp/thermal-multiband-live-20260523-132901/pels.settings.after.json`.
const SHS_BUFFERED_SAMPLES: readonly ObjectiveProfileSampleObservation[] = [
  { observedAtMs: 1779536502637, inputValue: 20.25, kwhPerUnit: 0.3005175 },
  { observedAtMs: 1779536863298, inputValue: 20.75, kwhPerUnit: 0.3005508333333333 },
  { observedAtMs: 1779537229144, inputValue: 21.25, kwhPerUnit: 0.3078433333333333 },
  { observedAtMs: 1779537589655, inputValue: 21.75, kwhPerUnit: 0.5007097222222222 },
  { observedAtMs: 1779537950117, inputValue: 22.25, kwhPerUnit: 0.5006416666666667 },
  { observedAtMs: 1779538310590, inputValue: 22.75, kwhPerUnit: 0.5006569444444445 },
];

// SHS replay analysis (2026-05-23). The captured buffer holds 6 samples,
// which is below the fitter's hard floor of `OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2 = 16`.
// The fitter therefore returns `undefined` at the entry guard before any
// SSE calculation runs — `MIN_SSE_REDUCTION_FRACTION` is irrelevant to this
// regression. The acceptance test below pins that decision so future
// proposals to tune the SSE fraction can't silently regress the gate.
describe('fitBandsFromSamples — SHS multi-band replay (2026-05-23)', () => {
  it('returns undefined because the buffer is below the min-samples gate', () => {
    expect(SHS_BUFFERED_SAMPLES).toHaveLength(6);
    expect(SHS_BUFFERED_SAMPLES.length).toBeLessThan(OBJECTIVE_PROFILE_MIN_BAND_SAMPLES * 2);
    expect(
      fitBandsFromSamples({
        samples: [...SHS_BUFFERED_SAMPLES],
        kind: 'temperature',
      }),
    ).toBeUndefined();
  });
});
