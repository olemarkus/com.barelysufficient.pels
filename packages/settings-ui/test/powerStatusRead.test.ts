import { describe, expect, it } from 'vitest';
import {
  isPowerStatusRead,
  liveStatusOrNull,
  resolvePowerStatusRead,
} from '../src/ui/powerStatusRead.ts';

// The client-side seam for the classified power-status read. Its one job is
// to make sure nothing that is not a producer-classified union ever reaches a
// view as a live status — in particular the LEGACY raw blob shape
// ({ lastPowerUpdate, priceLevel, ... }), which is exactly what a stale WebView
// paired with an updated runtime (or vice versa) would deliver across the
// version skew, and what the pre-classification producer used to send.
describe('powerStatusRead seam', () => {
  const liveRead = { state: 'live', status: { lastPowerUpdate: 123, priceLevel: 'cheap' } } as const;

  it('accepts both producer arms', () => {
    expect(isPowerStatusRead(liveRead)).toBe(true);
    expect(isPowerStatusRead({ state: 'unavailable', reason: 'no_measurement' })).toBe(true);
    expect(isPowerStatusRead({ state: 'unavailable', reason: 'no_status_recorded' })).toBe(true);
    expect(isPowerStatusRead({ state: 'unavailable', reason: 'home_scope_unavailable' })).toBe(true);
    expect(isPowerStatusRead({ state: 'unavailable', reason: 'read_failed' })).toBe(true);
  });

  it('rejects the legacy raw blob shape — version skew must not read as live', () => {
    expect(isPowerStatusRead({ lastPowerUpdate: 123, priceLevel: 'cheap' })).toBe(false);
    expect(liveStatusOrNull({ lastPowerUpdate: 123, priceLevel: 'cheap' })).toBeNull();
    expect(resolvePowerStatusRead({ lastPowerUpdate: 123, priceLevel: 'cheap' }))
      .toEqual({ state: 'unavailable', reason: 'read_failed' });
  });

  it('classifies junk as the seam own read_failed, never a throw', () => {
    for (const junk of [null, undefined, 42, 'live', [], { state: 'live', status: null },
      { state: 'live' }, { state: 'unavailable' }, { state: 'unavailable', reason: 'weird' }]) {
      expect(resolvePowerStatusRead(junk)).toEqual({ state: 'unavailable', reason: 'read_failed' });
      expect(liveStatusOrNull(junk)).toBeNull();
    }
  });

  it('narrows only the live arm into the view vocabulary', () => {
    expect(liveStatusOrNull(liveRead)).toEqual({ lastPowerUpdate: 123, priceLevel: 'cheap' });
    expect(liveStatusOrNull({ state: 'unavailable', reason: 'no_measurement' })).toBeNull();
  });
});
