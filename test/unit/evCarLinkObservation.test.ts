import { describe, expect, it } from 'vitest';
import { readCarDevice } from '../../lib/device/evCarLinkObservation';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const car = (available?: boolean): HomeyDeviceLike => ({
  id: 'car-1',
  name: 'Polestar',
  class: 'car',
  ...(available === undefined ? {} : { available }),
  capabilitiesObj: {
    ev_charging_state: { value: 'plugged_in_charging' },
    measure_battery: { value: 64 },
  },
});

describe('readCarDevice availability boundary', () => {
  it('classifies an explicitly unavailable car before using cached capabilities', () => {
    expect(readCarDevice(car(false), 1_000)).toEqual({
      kind: 'unavailable',
      deviceId: 'car-1',
      name: 'Polestar',
    });
  });

  it('reads an explicitly available car', () => {
    expect(readCarDevice(car(true), 1_000)).toMatchObject({
      kind: 'observed',
      reading: { deviceId: 'car-1', state: 'plugged_in_charging', socPct: 64 },
    });
  });

  it('keeps compatibility when Homey omits availability', () => {
    expect(readCarDevice(car(), 1_000)).toMatchObject({
      kind: 'observed',
      reading: { deviceId: 'car-1', state: 'plugged_in_charging', socPct: 64 },
    });
  });
});
