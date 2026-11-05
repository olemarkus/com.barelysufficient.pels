import { describe, expect, it } from 'vitest';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { projectObservedBatteryPowerW } from '../../lib/planInput/storageObservation';
import { partialDouble } from '../helpers/partialDouble';

const battery = (signedW: number, managed = true): DeviceSurfaces => partialDouble<DeviceSurfaces>({
  id: String(signedW), available: true, managed, batteryPower: { signedW, observedAtMs: 1 },
});

describe('whole-home storage discharge observation', () => {
  it('keeps unmanaged discharge and does not cancel it against another battery charging', () => {
    expect(projectObservedBatteryPowerW([battery(-2500, false), battery(-500), battery(3000)]))
      .toEqual(new Map([['-2500', -2500], ['-500', -500], ['3000', 3000]]));
  });

  it('excludes unavailable and unobserved batteries and ordinary loads', () => {
    expect(projectObservedBatteryPowerW([
      { ...battery(-2500), available: false },
      partialDouble<DeviceSurfaces>({ id: 'unread-battery', available: true }),
      partialDouble<DeviceSurfaces>({ id: 'heater', available: true, measuredPowerKw: 2 }),
    ])).toEqual(new Map());
    expect(projectObservedBatteryPowerW([])).toEqual(new Map());
  });
});
