import { describe, expect, it } from 'vitest';
import {
  isEvBoostBlockedByPlugState,
  isEvChargerNotResumableForDevice,
  isEvSessionInactiveForDevice,
  resolveCommandableNow,
  resolveEvBlockReasonForDevice,
} from '../../packages/shared-domain/src/commandableNow';
import { EV_COMMANDABLE_NOW_REASONS } from '../../packages/shared-domain/src/commandableNowReason';
import type { CommandableNowResolveInput } from '../../packages/shared-domain/src/commandableNow';

const EV = { controlCapabilityId: 'evcharger_charging' as const };

const evSub = (dev: CommandableNowResolveInput) => {
  const { evBlockReason, evSessionInactive, evChargerNotResumable } = resolveCommandableNow({ dev });
  return { evBlockReason, evSessionInactive, evChargerNotResumable };
};

describe('resolveCommandableNow — EV plug-state sub-classification', () => {
  it('leaves the EV sub-fields commandable for a non-EV device', () => {
    expect(evSub({ controlCapabilityId: 'onoff' })).toEqual({
      evBlockReason: null,
      evSessionInactive: false,
      evChargerNotResumable: false,
    });
    expect(evSub({ deviceClass: 'thermostat' })).toEqual({
      evBlockReason: null,
      evSessionInactive: false,
      evChargerNotResumable: false,
    });
  });

  it('classifies each blocking plug-state for an EV device', () => {
    expect(evSub({ ...EV, evChargingState: 'plugged_out' })).toEqual({
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_out,
      evSessionInactive: true,
      evChargerNotResumable: false,
    });
    expect(evSub({ ...EV, evChargingState: 'plugged_in_discharging' })).toEqual({
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging,
      evSessionInactive: true,
      evChargerNotResumable: false,
    });
    expect(evSub({ ...EV, evChargingState: 'plugged_in' })).toEqual({
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_in,
      evSessionInactive: false,
      evChargerNotResumable: true,
    });
  });

  it('treats the commandable states as not-blocked', () => {
    for (const evChargingState of ['plugged_in_charging', 'plugged_in_paused'] as const) {
      expect(evSub({ ...EV, evChargingState })).toEqual({
        evBlockReason: null,
        evSessionInactive: false,
        evChargerNotResumable: false,
      });
    }
  });

  it('resolves an unread plug-state (undefined) to state_unknown without flagging inactive', () => {
    expect(evSub(EV)).toEqual({
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.state_unknown,
      evSessionInactive: false,
      evChargerNotResumable: false,
    });
  });

  it('keeps the EV block reason distinct from the general unavailable reason', () => {
    // An unavailable EV that is otherwise commandable: `reason` reports the
    // general block, but the EV sub-field stays EV-specific (null).
    const resolution = resolveCommandableNow({
      dev: { ...EV, evChargingState: 'plugged_in_charging', available: false },
    });
    expect(resolution.commandableNow).toBe(false);
    expect(resolution.reason).toBe('device unavailable');
    expect(resolution.evBlockReason).toBeNull();
  });
});

describe('device-shaped EV resolvers — single materialized input (raw arm retired)', () => {
  it('reads the producer-resolved flat fields', () => {
    const dev = {
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_out,
      evSessionInactive: true,
      evChargerNotResumable: false,
    };
    expect(isEvSessionInactiveForDevice(dev)).toBe(true);
    expect(isEvChargerNotResumableForDevice(dev)).toBe(false);
    expect(resolveEvBlockReasonForDevice(dev)).toBe(EV_COMMANDABLE_NOW_REASONS.plugged_out);
    expect(isEvBoostBlockedByPlugState(dev)).toBe(true);
  });

  it('classifies a connected-but-not-resumable device off the flat bit', () => {
    const dev = {
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_in,
      evSessionInactive: false,
      evChargerNotResumable: true,
    };
    expect(isEvSessionInactiveForDevice(dev)).toBe(false);
    expect(isEvChargerNotResumableForDevice(dev)).toBe(true);
    expect(resolveEvBlockReasonForDevice(dev)).toBe(EV_COMMANDABLE_NOW_REASONS.plugged_in);
    expect(isEvBoostBlockedByPlugState(dev)).toBe(true);
  });

  it('defaults to not-blocked when the flat bits are absent (non-EV device)', () => {
    // The raw `evChargingState` consumer arm is retired: a device with no
    // materialized flat bits — every non-EV device, and the footgun case of a
    // hand-constructed input that previously could smuggle in a raw plug-state —
    // now resolves to not-blocked. The producer is the only reader of the raw
    // plug-state, so this is the only safe single-input contract.
    expect(isEvSessionInactiveForDevice({})).toBe(false);
    expect(isEvChargerNotResumableForDevice({})).toBe(false);
    expect(resolveEvBlockReasonForDevice({})).toBeNull();
    expect(isEvBoostBlockedByPlugState({})).toBe(false);
  });

  it('cannot be bypassed by a hand-constructed non-EV input carrying a stale plug-state', () => {
    // Previously the device-shaped resolvers dual-read the raw `evChargingState`,
    // so a non-EV input that smuggled in `evChargingState: 'plugged_out'` would
    // be classified as session-inactive (the resolvers themselves do not gate on
    // `isEvDevice`). With the raw arm gone, an unknown extra property is inert —
    // only the producer-materialized flat bits are honoured.
    const handConstructed = { evChargingState: 'plugged_out' } as unknown as { evSessionInactive?: boolean };
    expect(isEvSessionInactiveForDevice(handConstructed)).toBe(false);
    expect(isEvChargerNotResumableForDevice(handConstructed)).toBe(false);
    expect(isEvBoostBlockedByPlugState(handConstructed)).toBe(false);
  });
});
