// Unit tests for the power-source epoch fence
// (`lib/power/powerSourceEpochFence.ts`), the pure generation/latch
// machine `HomeRuntimeRegistry` uses to decide whether per-meter samples may be
// consumed. The boundary read is injected, so there is no SDK here — the fence
// itself is a state machine over `PowerSource | null`.
//
// Invariants under test: a failed read is UNKNOWN (fail-closed placeholder,
// latch open), an observed change advances the generation and closes
// authorization, and only a committed transition against the latest observed
// generation reopens it.
import { describe, expect, it } from 'vitest';
import { PowerSourceEpochFence } from '../../lib/power/powerSourceEpochFence';
import type { PowerSource } from '../../lib/power/powerSource';

// Serves `reads` in order, then latches on the last one. The FIRST entry is
// consumed by the constructor's boot read, so `fenceReading(a, b)` means
// "booted on a, every later read sees b".
const fenceReading = (...reads: Array<PowerSource | null>) => {
  const queue = [...reads];
  let last: PowerSource | null = reads[0] ?? null;
  return new PowerSourceEpochFence(() => {
    const next = queue.shift();
    if (next !== undefined) last = next;
    return last;
  });
};

/** A `homey_energy` boot read already leaves the epoch open (nothing to commit). */
const openFence = (): PowerSourceEpochFence => fenceReading('homey_energy');

describe('PowerSourceEpochFence construction', () => {
  it('adopts a successful boot read as both observed and handled, with no latch', () => {
    const fence = fenceReading('homey_energy');
    expect(fence.handledPowerSource).toBe('homey_energy');
    expect(fence.isTransitionPending()).toBe(false);
    expect(fence.observedGeneration).toBe(0);
  });

  it('treats a failed boot read as unknown: flow placeholder plus an open latch', () => {
    const fence = fenceReading(null);
    expect(fence.handledPowerSource).toBe('flow');
    expect(fence.isTransitionPending()).toBe(true);
    expect(fence.isEpochDiscarded()).toBe(true);
  });
});

describe('PowerSourceEpochFence authorization', () => {
  it('treats a successful homey_energy boot read as an already-open epoch', () => {
    const fence = fenceReading('homey_energy');
    expect(fence.isEpochDiscarded()).toBe(false);
    expect(fence.isMeterSourceAuthorized()).toBe(true);
  });

  // The hot path (`routeMeterReadings` runs this on every 10 s poll fan-out)
  // must fail CLOSED for the failed poll without fencing the epoch: latching
  // here would turn one transient Homey settings-read miss into a sub-home
  // sampling outage that only the bounded recovery retry could reopen.
  it('denies authorization on a failed read without latching the fence', () => {
    const fence = fenceReading('homey_energy', null, 'homey_energy');
    expect(fence.isMeterSourceAuthorized()).toBe(false);
    expect(fence.isTransitionPending()).toBe(false);
    expect(fence.isMeterSourceAuthorized()).toBe(true);
  });

  it('refuses authorization while the configured source is not homey_energy', () => {
    const fence = fenceReading('flow');
    expect(fence.isEpochDiscarded()).toBe(true);
    expect(fence.isMeterSourceAuthorized()).toBe(false);
  });

  // The ABA fence: the synchronous edge advances the generation even when the
  // boundary still reports the same source, so a same-turn A→B→A round trip
  // closes authorization immediately, before any handling.
  it('closes authorization synchronously on an observed change, before any handling', () => {
    const fence = openFence();
    expect(fence.isMeterSourceAuthorized()).toBe(true);

    fence.observeChange();

    expect(fence.observedGeneration).toBe(1);
    expect(fence.isTransitionPending()).toBe(true);
    expect(fence.isMeterSourceAuthorized()).toBe(false);
  });

  it('adopts the source the observed change read, so committing it stays discarded', () => {
    const fence = fenceReading('homey_energy', 'flow');

    fence.observeChange();
    fence.commitTransition('flow', fence.observedGeneration);

    // Generation and latch are settled, so only the adopted `flow` source can
    // still be keeping the epoch discarded.
    expect(fence.isTransitionPending()).toBe(false);
    expect(fence.isEpochDiscarded()).toBe(true);
  });

  it('reopens authorization only after committing the latest observed generation', () => {
    const fence = openFence();
    fence.observeChange();
    const generation = fence.observedGeneration;

    // Committing a stale generation must not reopen the fence.
    fence.commitTransition('homey_energy', generation - 1);
    expect(fence.isMeterSourceAuthorized()).toBe(false);

    fence.commitTransition('homey_energy', generation);
    expect(fence.isMeterSourceAuthorized()).toBe(true);
  });

  it('stays closed after markIncomplete, even on an already-handled generation', () => {
    const fence = openFence();
    fence.markIncomplete();
    expect(fence.isEpochDiscarded()).toBe(true);
    expect(fence.isHandledCurrent(fence.observedGeneration)).toBe(false);
  });
});

describe('PowerSourceEpochFence reconcileObservedFromSettings', () => {
  it('reports unchanged when the boundary still matches the observed source', () => {
    const fence = openFence();
    expect(fence.reconcileObservedFromSettings()).toBe('unchanged');
    expect(fence.observedGeneration).toBe(0);
    expect(fence.isTransitionPending()).toBe(false);
  });

  it('observes a fresh generation when the boundary reports a different source', () => {
    const fence = fenceReading('homey_energy', 'flow');
    expect(fence.reconcileObservedFromSettings()).toBe('observed');
    expect(fence.observedGeneration).toBe(1);
    expect(fence.isTransitionPending()).toBe(true);
  });

  it('latches the fence closed when the boundary read fails', () => {
    const fence = fenceReading('homey_energy', null);
    expect(fence.reconcileObservedFromSettings()).toBe('unreadable');
    expect(fence.isTransitionPending()).toBe(true);
  });
});

describe('PowerSourceEpochFence transition resolution', () => {
  it('returns null and latches when the authoritative read fails', () => {
    const fence = fenceReading('homey_energy', null);
    expect(fence.resolveAuthoritativeSource()).toBeNull();
    expect(fence.isTransitionPending()).toBe(true);
  });

  it('adopts a source change seen at resolve time as a new observed generation', () => {
    const fence = fenceReading('homey_energy', 'flow');
    expect(fence.resolveAuthoritativeSource()).toBe('flow');
    expect(fence.observedGeneration).toBe(1);
    expect(fence.isTransitionPending()).toBe(true);
  });

  it('rejects a pre-commit check whose source moved since the transition was prepared', () => {
    const fence = fenceReading('homey_energy', 'flow');
    expect(fence.isTransitionCurrent('homey_energy', 0)).toBe(false);
  });

  // Isolates the SOURCE clause: `resolveAuthoritativeSource` has already bumped
  // the generation to 1 by the time the comparison runs, so asserting against
  // generation 0 above would still pass with the source check deleted.
  it('rejects a moved source even at the post-observe generation', () => {
    const fence = fenceReading('homey_energy', 'flow');
    expect(fence.isTransitionCurrent('homey_energy', 1)).toBe(false);
  });

  it('accepts a pre-commit check when neither source nor generation moved', () => {
    const fence = openFence();
    expect(fence.isTransitionCurrent('homey_energy', 0)).toBe(true);
  });
});
