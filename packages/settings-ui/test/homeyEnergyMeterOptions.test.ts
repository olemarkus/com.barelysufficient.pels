import { buildMeterSelectEntries, METER_NOT_CHOSEN_VALUE, toMeterDeviceOptions } from '../src/ui/homeyEnergyMeter.ts';
import { resolveStaleDataBannerContent, resolveStaleDataHint } from '../src/ui/capacity.ts';

describe('toMeterDeviceOptions', () => {
  it('maps the resolved meters to options and sorts them by name', () => {
    // The producer already narrowed to real meters; the UI just maps + sorts.
    const options = toMeterDeviceOptions([
      { id: 'pulse', name: 'Tibber Pulse' },
      { id: 'han', name: 'HAN meter' },
      { id: 'subpanel', name: 'Garage submeter' },
    ]);
    expect(options).toEqual([
      { value: 'subpanel', label: 'Garage submeter' },
      { value: 'han', label: 'HAN meter' },
      { value: 'pulse', label: 'Tibber Pulse' },
    ]);
  });

  it('returns nothing for an empty meter list', () => {
    expect(toMeterDeviceOptions([])).toEqual([]);
  });
});

describe('buildMeterSelectEntries', () => {
  const options = [
    { value: 'charger', label: 'EV Charger' },
    { value: 'han', label: 'HAN meter' },
  ];

  it('leads with the placeholder while no meter is chosen yet', () => {
    expect(buildMeterSelectEntries(options, null, true)).toEqual([
      { value: METER_NOT_CHOSEN_VALUE, label: 'Choose a meter' },
      ...options,
    ]);
  });

  it('says No meters found when the loaded list is empty and nothing is chosen', () => {
    expect(buildMeterSelectEntries([], null, true)).toEqual([
      { value: METER_NOT_CHOSEN_VALUE, label: 'No meters found' },
    ]);
  });

  it('drops the placeholder once a meter is chosen (there is no un-choose)', () => {
    expect(buildMeterSelectEntries(options, 'han', true)).toEqual(options);
  });

  it('appends a not-found entry for a saved id missing from the loaded list', () => {
    // A removed meter must stay visibly configured instead of silently
    // reading as broken; the label carries the consequence, not the raw
    // device id.
    expect(buildMeterSelectEntries(options, 'gone', true)).toEqual([
      ...options,
      { value: 'gone', label: 'Previously selected meter (not found in Homey)' },
    ]);
  });

  it('reads as loading, not not-found, before the meter list has loaded', () => {
    // A valid saved meter must never flash as broken on panel open while the
    // lazy report fetch is still in flight (or has failed and will retry).
    expect(buildMeterSelectEntries([], 'han', false)).toEqual([
      { value: 'han', label: 'Selected meter (loading…)' },
    ]);
  });
});

describe('resolveStaleDataHint', () => {
  it('points at the selected meter when one is configured', () => {
    expect(resolveStaleDataHint('homey_energy', true)).toBe(
      'Check that the selected whole-home meter is available and reporting power in Homey Energy.',
    );
  });

  it('points at the picker while no whole-home meter is chosen yet', () => {
    expect(resolveStaleDataHint('homey_energy', false)).toBe(
      'Pick a whole-home meter under Limits & safety.',
    );
  });

  it('points at the reporting Flow for the flow source', () => {
    expect(resolveStaleDataHint('flow', false)).toBe('Check your Flow that reports power usage.');
    expect(resolveStaleDataHint(undefined, false)).toBe('Check your Flow that reports power usage.');
  });
});

describe('resolveStaleDataBannerContent', () => {
  const hint = 'Check your Flow that reports power usage.';

  it('shows onboarding copy on a fresh install (no source persisted, no sample ever)', () => {
    expect(resolveStaleDataBannerContent({
      lastPowerUpdate: null, nowMs: 1000, powerSourceConfigured: false, hint,
    })).toEqual({
      text: 'No power data yet. PELS needs to know where to read your home’s power usage.',
      actionLabel: 'Choose power source',
    });
  });

  it('shows the source-specific hint when a source is persisted but no sample arrived', () => {
    expect(resolveStaleDataBannerContent({
      lastPowerUpdate: null, nowMs: 1000, powerSourceConfigured: true, hint,
    })).toEqual({
      text: `No power data received yet. ${hint}`,
      actionLabel: 'Check power source',
    });
  });

  it('shows the stale copy once the last sample ages past the threshold, regardless of configuration', () => {
    const nowMs = 10 * 60 * 1000;
    expect(resolveStaleDataBannerContent({
      lastPowerUpdate: 1000, nowMs, powerSourceConfigured: false, hint,
    })).toEqual({
      text: `No power data received in the last minute. ${hint}`,
      actionLabel: 'Check power source',
    });
  });

  it('hides the banner while the last sample is fresh', () => {
    expect(resolveStaleDataBannerContent({
      lastPowerUpdate: 1000, nowMs: 2000, powerSourceConfigured: true, hint,
    })).toBeNull();
  });
});
