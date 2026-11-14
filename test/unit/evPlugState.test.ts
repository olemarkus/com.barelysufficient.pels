import { describe, expect, it } from 'vitest';
import {
  isEvChargingState,
  isEvPlugStateBlocked,
  isEvPlugStateCommandable,
  isEvPlugStateConnected,
  isEvPlugStateIdle,
  isEvSessionInactive,
  resolveEvChargeAction,
} from '../../packages/shared-domain/src/evPlugState';
import type { EvChargingState } from '../../packages/contracts/src/types';

const ALL_STATES: EvChargingState[] = [
  'plugged_in_charging', 'plugged_in', 'plugged_in_awaiting_start', 'plugged_in_paused',
  'plugged_in_waiting_for_charger', 'plugged_in_finished', 'plugged_out', 'plugged_in_discharging',
];

describe('isEvPlugStateCommandable', () => {
  it('blocks the two states where the electrics say no', () => {
    expect(isEvPlugStateCommandable('plugged_out')).toBe(false);
    expect(isEvPlugStateCommandable('plugged_in_discharging')).toBe(false);
  });

  it('blocks a session the charger has not started', () => {
    // A start there is refused, and the session begins by itself.
    expect(isEvPlugStateCommandable('plugged_in_waiting_for_charger')).toBe(false);
  });

  it('keeps a finished session commandable, so PELS can hold current on offer', () => {
    expect(isEvPlugStateCommandable('plugged_in_finished')).toBe(true);
  });

  it('commands every state a start or resume reaches, including the vendor-inconsistent bare `plugged_in`', () => {
    // Easee reports it while awaiting authorization, Wallbox for its own paused
    // state — a start command is exactly what those want. PELS probes and backs
    // off rather than reading the literal as a refusal.
    expect(isEvPlugStateCommandable('plugged_in')).toBe(true);
    expect(isEvPlugStateCommandable('plugged_in_awaiting_start')).toBe(true);
    expect(isEvPlugStateCommandable('plugged_in_paused')).toBe(true);
    expect(isEvPlugStateCommandable('plugged_in_charging')).toBe(true);
  });

  it('is total: every state has an answer, and the blocked predicate is its negation', () => {
    for (const state of ALL_STATES) {
      expect(isEvPlugStateBlocked(state)).toBe(!isEvPlugStateCommandable(state));
    }
  });
});

describe('resolveEvChargeAction', () => {
  it('gives each session state the one answer to a wish to charge', () => {
    expect(Object.fromEntries(ALL_STATES.map((state) => [state, resolveEvChargeAction(state)]))).toEqual({
      plugged_out: 'blocked',
      plugged_in_discharging: 'blocked',
      plugged_in: 'start',
      plugged_in_awaiting_start: 'start',
      plugged_in_paused: 'resume',
      plugged_in_charging: 'keep',
      plugged_in_waiting_for_charger: 'wait',
      plugged_in_finished: 'offer',
    });
  });
});

describe('session predicates', () => {
  it('accepts every session state at the read boundary and nothing else', () => {
    for (const state of ALL_STATES) expect(isEvChargingState(state)).toBe(true);
    expect(isEvChargingState('plugged_in_done')).toBe(false);
  });

  it('keeps a finished or not-yet-started session creditable and connected', () => {
    for (const state of ['plugged_in_finished', 'plugged_in_waiting_for_charger', 'plugged_in_awaiting_start'] as const) {
      expect(isEvSessionInactive(state)).toBe(false);
      expect(isEvPlugStateConnected(state)).toBe(true);
    }
  });

  it('reads a connected car that takes nothing as idle, unless a pause holds it', () => {
    expect(ALL_STATES.filter(isEvPlugStateIdle)).toEqual([
      'plugged_in', 'plugged_in_awaiting_start', 'plugged_in_waiting_for_charger', 'plugged_in_finished',
    ]);
  });

  it('marks the no-live-session states inactive', () => {
    expect(isEvSessionInactive('plugged_out')).toBe(true);
    expect(isEvSessionInactive('plugged_in_discharging')).toBe(true);
    expect(isEvSessionInactive('plugged_in')).toBe(false);
    expect(isEvSessionInactive('plugged_in_paused')).toBe(false);
    expect(isEvSessionInactive('plugged_in_charging')).toBe(false);
  });
});
