import { buildMeterSelectEntries, METER_NOT_CHOSEN_VALUE, toMeterDeviceOptions } from '../src/ui/homeyEnergyMeter.ts';
import { resolvePowerReadingsBannerContent } from '../../shared-domain/src/powerReadingsBanner.ts';

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

describe('resolvePowerReadingsBannerContent', () => {
  const base = { nowMs: 10 * 60 * 1000 };

  it('hides the banner while the last sample is fresh', () => {
    expect(resolvePowerReadingsBannerContent({
      ...base, readings: { state: 'received', lastPowerUpdateMs: base.nowMs - 1000 }, source: 'flow', meterChosen: false,
    })).toBeNull();
  });

  it('names both remedies for a flow home that never received a reading', () => {
    expect(resolvePowerReadingsBannerContent({
      ...base, readings: { state: 'never' }, source: 'flow', meterChosen: false,
    })).toEqual({
      text: 'No power readings yet. Set up a Flow with the Report power usage action, or pick a '
        + 'whole-home meter under Limits & safety.',
      actionLabel: 'Check power source',
    });
  });

  it('points a silent flow home at its Flow', () => {
    expect(resolvePowerReadingsBannerContent({
      ...base, readings: { state: 'received', lastPowerUpdateMs: 1000 }, source: 'flow', meterChosen: false,
    })).toEqual({
      text: 'No power readings in the last minute. Check the Flow that runs Report power usage.',
      actionLabel: 'Check power source',
    });
  });

  it('points a Homey Energy home at its chosen meter, or at the picker before one is chosen', () => {
    expect(resolvePowerReadingsBannerContent({
      ...base, readings: { state: 'received', lastPowerUpdateMs: 1000 }, source: 'homey_energy', meterChosen: true,
    })?.text).toBe('No power readings in the last minute. Check that the selected whole-home '
      + 'meter is available and reporting power in Homey Energy.');
    expect(resolvePowerReadingsBannerContent({
      ...base, readings: { state: 'never' }, source: 'homey_energy', meterChosen: false,
    })?.text).toBe('No power readings yet. Pick a whole-home meter under Limits & safety.');
  });
});
