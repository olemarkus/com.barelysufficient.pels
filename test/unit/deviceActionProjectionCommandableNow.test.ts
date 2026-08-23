/**
 * Coverage for the producer resolvers in `lib/device/deviceActionProjection.ts`:
 *
 *  - `resolveCommandableNow` collapses EV plug-state + `available` into a
 *    single bit with an opaque diagnostic reason. Pure function of the
 *    consolidated observed truth — no abandon-grace window (transport's
 *    push+pull consolidation already maintains plug-state across a transient
 *    missing pull; see resolveCommandableNow docstring).
 *
 * The boost resolvers moved out of this suite when the two per-kind flags
 * collapsed into one decision — see `boostResolution.test.ts` (producer) and
 * `planBoost.test.ts` (planner).
 */
import { describe, expect, it } from 'vitest';
import {
  isCanSetControl,
  isCommandableNow,
  resolveCanSetControl,
} from '../../lib/device/deviceActionProjection';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { isEvSessionInactive } from '../../packages/shared-domain/src/evPlugState';

describe('resolveCommandableNow — EV plug state', () => {
  it('returns commandableNow=false when the charger is plugged_out', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        evChargingState: 'plugged_out',
        available: true,
    });
    expect(commandableNow).toBe(false);
  });

  it('returns commandableNow=true when the charger is plugged_in_charging', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        evChargingState: 'plugged_in_charging',
        available: true,
    });
    expect(commandableNow).toBe(true);
  });

  it('returns commandableNow=true when the charger is plugged_in_paused', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        evChargingState: 'plugged_in_paused',
        available: true,
    });
    expect(commandableNow).toBe(true);
  });

  it('returns commandableNow=false when discharging', () => {
    const commandableNow = resolveCommandableNow({
        deviceClass: 'evcharger',
        evChargingState: 'plugged_in_discharging',
        available: true,
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
        evChargingState: undefined,
        available: true,
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
    // "charger state unknown" — the since-deleted `withEvDiscriminant` stripped `evChargingState`,
    // the fallback saw absence, and answered anyway. Callers holding a raw
    // snapshot now call `resolveCommandableNow` explicitly instead.
    const withRawFieldsThatUsedToWin = {
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
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
    // No binaryCapabilityId, no relevant capabilities → no write surface.
    expect(resolveCanSetControl({})).toBe(false);
    expect(resolveCanSetControl({ capabilities: ['measure_power'] })).toBe(false);
  });

  it('returns true for an EV charger with canSetControl !== false', () => {
    expect(resolveCanSetControl({
      binaryControl: { on: false },
      canSetControl: true,
    })).toBe(true);
    // undefined canSetControl also passes — only an explicit false blocks.
    expect(resolveCanSetControl({
      binaryControl: { on: false },
    })).toBe(true);
  });

  it('returns false when canSetControl is explicitly false', () => {
    expect(resolveCanSetControl({
      binaryControl: { on: false },
      canSetControl: false,
    })).toBe(false);
  });

  it('returns true for an onoff device when the legacy canSetOnOff is true or undefined', () => {
    expect(resolveCanSetControl({
      binaryControl: { on: true },
      canSetOnOff: true,
    })).toBe(true);
    expect(resolveCanSetControl({
      binaryControl: { on: true },
    })).toBe(true);
  });

  it('returns false for an onoff device when the legacy canSetOnOff fallback is false', () => {
    expect(resolveCanSetControl({
      binaryControl: { on: true },
      canSetOnOff: false,
    })).toBe(false);
  });

  it('applies the same writeability flag to every binary device', () => {
    expect(resolveCanSetControl({
      binaryControl: { on: true },
      canSetOnOff: false,
    })).toBe(false);
  });

  it('does not reconstruct a binary axis from raw capabilities', () => {
    expect(resolveCanSetControl({
      capabilities: ['onoff'],
    })).toBe(false);
    expect(resolveCanSetControl({
      capabilities: ['evcharger_charging'],
    })).toBe(false);
  });
});

describe('isCanSetControl — dual-read fallback', () => {
  it('prefers the producer-resolved bit when defined', () => {
    expect(isCanSetControl({ canSetControlResolved: false })).toBe(false);
    expect(isCanSetControl({ canSetControlResolved: true })).toBe(true);
  });

  it('falls back to fresh resolution from raw fields when resolved bit is absent', () => {
    expect(isCanSetControl({
      binaryControl: { on: true },
      canSetOnOff: false,
    })).toBe(false);
    expect(isCanSetControl({
      binaryControl: { on: true },
      canSetControl: true,
    })).toBe(true);
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
});
