// The seam guard for the PV-forecast source status. The prices read model
// crosses the Homey API bridge into the WebView as a cast, so this nested
// object is untrusted until the receiving adapter discriminates it; these cases
// are the malformed shapes that would otherwise reach the view as provenance.
// Everything the guard rejects resolves to the status union's own `unknown`
// member — the say-nothing state — never to a nullable value the view has to
// defend against. The four rendered sentences are covered through the view
// (electricityPricesView.test.ts) and are deliberately not repeated here.
import { describe, expect, it } from 'vitest';
import { resolvePvForecastSourceUiStatus } from '../../shared-domain/src/solar/pvForecastSourceStatus.ts';

const UNKNOWN = { kind: 'unknown' };

describe('resolvePvForecastSourceUiStatus', () => {
  it('passes a complete, well-formed selection through unchanged', () => {
    for (const activeSource of ['homey_energy', 'learned'] as const) {
      expect(resolvePvForecastSourceUiStatus({
        kind: 'selected',
        activeSource,
        homeyForecastAvailable: true,
        learnedForecastAvailable: false,
      })).toEqual({
        kind: 'selected', activeSource, homeyForecastAvailable: true, learnedForecastAvailable: false,
      });
    }
  });

  it('resolves the runtime pre-boot member to unknown', () => {
    expect(resolvePvForecastSourceUiStatus({ kind: 'unknown' })).toEqual(UNKNOWN);
  });

  it('rejects a malformed activeSource instead of letting it fall through as learned', () => {
    // The line resolver's final branch is the learned wording, so an
    // unrecognised discriminant would silently claim the learned forecast is
    // in use. `auto` is rejected too: the selector always resolves it to one of
    // the two producers, so it is never a REPORTED active source.
    for (const activeSource of ['auto', 'homey', '', 0, true, null, undefined, {}]) {
      expect(resolvePvForecastSourceUiStatus({
        kind: 'selected',
        activeSource,
        homeyForecastAvailable: true,
        learnedForecastAvailable: true,
      })).toEqual(UNKNOWN);
    }
  });

  it('rejects non-boolean availability rather than coercing it into provenance', () => {
    expect(resolvePvForecastSourceUiStatus({
      kind: 'selected',
      activeSource: 'homey_energy',
      homeyForecastAvailable: 'yes',
      learnedForecastAvailable: true,
    })).toEqual(UNKNOWN);
    expect(resolvePvForecastSourceUiStatus({
      kind: 'selected',
      activeSource: 'homey_energy',
      homeyForecastAvailable: true,
      learnedForecastAvailable: 1,
    })).toEqual(UNKNOWN);
  });

  it('rejects a partial object rather than repairing it field by field', () => {
    expect(resolvePvForecastSourceUiStatus({ kind: 'selected', activeSource: 'learned' })).toEqual(UNKNOWN);
    expect(resolvePvForecastSourceUiStatus({})).toEqual(UNKNOWN);
  });

  it('rejects a well-formed selection that carries no discriminant', () => {
    expect(resolvePvForecastSourceUiStatus({
      activeSource: 'learned',
      homeyForecastAvailable: false,
      learnedForecastAvailable: true,
    })).toEqual(UNKNOWN);
  });

  it('resolves genuine absence and non-objects to unknown (the pre-boot say-nothing state)', () => {
    for (const value of [null, undefined, 'learned', 7, [], [{ activeSource: 'learned' }]]) {
      expect(resolvePvForecastSourceUiStatus(value)).toEqual(UNKNOWN);
    }
  });
});
