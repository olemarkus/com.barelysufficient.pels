import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeMeters, readMeterSample, resolveMainMeterRead, type SubHomeMeters } from '../../lib/home/homeMeters';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../lib/utils/settingsKeys';
import { captureLogger } from '../utils/loggerCapture';

// A settings store holding (or not holding) Main's meter selection.
const settingsWith = (values: Record<string, unknown>) => ({
  get: (key: string): unknown => (key in values ? values[key] : null),
  getKeys: (): string[] => Object.keys(values),
});
const mainSelected = settingsWith({ [HOMEY_ENERGY_METER_DEVICE_ID]: 'meter-main', other: true });
const noMainSelected = settingsWith({ other: true });

const subHomes = (meterDeviceIds: string[]) => {
  const routeMeterReadings = vi.fn<SubHomeMeters['routeMeterReadings']>();
  return { getMeterDeviceIds: () => meterDeviceIds, routeMeterReadings };
};

describe('HomeMeters', () => {
  it('requests Main\'s meter and every sub-home\'s, once each', () => {
    const homes = new HomeMeters(mainSelected, vi.fn(), () => subHomes(['m-area', 'meter-main']));
    expect(homes.request().meterDeviceIds).toEqual(['meter-main', 'm-area']);
  });

  it('requests only the sub-homes while no Main meter is selected, and none before the registry exists', () => {
    expect(new HomeMeters(noMainSelected, vi.fn(), () => subHomes(['m-area'])).request().meterDeviceIds)
      .toEqual(['m-area']);
    expect(new HomeMeters(noMainSelected, vi.fn(), () => undefined).request().meterDeviceIds).toEqual([]);
  });

  it('routes each reading to its home: Main as an identity-stamped sample, the sub-homes to their bundles', async () => {
    const recordMainSample = vi.fn().mockResolvedValue(undefined);
    const areas = subHomes(['m-area']);
    const request = new HomeMeters(mainSelected, recordMainSample, () => areas).request();

    await request.record({ meterPowerW: { 'meter-main': 2_000, 'm-area': 600 }, generationW: 150 });

    expect(recordMainSample).toHaveBeenCalledWith({ powerW: 2_000, generationW: 150, meterDeviceId: 'meter-main' });
    expect(areas.routeMeterReadings).toHaveBeenCalledWith({ 'meter-main': 2_000, 'm-area': 600 }, expect.any(Number));
  });

  it('records no Main sample when Main\'s meter did not answer', async () => {
    const recordMainSample = vi.fn();
    const request = new HomeMeters(mainSelected, recordMainSample, () => undefined).request();

    await request.record({ meterPowerW: {} });

    expect(recordMainSample).not.toHaveBeenCalled();
  });

  it('keeps Main\'s sample when a sub-home\'s routing throws', async () => {
    const recordMainSample = vi.fn().mockResolvedValue(undefined);
    const areas = subHomes(['m-area']);
    areas.routeMeterReadings.mockImplementation(() => { throw new Error('bundle torn down'); });
    const request = new HomeMeters(mainSelected, recordMainSample, () => areas).request();

    await request.record({ meterPowerW: { 'meter-main': 2_000, 'm-area': 600 } });

    expect(recordMainSample).toHaveBeenCalledWith({ powerW: 2_000, meterDeviceId: 'meter-main' });
  });

  // The meter is captured with the request: a selection that changes while
  // the read is in flight does not move this poll's reading to another meter.
  it('routes Main\'s reading to the meter selected when the request was made', async () => {
    const values: Record<string, unknown> = { [HOMEY_ENERGY_METER_DEVICE_ID]: 'meter-main' };
    const recordMainSample = vi.fn().mockResolvedValue(undefined);
    const request = new HomeMeters(settingsWith(values), recordMainSample, () => undefined).request();
    values[HOMEY_ENERGY_METER_DEVICE_ID] = 'meter-new';

    await request.record({ meterPowerW: { 'meter-main': 2_000, 'meter-new': 50 } });

    expect(recordMainSample).toHaveBeenCalledWith({ powerW: 2_000, meterDeviceId: 'meter-main' });
  });
});

describe('readMeterSample', () => {
  it('stamps the meter and carries the generation, or answers null for a silent meter', () => {
    expect(readMeterSample({ meterPowerW: { m: 10 }, generationW: 3 }, 'm'))
      .toEqual({ powerW: 10, generationW: 3, meterDeviceId: 'm' });
    expect(readMeterSample({ meterPowerW: { m: 10 } }, 'm')).toEqual({ powerW: 10, meterDeviceId: 'm' });
    expect(readMeterSample({ meterPowerW: {} }, 'm')).toBeNull();
  });
});

describe('resolveMainMeterRead', () => {
  it('requests the selected meter and builds its sample from the readings', () => {
    const main = resolveMainMeterRead({ state: 'resolved', meterDeviceId: 'meter-main' });
    expect(main.meterDeviceIds).toEqual(['meter-main']);
    expect(main.sampleFrom({ meterPowerW: { 'meter-main': 900 } })).toEqual({ powerW: 900, meterDeviceId: 'meter-main' });
    expect(main.sampleFrom({ meterPowerW: {} })).toBeNull();
  });

  it('requests nothing and builds no sample while no meter is selected', () => {
    for (const state of ['unconfigured', 'unavailable'] as const) {
      const main = resolveMainMeterRead({ state });
      expect(main.meterDeviceIds).toEqual([]);
      expect(main.sampleFrom({ meterPowerW: { 'meter-main': 900 } })).toBeNull();
    }
  });

  describe('main_meter_no_reading', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is said when the reason changes and then once a minute, and again at once after a reading', () => {
      vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00Z') });
      const capture = captureLogger();
      try {
        const main = resolveMainMeterRead({ state: 'resolved', meterDeviceId: 'meter-main' });
        const silent = { meterPowerW: {} };
        const noMeter = resolveMainMeterRead({ state: 'unconfigured' });
        const said = () => capture.findEvents('main_meter_no_reading');
        // A reading clears what earlier cases left in the module's gate.
        main.sampleFrom({ meterPowerW: { 'meter-main': 900 } });

        main.sampleFrom(silent);
        vi.advanceTimersByTime(10_000);
        main.sampleFrom(silent);
        expect(said()).toEqual([expect.objectContaining({ reasonCode: 'no_reading', meterDeviceId: 'meter-main' })]);

        vi.advanceTimersByTime(50_000);
        main.sampleFrom(silent);
        expect(said()).toHaveLength(2);

        noMeter.sampleFrom(silent);
        noMeter.sampleFrom(silent);
        expect(said()).toHaveLength(3);
        expect(said()[2]).toMatchObject({ reasonCode: 'not_selected', selectionState: 'unconfigured' });

        main.sampleFrom(silent);
        main.sampleFrom({ meterPowerW: { 'meter-main': 900 } });
        main.sampleFrom(silent);
        expect(said()).toHaveLength(5);
      } finally {
        capture.restore();
      }
    });
  });
});
