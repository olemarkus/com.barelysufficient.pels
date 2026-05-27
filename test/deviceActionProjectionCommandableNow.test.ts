/**
 * Coverage for the chunk-2 producer additions in `lib/device/deviceActionProjection.ts`:
 *
 *  - `resolveCommandableNow` collapses EV plug-state + `available` into a
 *    single bit with an opaque diagnostic reason.
 *  - The abandon-grace window keeps the previously observed bit when the
 *    SDK returns an uncertain (no-`evChargingState`) read on an EV charger.
 *  - `resolveBoostActive` is a pure OR over the two domain booleans.
 *
 * Behaviour-preserving tests live alongside the chunk-1 resolver tests; the
 * specifics here are the new abandon-grace contract and the aggregate
 * accessor — both of which are net-new in chunk 2.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMANDABLE_NOW_GRACE_MS,
  isCanSetControl,
  isCommandableNow,
  resolveBoostActive,
  resolveCanSetControl,
  resolveCommandableNow,
  type CommandableNowGraceEntry,
} from '../lib/device/deviceActionProjection';

const NOW_MS = new Date('2026-05-26T12:00:00Z').getTime();

describe('resolveCommandableNow — EV plug state', () => {
  it('returns commandableNow=false when the charger is plugged_out', () => {
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
      },
      nowMs: NOW_MS,
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
      nowMs: NOW_MS,
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
      nowMs: NOW_MS,
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
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger is discharging');
  });
});

describe('resolveCommandableNow — availability', () => {
  it('returns commandableNow=false when available is explicitly false', () => {
    const result = resolveCommandableNow({
      dev: { available: false },
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('device unavailable');
  });

  it('returns commandableNow=true for a generic non-EV available device', () => {
    const result = resolveCommandableNow({
      dev: { deviceClass: 'thermostat', available: true },
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe('resolveCommandableNow — abandon-grace window', () => {
  // Pattern source: feedback_homey_sdk_unreliable + planHistory.ts
  // ABANDON_GRACE_MS. A single empty SDK read on an EV charger must not
  // flip commandableNow from true to false.
  it('inherits the previous commandableNow=true when the EV evChargingState is missing within grace', () => {
    const previousObservation: CommandableNowGraceEntry = {
      commandableNow: true,
      observedAtMs: NOW_MS - 60_000,
    };
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: undefined,
      },
      previousObservation,
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('does NOT inherit the previous observation outside the grace window', () => {
    const previousObservation: CommandableNowGraceEntry = {
      commandableNow: true,
      observedAtMs: NOW_MS - (COMMANDABLE_NOW_GRACE_MS + 1_000),
    };
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: undefined,
      },
      previousObservation,
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger state unknown');
  });

  it('does not extend grace on a confident unplugged read', () => {
    // Even if the previous observation said commandableNow=true, an explicit
    // plugged_out read this cycle is confident: no grace applies.
    const previousObservation: CommandableNowGraceEntry = {
      commandableNow: true,
      observedAtMs: NOW_MS - 60_000,
    };
    const result = resolveCommandableNow({
      dev: {
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
      },
      previousObservation,
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('charger is unplugged');
  });

  it('does NOT apply grace to a confident available=false read', () => {
    // Abandon-grace only covers uncertain SDK reads (missing
    // `evChargingState` on an EV charger). `available: false` is a
    // confident negative — the SDK explicitly reported the device is not
    // available — so it must bypass the grace window. Otherwise a device
    // that legitimately goes offline would stay "commandable" for up to
    // COMMANDABLE_NOW_GRACE_MS and the executor would attempt writes
    // that the SDK will reject.
    const previousObservation: CommandableNowGraceEntry = {
      commandableNow: true,
      observedAtMs: NOW_MS - 30_000,
    };
    const result = resolveCommandableNow({
      dev: { available: false },
      previousObservation,
      nowMs: NOW_MS,
    });
    expect(result.commandableNow).toBe(false);
    expect(result.reason).toBe('device unavailable');
  });
});

describe('isCommandableNow — dual-read fallback', () => {
  it('prefers the producer-resolved bit when defined', () => {
    expect(isCommandableNow({ commandableNow: false }, NOW_MS)).toBe(false);
    expect(isCommandableNow({ commandableNow: true }, NOW_MS)).toBe(true);
  });

  it('falls back to local resolution when commandableNow is undefined', () => {
    // `available: false` would resolve to commandableNow=false even with no
    // pre-populated bit.
    expect(isCommandableNow({ available: false }, NOW_MS)).toBe(false);
    expect(isCommandableNow({ available: true }, NOW_MS)).toBe(true);
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
