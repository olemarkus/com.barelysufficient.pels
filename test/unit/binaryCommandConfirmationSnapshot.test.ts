import { describe, expect, it } from 'vitest';
import { buildBinaryCommandConfirmationSnapshot } from '../../lib/device/transport/binaryCommandConfirmationSnapshot';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const chargerSnapshot = (observedCapabilityIds: string[]): TransportDeviceSnapshot => ({
  id: 'charger-1',
  name: 'Elbillader',
  available: true,
  targets: [],
  expectedPowerKw: 1.38,
  expectedPowerSource: 'default',
  binaryCapabilityId: 'evcharger_charging',
  binaryObservationCapabilityId: 'evcharger_charging',
  binaryControl: { on: true },
  binaryControlObservation: {
    valid: true,
    capabilityId: 'evcharger_charging',
    observedValue: true,
    observedCapabilityIds,
    observedAtMs: 1_000,
    source: 'snapshot_refresh',
  },
});

describe('buildBinaryCommandConfirmationSnapshot', () => {
  it('does not settle an EV control command from charging-state evidence', () => {
    expect(buildBinaryCommandConfirmationSnapshot([
      chargerSnapshot(['evcharger_charging_state']),
    ])[0]?.binaryCommandConfirmation).toEqual({ state: 'unavailable' });
  });

  it('settles an EV control command from a read of evcharger_charging', () => {
    expect(buildBinaryCommandConfirmationSnapshot([
      chargerSnapshot(['evcharger_charging']),
    ])[0]?.binaryCommandConfirmation).toEqual({
      state: 'observed',
      observedValue: true,
      observedAtMs: 1_000,
    });
  });
});
