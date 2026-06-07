import { describe, expect, it } from 'vitest';
import {
  isEvBoostBlockedByPlugState,
  isEvChargerNotResumableForDevice,
  isEvSessionInactiveForDevice,
  resolveCommandableNow,
  resolveEvBlockReasonForDevice,
} from '../../packages/shared-domain/src/commandableNow';
import { EV_COMMANDABLE_NOW_REASONS } from '../../packages/shared-domain/src/commandableNowReason';

const EV = { controlCapabilityId: 'evcharger_charging' as const };

const evSub = (dev: { deviceClass?: string; controlCapabilityId?: string; evChargingState?: string }) => {
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
    for (const evChargingState of ['plugged_in_charging', 'plugged_in_paused']) {
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

describe('device-shaped EV resolvers — dual-read prefers the materialized flat bits', () => {
  it('reads the flat fields when present, ignoring any raw evChargingState', () => {
    // Materialized says inactive; raw (stale) says charging. The producer-resolved
    // value must win so consumers never re-derive from the raw plug-state.
    const dev = {
      evChargingState: 'plugged_in_charging',
      evBlockReason: EV_COMMANDABLE_NOW_REASONS.plugged_out,
      evSessionInactive: true,
      evChargerNotResumable: false,
    };
    expect(isEvSessionInactiveForDevice(dev)).toBe(true);
    expect(isEvChargerNotResumableForDevice(dev)).toBe(false);
    expect(resolveEvBlockReasonForDevice({ ...EV, ...dev })).toBe(EV_COMMANDABLE_NOW_REASONS.plugged_out);
    expect(isEvBoostBlockedByPlugState(dev)).toBe(true);
  });

  it('falls back to the raw evChargingState for snapshot-shaped callers (no flat bits)', () => {
    expect(isEvSessionInactiveForDevice({ evChargingState: 'plugged_out' })).toBe(true);
    expect(isEvChargerNotResumableForDevice({ evChargingState: 'plugged_in' })).toBe(true);
    expect(resolveEvBlockReasonForDevice({ ...EV, evChargingState: 'plugged_in' }))
      .toBe(EV_COMMANDABLE_NOW_REASONS.plugged_in);
    expect(isEvBoostBlockedByPlugState({ evChargingState: 'plugged_in_discharging' })).toBe(true);
    expect(isEvBoostBlockedByPlugState({ evChargingState: 'plugged_in_charging' })).toBe(false);
  });
});
