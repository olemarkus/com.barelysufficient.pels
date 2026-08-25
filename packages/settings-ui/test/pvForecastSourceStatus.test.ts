// The seam guard for the PV-forecast source status. The prices read model
// crosses the Homey API bridge into the WebView as a cast, so this nested
// object is untrusted until the receiving adapter discriminates it; these cases
// are the malformed shapes that would otherwise reach the view as provenance.
// The four rendered sentences are covered through the view
// (electricityPricesView.test.ts) and are deliberately not repeated here.
import { describe, expect, it } from 'vitest';
import { resolvePvForecastSourceUiStatus } from '../../shared-domain/src/solar/pvForecastSourceStatus.ts';

describe('resolvePvForecastSourceUiStatus', () => {
  it('passes a complete, well-formed status through unchanged', () => {
    for (const activeSource of ['homey_energy', 'learned', null] as const) {
      expect(resolvePvForecastSourceUiStatus({
        activeSource,
        homeyForecastAvailable: true,
        learnedForecastAvailable: false,
      })).toEqual({ activeSource, homeyForecastAvailable: true, learnedForecastAvailable: false });
    }
  });

  it('rejects a malformed activeSource instead of letting it fall through as learned', () => {
    // The resolver's final branch is the learned wording, so an unrecognised
    // discriminant would silently claim the learned forecast is in use.
    for (const activeSource of ['auto', 'homey', '', 0, true, undefined, {}]) {
      expect(resolvePvForecastSourceUiStatus({
        activeSource,
        homeyForecastAvailable: true,
        learnedForecastAvailable: true,
      })).toBeNull();
    }
  });

  it('rejects non-boolean availability rather than coercing it into provenance', () => {
    expect(resolvePvForecastSourceUiStatus({
      activeSource: 'homey_energy',
      homeyForecastAvailable: 'yes',
      learnedForecastAvailable: true,
    })).toBeNull();
    expect(resolvePvForecastSourceUiStatus({
      activeSource: 'homey_energy',
      homeyForecastAvailable: true,
      learnedForecastAvailable: 1,
    })).toBeNull();
  });

  it('rejects a partial object rather than repairing it field by field', () => {
    expect(resolvePvForecastSourceUiStatus({ activeSource: 'learned' })).toBeNull();
    expect(resolvePvForecastSourceUiStatus({})).toBeNull();
  });

  it('resolves genuine absence and non-objects to null (the pre-boot say-nothing state)', () => {
    for (const value of [null, undefined, 'learned', 7, [], [{ activeSource: 'learned' }]]) {
      expect(resolvePvForecastSourceUiStatus(value)).toBeNull();
    }
  });
});
