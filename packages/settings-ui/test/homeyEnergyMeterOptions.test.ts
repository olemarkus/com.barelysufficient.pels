import { buildMeterSelectEntries, toMeterDeviceOptions } from '../src/ui/homeyEnergyMeter.ts';
import { resolveStaleDataBannerContent, resolveStaleDataHint } from '../src/ui/capacity.ts';

describe('toMeterDeviceOptions', () => {
  it('keeps only power-capable devices and sorts them by name', () => {
    const options = toMeterDeviceOptions([
      { id: 'sensor', name: 'Outdoor sensor', hasPower: false },
      { id: 'han', name: 'HAN meter', hasPower: true },
      { id: 'charger', name: 'EV Charger', hasPower: true },
    ]);
    expect(options).toEqual([
      { value: 'charger', label: 'EV Charger' },
      { value: 'han', label: 'HAN meter' },
    ]);
  });

  it('treats a missing hasPower flag as not power-capable', () => {
    // Defensive: a stale API without the field must not surface every device.
    expect(toMeterDeviceOptions([{ id: 'x', name: 'Legacy' }])).toEqual([]);
  });
});

describe('buildMeterSelectEntries', () => {
  const options = [
    { value: 'charger', label: 'EV Charger' },
    { value: 'han', label: 'HAN meter' },
  ];

  it('puts Automatic first', () => {
    expect(buildMeterSelectEntries(options, null, true)).toEqual([
      { value: '', label: 'Automatic' },
      ...options,
    ]);
  });

  it('keeps a selection that is in the list untouched', () => {
    expect(buildMeterSelectEntries(options, 'han', true)).toEqual([
      { value: '', label: 'Automatic' },
      ...options,
    ]);
  });

  it('appends a not-found entry for a saved id missing from the loaded list', () => {
    // A removed meter must stay visibly configured instead of silently
    // snapping the select back to Automatic; the label carries the
    // consequence, not the raw device id.
    expect(buildMeterSelectEntries(options, 'gone', true)).toEqual([
      { value: '', label: 'Automatic' },
      ...options,
      { value: 'gone', label: 'Previously selected meter (not found in Homey)' },
    ]);
  });

  it('reads as loading, not not-found, before the device list has loaded', () => {
    // A valid saved meter must never flash as broken on panel open while the
    // lazy device fetch is still in flight (or has failed and will retry).
    expect(buildMeterSelectEntries([], 'han', false)).toEqual([
      { value: '', label: 'Automatic' },
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

  it('points at the Homey Energy whole-home marking on Automatic', () => {
    expect(resolveStaleDataHint('homey_energy', false)).toBe(
      'Check that a device with "Tracks total home energy consumption" is enabled in Homey Energy.',
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
