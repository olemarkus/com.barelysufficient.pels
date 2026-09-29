import { describe, expect, it } from 'vitest';
import { readCarDevice, resolveCarAssociationCandidates } from '../../lib/device/evCarLinkObservation';
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

describe('resolveCarAssociationCandidates', () => {
  it('returns only id-bearing cars with both capabilities needed by the probe', () => {
    expect(resolveCarAssociationCandidates([
      { ...car(true), capabilities: ['ev_charging_state', 'measure_battery'] },
      { ...car(true), id: 'incomplete', capabilities: ['ev_charging_state'] },
      { id: 'heater', name: 'Tank', class: 'heater', capabilities: ['ev_charging_state', 'measure_battery'] },
    ])).toEqual([{ id: 'car-1', name: 'Polestar' }]);
  });

  it('offers Hyundai-shaped vehicles only with both standard EV capabilities', () => {
    const vehicle = { ...car(true), class: 'vehicle', name: 'Ioniq 5' };
    expect(resolveCarAssociationCandidates([
      { ...vehicle, capabilities: ['ev_charging_state', 'measure_battery'] },
      { ...vehicle, id: 'no-plug-state', capabilities: ['measure_battery'] },
      { ...vehicle, id: 'no-battery', capabilities: ['ev_charging_state'] },
      { ...vehicle, id: '', capabilities: ['ev_charging_state', 'measure_battery'] },
      { ...vehicle, id: 'legacy', class: 'sensor', capabilities: ['charger', 'charging', 'measure_battery.EV'] },
    ])).toEqual([{ id: 'car-1', name: 'Ioniq 5' }]);
    expect(readCarDevice(vehicle, 1_000)).toMatchObject({
      kind: 'observed',
      reading: { deviceId: 'car-1', state: 'plugged_in_charging', socPct: 64 },
    });
  });
});
