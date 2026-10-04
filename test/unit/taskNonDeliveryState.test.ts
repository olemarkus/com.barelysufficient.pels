import { describe, expect, it } from 'vitest';
import { NON_DELIVERY_HOLD_MS, observeTaskNonDelivery, type TaskDeliveryInput } from '../../lib/objectives/deferredObjectives/taskDeliveryState';

const permitted: TaskDeliveryInput = { obligation: 'claimed', control: 'permitted', draw: 'not_drawing' };

describe('operational non-delivery hold', () => {
  it('requires a continuous claimed, settled and permitted idle window', () => {
    const watching = observeTaskNonDelivery({ kind: 'none' }, permitted, 0);
    expect(observeTaskNonDelivery(watching, permitted, NON_DELIVERY_HOLD_MS - 1)).toEqual(watching);
    expect(observeTaskNonDelivery(watching, permitted, NON_DELIVERY_HOLD_MS))
      .toEqual({ kind: 'confirmed', sinceMs: 0 });
  });
  // A confirmed stop ends its window on these ticks: the room is held again
  // (no longer `confirmed`), while the stop itself is kept for the status.
  it.each(['restricted', 'pending', 'failed', 'uncontrolled'] as const)('ends the window during %s control', (control) => {
    expect(observeTaskNonDelivery({ kind: 'confirmed', sinceMs: 0 }, { ...permitted, control }, NON_DELIVERY_HOLD_MS))
      .toEqual({ kind: 'stopped', sinceMs: 0 });
  });
  it('ends the window when draw is unobserved', () => {
    expect(observeTaskNonDelivery({ kind: 'confirmed', sinceMs: 0 }, { ...permitted, draw: 'unobserved' }, NON_DELIVERY_HOLD_MS))
      .toEqual({ kind: 'stopped', sinceMs: 0 });
  });
  it('resets when the device draws', () => {
    expect(observeTaskNonDelivery({ kind: 'confirmed', sinceMs: 0 }, { ...permitted, draw: 'drawing' }, NON_DELIVERY_HOLD_MS))
      .toEqual({ kind: 'none' });
  });
  it('starts a fresh hold after a interrupted window and freezes its final state on expiry', () => {
    const reset = observeTaskNonDelivery({ kind: 'watching', sinceMs: 0 }, { ...permitted, control: 'pending' }, 100);
    const watching = observeTaskNonDelivery(reset, permitted, 200);
    expect(watching).toEqual({ kind: 'watching', sinceMs: 200 });
    expect(observeTaskNonDelivery(watching, { ...permitted, obligation: 'expired' }, NON_DELIVERY_HOLD_MS))
      .toEqual(watching);
  });
});
