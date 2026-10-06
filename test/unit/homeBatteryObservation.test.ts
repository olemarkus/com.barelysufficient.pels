import { describe, expect, it } from 'vitest';
import {
  preserveNewerHomeBatteryReadings,
  toBatteryControlRead,
} from '../../lib/device/transport/homeBatteryObservation';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const battery = (fields: Partial<TransportDeviceSnapshot>): TransportDeviceSnapshot => ({
  id: 'battery-1',
  name: 'Battery',
  deviceClass: 'battery',
  deviceType: 'onoff',
  targets: [],
  binaryControllable: false,
  isEvCharger: false,
  isBatteryOrSolar: true,
  available: true,
  expectedPowerKw: 0,
  expectedPowerSource: 'default',
  homeBattery: { controlSurface: { kind: 'observe_only', reason: 'no_target_power' } },
  ...fields,
});

describe('preserveNewerHomeBatteryReadings', () => {
  it('keeps a realtime reading newer than the pull', () => {
    const next = battery({ batteryPower: { signedW: 500, observedAtMs: 1_000 } });
    preserveNewerHomeBatteryReadings(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toEqual({ signedW: -1500, observedAtMs: 2_000 });
  });

  it('takes a pull newer than the reading held', () => {
    const next = battery({ batteryPower: { signedW: 500, observedAtMs: 3_000 } });
    preserveNewerHomeBatteryReadings(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toEqual({ signedW: 500, observedAtMs: 3_000 });
  });

  it('leaves a reading the pull no longer resolves absent', () => {
    const next = battery({});
    preserveNewerHomeBatteryReadings(battery({ batteryPower: { signedW: -1500, observedAtMs: 2_000 } }), next);

    expect(next.batteryPower).toBeUndefined();
  });

  it('keeps a realtime level newer than the pull', () => {
    const next = battery({ batteryLevel: { percent: 40, observedAtMs: 1_000 } });
    preserveNewerHomeBatteryReadings(battery({ batteryLevel: { percent: 62, observedAtMs: 2_000 } }), next);

    expect(next.batteryLevel).toEqual({ percent: 62, observedAtMs: 2_000 });
  });

  it('takes a pulled level newer than the level held', () => {
    const next = battery({ batteryLevel: { percent: 70, observedAtMs: 3_000 } });
    preserveNewerHomeBatteryReadings(battery({ batteryLevel: { percent: 62, observedAtMs: 2_000 } }), next);

    expect(next.batteryLevel).toEqual({ percent: 70, observedAtMs: 3_000 });
  });
});

describe('toBatteryControlRead', () => {
  const surface = {
    kind: 'setpoint',
    claim: { capabilityId: 'target_power_mode', homeyValue: 'homey', values: ['homey', 'anti_feed'], rejection: 'unanswered' },
    range: { minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  } as const;

  it('reads a device not observed yet as unobserved', () => {
    expect(toBatteryControlRead(undefined)).toEqual({ kind: 'unobserved' });
  });

  it('reads a device without the home-battery cluster as no battery, not as an observe-only one', () => {
    expect(toBatteryControlRead(battery({ homeBattery: undefined, deviceClass: 'heater' })))
      .toEqual({ kind: 'not_battery' });
  });

  it('reads a battery without a setpoint surface as observe-only', () => {
    expect(toBatteryControlRead(battery({}))).toEqual({ kind: 'observe_only' });
  });

  it('reads a setpoint battery with its claim, or as unreported before it reports one', () => {
    const claim = { value: 'anti_feed', observedAtMs: 1_000 };
    expect(toBatteryControlRead(battery({ homeBattery: { controlSurface: surface }, batteryClaim: claim })))
      .toEqual({ kind: 'setpoint', surface, claim });
    expect(toBatteryControlRead(battery({ homeBattery: { controlSurface: surface } })))
      .toEqual({ kind: 'setpoint', surface, claim: { kind: 'unreported' } });
  });
});
