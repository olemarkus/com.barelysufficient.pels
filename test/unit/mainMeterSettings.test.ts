import { describe, expect, it, vi } from 'vitest';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../lib/utils/settingsKeys';
import {
  readMainMeterSelection,
} from '../../setup/mainMeterSettings';

describe('Main meter settings boundary', () => {
  it('normalizes an explicit id and accepts a truly absent setting as Automatic', () => {
    expect(readMainMeterSelection({
      get: () => '  meter-main  ',
      getKeys: () => [HOMEY_ENERGY_METER_DEVICE_ID],
    })).toEqual({ state: 'resolved', meterDeviceId: 'meter-main' });
    expect(readMainMeterSelection({
      get: () => undefined,
      getKeys: () => ['power_source'],
    })).toEqual({ state: 'resolved', meterDeviceId: null });
  });

  it('classifies listed-but-undefined, an empty key list, and malformed values as suspect', () => {
    expect(readMainMeterSelection({
      get: () => undefined,
      getKeys: () => [HOMEY_ENERGY_METER_DEVICE_ID],
    }).state).toBe('unavailable');
    expect(readMainMeterSelection({
      get: () => undefined,
      getKeys: () => [],
    }).state).toBe('unavailable');
    expect(readMainMeterSelection({
      get: () => 42,
      getKeys: () => [HOMEY_ENERGY_METER_DEVICE_ID],
    }).state).toBe('unavailable');
  });

  it('contains read failures as semantic unavailable authority', () => {
    const settings = {
      get: vi.fn(() => {
        throw new Error('settings unavailable');
      }),
      getKeys: vi.fn(() => []),
    };
    expect(readMainMeterSelection(settings)).toEqual({ state: 'unavailable' });
  });
});
