import { resolveMeterImportCounter, resolveMeterImportCounters } from '../../lib/device/transport/meterImportCounterRead';
import { readMeterSample } from '../../lib/home/homeMeters';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const meter = (entry: unknown): HomeyDeviceLike => ({
  id: 'meter-1',
  name: 'Meter',
  capabilities: ['measure_power', 'meter_power.imported'],
  capabilitiesObj: { 'meter_power.imported': entry },
} as unknown as HomeyDeviceLike);

describe('the meter import counter read', () => {
  it('reads the kWh and when the meter last changed it', () => {
    expect(resolveMeterImportCounter(meter({ value: 12345.67, lastUpdated: '2026-11-17T07:11:00.000Z' }))).toEqual({
      meterDeviceId: 'meter-1',
      importedKWh: 12345.67,
      observedAtMs: Date.parse('2026-11-17T07:11:00.000Z'),
    });
  });

  it.each([
    ['a missing capability', undefined],
    ['a negative value', { value: -1, lastUpdated: '2026-11-17T07:11:00.000Z' }],
    ['a non-finite value', { value: Number.NaN, lastUpdated: '2026-11-17T07:11:00.000Z' }],
    ['a null value', { value: null, lastUpdated: '2026-11-17T07:11:00.000Z' }],
    ['an undated value', { value: 12345.67 }],
  ])('reads no counter from %s', (_name, entry) => {
    expect(resolveMeterImportCounter(meter(entry))).toBeNull();
  });

  it('reads only the requested meters from fetched devices', () => {
    const dated = { value: 5, lastUpdated: '2026-11-17T07:11:00.000Z' };
    const other = { ...meter(dated), id: 'other' } as HomeyDeviceLike;
    expect(Object.keys(resolveMeterImportCounters([meter(dated), other], ['meter-1']))).toEqual(['meter-1']);
    expect(resolveMeterImportCounters([meter(undefined)], ['meter-1'])).toEqual({});
  });

  it('rides the sample of the meter it was read from', () => {
    const importCounter = { meterDeviceId: 'meter-1', importedKWh: 5, observedAtMs: 1 };
    expect(readMeterSample({ meterPowerW: { 'meter-1': 1200 }, importCounters: { 'meter-1': importCounter } }, 'meter-1'))
      .toEqual({ powerW: 1200, meterDeviceId: 'meter-1', importCounter });
    expect(readMeterSample({ meterPowerW: { 'meter-1': 1200 } }, 'meter-1'))
      .toEqual({ powerW: 1200, meterDeviceId: 'meter-1' });
  });
});
