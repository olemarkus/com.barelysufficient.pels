import { describe, expect, it } from 'vitest';
import {
  isEvPlugStateBlocked,
  isEvPlugStateCommandable,
  isEvSessionInactive,
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
});
