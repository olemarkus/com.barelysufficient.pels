import { describe, expect, it } from 'vitest';
import {
  isEvBoostBlockedByPlugState,
  isEvChargerNotResumableForDevice,
  isEvSessionInactiveForDevice,
  resolveEvBlockReasonForDevice,
  resolveEvCommandability,
} from '../../packages/shared-domain/src/commandableNow';
import { EV_COMMANDABLE_NOW_REASONS } from '../../packages/shared-domain/src/commandableNowReason';

const EV = { controlCapabilityId: 'evcharger_charging' as const };

describe('resolveEvCommandability — producer materialization', () => {
  it('returns undefined for a non-EV device', () => {
    expect(resolveEvCommandability({ controlCapabilityId: 'onoff' })).toBeUndefined();
    expect(resolveEvCommandability({ deviceClass: 'thermostat' })).toBeUndefined();
  });

  it('classifies each blocking plug-state for an EV device', () => {
    expect(resolveEvCommandability({ ...EV, evChargingState: 'plugged_out' })).toEqual({
      blockReason: EV_COMMANDABLE_NOW_REASONS.plugged_out,
      sessionInactive: true,
      chargerNotResumable: false,
    });
    expect(resolveEvCommandability({ ...EV, evChargingState: 'plugged_in_discharging' })).toEqual({
      blockReason: EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging,
      sessionInactive: true,
      chargerNotResumable: false,
    });
    expect(resolveEvCommandability({ ...EV, evChargingState: 'plugged_in' })).toEqual({
      blockReason: EV_COMMANDABLE_NOW_REASONS.plugged_in,
      sessionInactive: false,
      chargerNotResumable: true,
    });
  });

  it('treats the commandable states as not-blocked', () => {
    for (const evChargingState of ['plugged_in_charging', 'plugged_in_paused']) {
      expect(resolveEvCommandability({ ...EV, evChargingState })).toEqual({
        blockReason: null,
        sessionInactive: false,
        chargerNotResumable: false,
      });
    }
  });

  it('resolves an unread plug-state (undefined) to state_unknown without flagging inactive', () => {
    expect(resolveEvCommandability(EV)).toEqual({
      blockReason: EV_COMMANDABLE_NOW_REASONS.state_unknown,
      sessionInactive: false,
      chargerNotResumable: false,
    });
  });
});

describe('device-shaped EV resolvers — dual-read prefers the materialized bit', () => {
  it('reads evCommandability when present, ignoring any raw evChargingState', () => {
    // Materialized says inactive; raw (stale) says charging. The producer-resolved
    // value must win so consumers never re-derive from the raw plug-state.
    const dev = {
      evChargingState: 'plugged_in_charging',
      evCommandability: {
        blockReason: EV_COMMANDABLE_NOW_REASONS.plugged_out,
        sessionInactive: true,
        chargerNotResumable: false,
      },
    };
    expect(isEvSessionInactiveForDevice(dev)).toBe(true);
    expect(isEvChargerNotResumableForDevice(dev)).toBe(false);
    expect(resolveEvBlockReasonForDevice({ ...EV, ...dev })).toBe(EV_COMMANDABLE_NOW_REASONS.plugged_out);
    expect(isEvBoostBlockedByPlugState(dev)).toBe(true);
  });

  it('falls back to the raw evChargingState for snapshot-shaped callers (no evCommandability)', () => {
    expect(isEvSessionInactiveForDevice({ evChargingState: 'plugged_out' })).toBe(true);
    expect(isEvChargerNotResumableForDevice({ evChargingState: 'plugged_in' })).toBe(true);
    expect(resolveEvBlockReasonForDevice({ ...EV, evChargingState: 'plugged_in' }))
      .toBe(EV_COMMANDABLE_NOW_REASONS.plugged_in);
    expect(isEvBoostBlockedByPlugState({ evChargingState: 'plugged_in_discharging' })).toBe(true);
    expect(isEvBoostBlockedByPlugState({ evChargingState: 'plugged_in_charging' })).toBe(false);
  });
});
