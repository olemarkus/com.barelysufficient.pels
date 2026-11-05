import { describe, expect, it } from 'vitest';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { StorageLeverState } from '../../lib/plan/planState';
import { projectStorageDischargeObservations } from '../../lib/planInput/storageObservation';
import { resolveStorageDischargeW } from '../../lib/plan/battery/storageRelief';
import { partialDouble } from '../helpers/partialDouble';

const battery = (signedW: number, managed = true): DeviceSurfaces => partialDouble<DeviceSurfaces>({
  id: String(signedW), available: true, managed, batteryPower: { signedW, observedAtMs: 1 },
});
const held = (setpointW: number): StorageLeverState => partialDouble<StorageLeverState>({ setpointW });

describe('whole-home storage discharge observation', () => {
  it('keeps unmanaged discharge and does not cancel it against another battery charging', () => {
    const observations = projectStorageDischargeObservations([battery(-2500, false), battery(-500), battery(3000)]);
    expect(resolveStorageDischargeW(observations, {})).toBe(3000);
  });

  it('retains unavailable discharge without releasing or double-counting a larger held reservation', () => {
    const unavailable = { ...battery(-2500, false), id: 'battery', available: false };
    const observations = projectStorageDischargeObservations([unavailable]);
    expect(resolveStorageDischargeW(observations, {})).toBe(2500);
    expect(resolveStorageDischargeW(observations, { battery: held(-1500) })).toBe(2500);
    expect(resolveStorageDischargeW(observations, { battery: held(-3500) })).toBe(3500);

    const zero = { ...unavailable, batteryPower: { signedW: 0, observedAtMs: 2 } };
    expect(resolveStorageDischargeW(projectStorageDischargeObservations([zero]), { battery: held(-3500) }))
      .toBe(3500);
    expect(resolveStorageDischargeW(projectStorageDischargeObservations([{ ...zero, available: true }]), {
      battery: held(-3500),
    })).toBe(0);
    expect(resolveStorageDischargeW(projectStorageDischargeObservations([]), {})).toBe(0);
  });

  it('excludes unobserved batteries and ordinary loads while preserving an unread held discharge', () => {
    const observations = projectStorageDischargeObservations([
      partialDouble<DeviceSurfaces>({ id: 'unread-battery', available: true }),
      partialDouble<DeviceSurfaces>({ id: 'heater', available: true, measuredPowerKw: 2 }),
    ]);
    expect(observations).toEqual(new Map());
    expect(resolveStorageDischargeW(observations, { 'unread-battery': held(-1200) })).toBe(1200);
  });
});
