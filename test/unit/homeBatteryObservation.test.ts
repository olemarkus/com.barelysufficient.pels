import { describe, expect, it } from 'vitest';
import { preserveNewerHomeBatteryPower } from '../../lib/device/transport/homeBatteryObservation';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const battery = (fields: Partial<TransportDeviceSnapshot>): TransportDeviceSnapshot => ({
  id: 'battery-1',
  name: 'Battery',
  deviceClass: 'battery',
  deviceType: 'onoff',
  targets: [],
  binaryControllable: false,
  isEvCharger: false,
  observeOnly: true,
  available: true,
  expectedPowerKw: 0,
  expectedPowerSource: 'default',
  homeBattery: { controlSurface: { kind: 'observe_only', reason: 'no_target_power' } },
  ...fields,
});

describe('preserveNewerHomeBatteryPower', () => {
  it('keeps a realtime reading newer than the pull', () => {
    const next = battery({ batteryPower: { signedW: 500, observedAtMs: 1_000 } });
    preserveNewerHomeBatteryPower(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toEqual({ signedW: -1500, observedAtMs: 2_000 });
  });

  it('takes a pull newer than the reading held', () => {
    const next = battery({ batteryPower: { signedW: 500, observedAtMs: 3_000 } });
    preserveNewerHomeBatteryPower(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toEqual({ signedW: 500, observedAtMs: 3_000 });
  });

  it('leaves a reading the pull no longer resolves absent', () => {
    const next = battery({});
    preserveNewerHomeBatteryPower(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toBeUndefined();
  });
});
