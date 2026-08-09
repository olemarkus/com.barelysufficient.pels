/**
 * Coverage for the producer resolvers in `lib/device/deviceActionProjection.ts`:
 *
 *  - `resolveCommandableNow` collapses EV plug-state + `available` into a
 *    single bit with an opaque diagnostic reason. Pure function of the
 *    consolidated observed truth — no abandon-grace window (transport's
 *    push+pull consolidation already maintains plug-state across a transient
 *    missing pull; see resolveCommandableNow docstring).
 *  - `resolveBoostActive` is a pure OR over the two domain booleans.
 */
import { describe, expect, it } from 'vitest';
import {
  isCanSetControl,
  isCommandableNow,
  isEvPhysicallyUnplugged,
  resolveBoostActive,
  resolveCanSetControl,
} from '../../lib/device/deviceActionProjection';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { isEvSessionInactive } from '../../packages/shared-domain/src/evPlugState';

describe('resolveCommandableNow — EV plug state', () => {
  it('returns commandableNow=false when the charger is plugged_out', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
    });
    expect(commandableNow).toBe(false);
  });

  it('returns commandableNow=true when the charger is plugged_in_charging', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
    });
    expect(commandableNow).toBe(true);
  });

  it('returns commandableNow=true when the charger is plugged_in_paused', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
    });
    expect(commandableNow).toBe(true);
  });

  it('returns commandableNow=false when discharging', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_discharging',
    });
    expect(commandableNow).toBe(false);
  });
});

describe('resolveCommandableNow — availability', () => {
  it('returns commandableNow=false when available is explicitly false', () => {
    expect(resolveCommandableNow({ available: false })).toBe(false);
  });

  it('returns commandableNow=true for a generic non-EV available device', () => {
    expect(resolveCommandableNow({ deviceClass: 'thermostat', available: true })).toBe(true);
  });
});

describe('resolveCommandableNow — no trusted plug state', () => {
  it('stays commandable when an EV charger has no evChargingState', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: undefined,
    });
    // Fails OPEN: an unclassifiable vendor value is permanent, shed does not
    // consult commandability, and blocking would leave the charger off with no
    // way back. PELS probes instead — see `resolveEvPlugBlock`.
    expect(commandableNow).toBe(true);
  });
});

describe('isCommandableNow — producer-resolved bit only', () => {
  it('reads the producer-resolved bit', () => {
    expect(isCommandableNow({ commandableNow: false })).toBe(false);
    expect(isCommandableNow({ commandableNow: true })).toBe(true);
  });

  it('ignores raw fields entirely — only the producer-resolved bit is read', () => {
    // The dual-read is deleted: raw fields sitting alongside the bit must not
    // change the answer. That fallback is what made every plan device read
    // "charger state unknown" — `withEvDiscriminant` strips `evChargingState`,
    // the fallback saw absence, and answered anyway. Callers holding a raw
    // snapshot now call `resolveCommandableNow` explicitly instead.
    const withRawFieldsThatUsedToWin = {
      commandableNow: true,
      available: false,
      evChargingState: 'plugged_out',
    } as unknown as Parameters<typeof isCommandableNow>[0];
    expect(isCommandableNow(withRawFieldsThatUsedToWin)).toBe(true);
  });

  it('honours the materialized commandableNow on an EV plan device and does NOT recompute from absent raw plug-state', () => {
    // Regression guard for the consumer dual-read retirement. A `DevicePlanDevice`
    // (produced by `toPlanDevice`) carries the materialized `commandableNow` and has
    // the raw `evChargingState` STRIPPED. `isCommandableNow` must short-circuit on
    // the materialized bit — recomputing via `resolveCommandableNow` from the absent
    // `evChargingState` would resolve a genuinely-commandable charging EV to
    // `state-unknown`/not-commandable, regressing EV resume on the executor's
    // `hasStableBinaryReleaseActuation` path.
    expect(isCommandableNow({ commandableNow: true })).toBe(true);
    expect(isCommandableNow({ commandableNow: false })).toBe(false);
  });
});

describe('resolveCanSetControl — producer', () => {
  it('returns false when no binary capability is resolvable', () => {
    // No controlCapabilityId, no relevant capabilities → no write surface.
    expect(resolveCanSetControl({})).toBe(false);
    expect(resolveCanSetControl({ capabilities: ['measure_power'] })).toBe(false);
  });

  it('returns true for an EV charger with canSetControl !== false', () => {
    expect(resolveCanSetControl({
      controlCapabilityId: 'evcharger_charging',
      canSetControl: true,
    })).toBe(true);
    // undefined canSetControl also passes — only an explicit false blocks.
    expect(resolveCanSetControl({
      controlCapabilityId: 'evcharger_charging',
    })).toBe(true);
  });

  it('returns false when canSetControl is explicitly false', () => {
    expect(resolveCanSetControl({
      controlCapabilityId: 'evcharger_charging',
      canSetControl: false,
    })).toBe(false);
  });

  it('returns true for an onoff device when the legacy canSetOnOff is true or undefined', () => {
    expect(resolveCanSetControl({
      controlCapabilityId: 'onoff',
      canSetOnOff: true,
    })).toBe(true);
    expect(resolveCanSetControl({
      controlCapabilityId: 'onoff',
    })).toBe(true);
  });

  it('returns false for an onoff device when the legacy canSetOnOff fallback is false', () => {
    expect(resolveCanSetControl({
      controlCapabilityId: 'onoff',
      canSetOnOff: false,
    })).toBe(false);
  });

  it('ignores canSetOnOff for the evcharger_charging capability', () => {
    // The legacy fallback only applies to onoff.
    expect(resolveCanSetControl({
      controlCapabilityId: 'evcharger_charging',
      canSetOnOff: false,
    })).toBe(true);
  });

  it('falls back to the capabilities array when controlCapabilityId is missing', () => {
    expect(resolveCanSetControl({
      capabilities: ['onoff'],
    })).toBe(true);
    expect(resolveCanSetControl({
      capabilities: ['evcharger_charging'],
    })).toBe(true);
  });
});

describe('isCanSetControl — dual-read fallback', () => {
  it('prefers the producer-resolved bit when defined', () => {
    expect(isCanSetControl({ canSetControlResolved: false })).toBe(false);
    expect(isCanSetControl({ canSetControlResolved: true })).toBe(true);
  });

  it('falls back to fresh resolution from raw fields when resolved bit is absent', () => {
    expect(isCanSetControl({
      controlCapabilityId: 'onoff',
      canSetOnOff: false,
    })).toBe(false);
    expect(isCanSetControl({
      controlCapabilityId: 'evcharger_charging',
      canSetControl: true,
    })).toBe(true);
  });
});

describe('resolveBoostActive — aggregate', () => {
  it('returns true if temperature-boost is active', () => {
    expect(resolveBoostActive({ temperatureBoostActive: true, evBoostActive: false })).toBe(true);
  });

  it('returns true if EV-boost is active', () => {
    expect(resolveBoostActive({ temperatureBoostActive: false, evBoostActive: true })).toBe(true);
  });

  it('returns true if both are active', () => {
    expect(resolveBoostActive({ temperatureBoostActive: true, evBoostActive: true })).toBe(true);
  });

  it('returns false if neither is active', () => {
    expect(resolveBoostActive({ temperatureBoostActive: false, evBoostActive: false })).toBe(false);
  });
});

describe('isEvSessionInactive — shared plug-state predicate', () => {
  it('is true only for the two no-live-session states', () => {
    expect(isEvSessionInactive('plugged_out')).toBe(true);
    expect(isEvSessionInactive('plugged_in_discharging')).toBe(true);
  });

  it('is false for chargeable/commandable states and unknown/undefined', () => {
    expect(isEvSessionInactive('plugged_in_charging')).toBe(false);
    expect(isEvSessionInactive('plugged_in_paused')).toBe(false);
    expect(isEvSessionInactive('plugged_in')).toBe(false);

  });

  it('composes the isEvDevice guard with the producer-resolved session bit', () => {
    // The bare plug-state predicate does NOT gate on EV-ness; isEvPhysicallyUnplugged
    // narrows through `isEvObserved` first, so a device carrying a stray plug-state
    // without an EV identity is never an "EV physical block".
    expect(isEvSessionInactive('plugged_out')).toBe(true);
    // Materialized session-inactive but NOT an EV device → not a physical block.
    expect(isEvPhysicallyUnplugged({ evChargingState: 'plugged_out' })).toBe(false);
    expect(isEvPhysicallyUnplugged({
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    })).toBe(true);
    expect(isEvPhysicallyUnplugged({
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
    })).toBe(false);
  });
});
