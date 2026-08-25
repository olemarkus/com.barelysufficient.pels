import { describe, expect, it } from 'vitest';
import {
  asPowerStatusBlobRead,
  classifyPowerStatusRead,
} from '../../setup/settingsUiAppRuntime';

// The ONE classifier every pels_status producer answers through — both
// ui_power composers (latch evidence) and the realtime push (recorded-sample
// evidence). Pinned here so a second resolver can never quietly diverge on
// the liveness question again.
describe('classifyPowerStatusRead', () => {
  const blob = { headroomKw: 2, priceLevel: 'cheap' } as const;

  it('answers no_measurement on none evidence, blob or not', () => {
    expect(classifyPowerStatusRead({ state: 'none' }, { state: 'resolved', status: blob }))
      .toEqual({ state: 'unavailable', reason: 'no_measurement' });
    expect(classifyPowerStatusRead({ state: 'none' }, { state: 'absent' }))
      .toEqual({ state: 'unavailable', reason: 'no_measurement' });
  });

  it('serves the blob as live on latched evidence, and absence as no_status_recorded', () => {
    expect(classifyPowerStatusRead({ state: 'latched' }, { state: 'resolved', status: blob }))
      .toEqual({ state: 'live', status: blob });
    expect(classifyPowerStatusRead({ state: 'latched' }, { state: 'absent' }))
      .toEqual({ state: 'unavailable', reason: 'no_status_recorded' });
  });

  it('overlays the recorded sample stamp on the push arm, minimal status on an absent blob', () => {
    // A sample just landed: the stamp is this run's own fact, so it overlays
    // the blob's lastPowerUpdate…
    expect(classifyPowerStatusRead(
      { state: 'sample_recorded', sampleAtMs: 4242 },
      { state: 'resolved', status: { ...blob, lastPowerUpdate: 1 } },
    )).toEqual({ state: 'live', status: { ...blob, lastPowerUpdate: 4242 } });
    // …and an absent blob still yields a live minimal status carrying just the
    // stamp — the stale-data banner reads it during the
    // first-sample-before-first-plan window.
    expect(classifyPowerStatusRead({ state: 'sample_recorded', sampleAtMs: 4242 }, { state: 'absent' }))
      .toEqual({ state: 'live', status: { lastPowerUpdate: 4242 } });
  });

  it('object-guards the stored blob into resolved/absent', () => {
    expect(asPowerStatusBlobRead(blob)).toEqual({ state: 'resolved', status: blob });
    for (const junk of [null, undefined, 42, 'status', [1]]) {
      expect(asPowerStatusBlobRead(junk)).toEqual({ state: 'absent' });
    }
  });
});
