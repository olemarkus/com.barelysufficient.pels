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
  resolveCommandableNow,
} from '../../lib/device/deviceActionProjection';
import { isEvSessionInactive } from '../../packages/shared-domain/src/commandableNow';

describe('resolveCommandableNow — EV plug state', () => {
  it('returns commandableNow=false when the charger is plugged_out', () => {
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
      },
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger is unplugged');
  });

  it('returns commandableNow=true when the charger is plugged_in_charging', () => {
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
      },
    });
    expect(result.commandableNow).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('returns commandableNow=true when the charger is plugged_in_paused', () => {
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
      },
    });
    expect(result.commandableNow).toBe(true);
  });

  it('returns commandableNow=false when discharging', () => {
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_discharging',
      },
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger is discharging');
  });
});

describe('resolveCommandableNow — availability', () => {
  it('returns commandableNow=false when available is explicitly false', () => {
    const result = resolveCommandableNow({ dev: { available: false } });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('device unavailable');
  });

  it('returns commandableNow=true for a generic non-EV available device', () => {
    const result = resolveCommandableNow({ dev: { deviceClass: 'thermostat', available: true } });
    expect(result.commandableNow).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe('resolveCommandableNow — no trusted plug state (cold start)', () => {
  it('is pessimistic when an EV charger has no evChargingState yet', () => {
    // The only `undefined` plug-state case is a genuine cold start — transport's
    // consolidated truth preserves a real value across transient pulls, so this
    // does not fire on a hiccup. Pessimistic: never actuate without trusted
    // evidence the device is responsive.
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: undefined,
      },
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger state unknown');
  });
});

describe('isCommandableNow — dual-read fallback', () => {
  it('prefers the producer-resolved bit when defined', () => {
    expect(isCommandableNow({ commandableNow: false })).toBe(false);
    expect(isCommandableNow({ commandableNow: true })).toBe(true);
  });

  it('falls back to local resolution when commandableNow is undefined', () => {
    // `available: false` would resolve to commandableNow=false even with no
    // pre-populated bit.
    expect(isCommandableNow({ available: false })).toBe(false);
    expect(isCommandableNow({ available: true })).toBe(true);
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
    expect(isEvSessionInactive(undefined)).toBe(false);
  });

  it('does NOT gate on EV-ness — the caller scopes that (isEvPhysicallyUnplugged composes both)', () => {
    // A non-EV device that somehow carried one of these strings would read as
    // inactive-session by the bare predicate; isEvPhysicallyUnplugged adds the
    // isEvDevice guard so a non-EV device is never an "EV physical block".
    expect(isEvSessionInactive('plugged_out')).toBe(true);
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
