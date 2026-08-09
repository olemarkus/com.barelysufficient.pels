import { describe, expect, it } from 'vitest';
import {
  isEvChargerNotResumable,
  isEvPlugStateBlocked,
  isEvPlugStateCommandable,
  isEvSessionInactive,
  resolveEvStartProbePosture,
} from '../../packages/shared-domain/src/evPlugState';
import type { EvChargingState } from '../../packages/contracts/src/types';

const ALL_STATES: EvChargingState[] = [
  'plugged_in_charging', 'plugged_in', 'plugged_in_paused', 'plugged_out', 'plugged_in_discharging',
];

describe('isEvPlugStateCommandable', () => {
  it('blocks only the two states where the electrics say no', () => {
    expect(isEvPlugStateCommandable('plugged_out')).toBe(false);
    expect(isEvPlugStateCommandable('plugged_in_discharging')).toBe(false);
  });

  it('commands every connected state, including the vendor-inconsistent bare `plugged_in`', () => {
    // Easee reports it while awaiting authorization, Wallbox for its own paused
    // state — a start command is exactly what those want. PELS probes and backs
    // off rather than reading the literal as a refusal.
    expect(isEvPlugStateCommandable('plugged_in')).toBe(true);
    expect(isEvPlugStateCommandable('plugged_in_paused')).toBe(true);
    expect(isEvPlugStateCommandable('plugged_in_charging')).toBe(true);
  });

  it('is total: every state has an answer, and the blocked predicate is its negation', () => {
    for (const state of ALL_STATES) {
      expect(isEvPlugStateBlocked(state)).toBe(!isEvPlugStateCommandable(state));
    }
  });
});

describe('session predicates', () => {
  it('marks the no-live-session states inactive', () => {
    expect(isEvSessionInactive('plugged_out')).toBe(true);
    expect(isEvSessionInactive('plugged_in_discharging')).toBe(true);
    expect(isEvSessionInactive('plugged_in')).toBe(false);
    expect(isEvSessionInactive('plugged_in_paused')).toBe(false);
    expect(isEvSessionInactive('plugged_in_charging')).toBe(false);
  });

  it('separates "may we command it" from "is charge flowing" on the bare connected state', () => {
    // PELS commands a `plugged_in` charger, but must not credit the SoC behind it
    // as objective progress until the state moves to `plugged_in_charging`.
    expect(isEvPlugStateCommandable('plugged_in')).toBe(true);
    expect(isEvChargerNotResumable('plugged_in')).toBe(true);
    for (const state of ALL_STATES.filter((s) => s !== 'plugged_in')) {
      expect(isEvChargerNotResumable(state)).toBe(false);
    }
  });
});

describe('resolveEvStartProbePosture', () => {
  it('arms the probe for the connected-but-idle states', () => {
    expect(resolveEvStartProbePosture('plugged_in'))
      .toEqual({ eligibleForStartProbe: true, activityObserved: false });
    expect(resolveEvStartProbePosture('plugged_in_paused'))
      .toEqual({ eligibleForStartProbe: true, activityObserved: false });
  });

  it('reports observed activity while charging, and nothing to probe when unplugged', () => {
    expect(resolveEvStartProbePosture('plugged_in_charging'))
      .toEqual({ eligibleForStartProbe: false, activityObserved: true });
    expect(resolveEvStartProbePosture('plugged_out'))
      .toEqual({ eligibleForStartProbe: false, activityObserved: false });
  });
});
