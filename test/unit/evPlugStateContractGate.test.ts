import { describe, expect, it, vi } from 'vitest';
import { shouldDropForEvPlugStateContract } from '../../lib/device/transport/managerParse';

const gate = (over: {
  capabilities?: string[];
  stateReportedInPayload?: boolean;
  reportedStateValue?: unknown;
  evChargingState?: 'plugged_in' | undefined;
  retainedEvChargingState?: 'plugged_in' | undefined;
} = {}): boolean => shouldDropForEvPlugStateContract({
  deviceClassKey: 'evcharger',
  deviceId: 'ev1',
  deviceLabel: 'Charger',
  capabilities: over.capabilities ?? ['evcharger_charging', 'evcharger_charging_state'],
  stateReportedInPayload: over.stateReportedInPayload ?? true,
  reportedStateValue: over.reportedStateValue,
  evChargingState: over.evChargingState,
  retainedEvChargingState: over.retainedEvChargingState,
});

describe('shouldDropForEvPlugStateContract', () => {
  it('keeps a charger reporting a member of the Homey enum', () => {
    expect(gate({ reportedStateValue: 'plugged_in', evChargingState: 'plugged_in' })).toBe(false);
  });

  it('drops a charger reporting a value outside the enum', () => {
    expect(gate({ reportedStateValue: 'plugged_in_complete', evChargingState: undefined })).toBe(true);
  });

  it('drops an explicitly reported `null`, even with a valid retained state', () => {
    // `null` is not a member of the enum, so it is an invalid REPORT, not a
    // missing one. Falling back to the retained value here would keep the device
    // alive on a stale plug-state that no longer describes the charger — the
    // discriminant is whether the payload carries the capability entry, not
    // whether its value happens to be non-null.
    expect(gate({
      reportedStateValue: null,
      evChargingState: undefined,
      retainedEvChargingState: 'plugged_in',
    })).toBe(true);
  });

  it('keeps a charger whose payload omits the capability entry but has a retained state', () => {
    // The ordinary partial `device.update`: it carries only what changed. Dropping
    // here would evict a healthy charger on every partial update.
    expect(gate({
      stateReportedInPayload: false,
      reportedStateValue: undefined,
      evChargingState: undefined,
      retainedEvChargingState: 'plugged_in',
    })).toBe(false);
  });

  it('drops a charger whose payload omits the entry and has never reported one', () => {
    expect(gate({
      stateReportedInPayload: false,
      reportedStateValue: undefined,
      evChargingState: undefined,
      retainedEvChargingState: undefined,
    })).toBe(true);
  });

  it('is inert for a device that does not claim the capability', () => {
    // Non-EV devices flow through the same parse path; the gate must not touch
    // them, and an `evcharger` that fails to claim the capability is already
    // dropped upstream by `resolveCandidateCapabilities`.
    expect(gate({
      capabilities: ['onoff', 'measure_power'],
      stateReportedInPayload: false,
      evChargingState: undefined,
      retainedEvChargingState: undefined,
    })).toBe(false);
  });

  it('emits the skip diagnostic with the offending raw value', () => {
    const debugStructured = vi.fn();
    shouldDropForEvPlugStateContract({
      deviceClassKey: 'evcharger',
      deviceId: 'ev1',
      deviceLabel: 'Charger',
      capabilities: ['evcharger_charging', 'evcharger_charging_state'],
      stateReportedInPayload: true,
      reportedStateValue: 'plugged_in_complete',
      evChargingState: undefined,
      retainedEvChargingState: undefined,
      debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_skipped_invalid_capability_value',
      capabilityId: 'evcharger_charging_state',
      rawValue: 'plugged_in_complete',
    }));
  });
});
