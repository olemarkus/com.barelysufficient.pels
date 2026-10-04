import { describe, expect, it } from 'vitest';
import {
  isTaskDeviceStopped, NON_DELIVERY_HOLD_MS, observeTaskNonDelivery, type TaskDeliveryInput, type TaskNonDeliveryState,
} from '../../lib/objectives/deferredObjectives/taskDeliveryState';
import { suppressTaskDeliveryReservation } from '../../lib/objectives/deferredObjectives/deliveryEvidence';
import type { TaskDeliveryEvidence } from '../../packages/contracts/src/taskDelivery';

// A device that stopped taking power stays the status cause until it draws
// again, while every booked window still re-tests it before freeing its room.

const permittedIdle: TaskDeliveryInput = { obligation: 'claimed', control: 'permitted', draw: 'not_drawing' };
const confirmedAt = (sinceMs: number): TaskNonDeliveryState => ({ kind: 'confirmed', sinceMs });
const suppresses = (nonDelivery: TaskNonDeliveryState): boolean => suppressTaskDeliveryReservation({
  explanation: { kind: 'legacy_unrecorded' }, nonDelivery,
} satisfies TaskDeliveryEvidence);

describe('the non-delivery latch', () => {
  it('confirms after 15 minutes of a claimed, permitted window without draw', () => {
    const watching = observeTaskNonDelivery({ kind: 'none' }, permittedIdle, 0);
    expect(watching).toEqual({ kind: 'watching', sinceMs: 0 });
    expect(observeTaskNonDelivery(watching, permittedIdle, NON_DELIVERY_HOLD_MS)).toEqual(confirmedAt(0));
  });

  it.each([
    ['a capacity or budget hold', { obligation: 'claimed', control: 'restricted', draw: 'not_drawing' }],
    ['a settle', { obligation: 'claimed', control: 'pending', draw: 'not_drawing' }],
    ['an hour the plan does not book', { obligation: 'unclaimed', control: 'permitted', draw: 'not_drawing' }],
    ['a released hour', { obligation: 'deferred', control: 'permitted', draw: 'not_drawing' }],
    ['a missing power reading', { obligation: 'claimed', control: 'permitted', draw: 'unobserved' }],
  ] as const)('keeps a confirmed stop for the status through %s, but stops suppressing the reservation', (_label, input) => {
    const next = observeTaskNonDelivery(confirmedAt(0), input, NON_DELIVERY_HOLD_MS + 60_000);
    expect(next).toEqual({ kind: 'stopped', sinceMs: 0 });
    expect(isTaskDeviceStopped(next)).toBe(true);
    expect(suppresses(next)).toBe(false);
  });

  it('still resets an unconfirmed watch on those ticks, as before', () => {
    const input: TaskDeliveryInput = { obligation: 'claimed', control: 'restricted', draw: 'not_drawing' };
    expect(observeTaskNonDelivery({ kind: 'watching', sinceMs: 0 }, input, 60_000)).toEqual({ kind: 'none' });
  });

  it('re-tests a stopped device in its next permitted window before freeing the room again', () => {
    const startMs = 2 * NON_DELIVERY_HOLD_MS;
    const rechecking = observeTaskNonDelivery({ kind: 'stopped', sinceMs: 0 }, permittedIdle, startMs);
    expect(rechecking).toEqual({ kind: 'rechecking', sinceMs: startMs });
    expect(isTaskDeviceStopped(rechecking)).toBe(true);
    expect(suppresses(rechecking)).toBe(false);
    const still = observeTaskNonDelivery(rechecking, permittedIdle, startMs + NON_DELIVERY_HOLD_MS - 1);
    expect(still).toEqual({ kind: 'rechecking', sinceMs: startMs });
    const reconfirmed = observeTaskNonDelivery(still, permittedIdle, startMs + NON_DELIVERY_HOLD_MS);
    expect(reconfirmed).toEqual(confirmedAt(startMs));
    expect(suppresses(reconfirmed)).toBe(true);
  });

  it.each([
    ['the device draws power', { obligation: 'unclaimed', control: 'restricted', draw: 'drawing' }],
    ['the task is met', { obligation: 'satisfied', control: 'permitted', draw: 'not_drawing' }],
    ['the plan goes inactive, such as an unplugged car', { obligation: 'inactive', control: 'permitted', draw: 'not_drawing' }],
  ] as const)('ends the stop when %s', (_label, input) => {
    for (const previous of [confirmedAt(0), { kind: 'stopped', sinceMs: 0 }, { kind: 'rechecking', sinceMs: 0 }] as const) {
      expect(observeTaskNonDelivery(previous, input, NON_DELIVERY_HOLD_MS * 3)).toEqual({ kind: 'none' });
    }
  });

  it('freezes at the deadline', () => {
    const stopped: TaskNonDeliveryState = { kind: 'stopped', sinceMs: 0 };
    expect(observeTaskNonDelivery(stopped, { obligation: 'expired', control: 'permitted', draw: 'drawing' }, 1))
      .toBe(stopped);
  });
});
