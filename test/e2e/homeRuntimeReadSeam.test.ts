// SDK-boundary e2e coverage for the `AppContext` per-home read seam
// (`lib/home/homeRuntimeRead.ts`, published by
// `AppServiceWiring.initHomeRuntimeRegistry` through
// `buildHomeRuntimeReadPort`). The registry itself is a private wiring field,
// so this pins the only thing a consumer ever sees: the port appears on the
// real booted app, resolves a configured sub-home's already-committed state,
// reports the main home as unavailable (its reads stay on the unsuffixed ctx
// path), and goes away at uninit. The sub-home is configured purely through the
// SDK seams by the shared harness — nothing internal is stubbed, and (e2e tier)
// nothing internal is asserted against either: every claim below reads the
// served payload, which is why the harness's `assertMembership` sanity check
// (it reaches into `app.homeMembership`) stays an integration-lane option.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockZones } from '../mocks/homey';
import { cleanupApps } from '../utils/appTestUtils';
import { initAppWithSubHome, SUB_HOME, SUB_HOME_ZONES, settleAsyncSeams } from '../utils/smartTaskSubHomeHarness';
import { MAIN_HOME_ID, POWER_SOURCE } from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';

describe('AppContext per-home runtime read seam', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    setMockZones({ ...SUB_HOME_ZONES });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    setMockZones(null);
    vi.clearAllTimers();
  });

  it('publishes the port at boot, serves the sub-home, and clears it at uninit', async () => {
    const app = await initAppWithSubHome();
    const ctx = app as AppContext;

    const port = ctx.homeRuntimeRead;
    if (!port) throw new Error('expected AppServiceWiring to publish homeRuntimeRead');

    const read = port.readHome(SUB_HOME.homeId);
    if (read.state !== 'resolved') throw new Error(`expected ${SUB_HOME.homeId} to resolve`);
    expect(read.reading.homeId).toBe(SUB_HOME.homeId);
    expect(read.reading.diagnostics.homeId).toBe(SUB_HOME.homeId);
    expect(read.reading.diagnostics.meterDeviceId).toBe(SUB_HOME.meterDeviceId);
    // A meterless sub-home has no sample yet — reported as absence, never a
    // fabricated zero.
    expect(read.reading.diagnostics.lastMeterPowerKw).toBeNull();

    // The main home is not a bundle: it keeps the existing unsuffixed reads.
    expect(port.readHome(MAIN_HOME_ID)).toEqual({ state: 'unavailable' });
    expect(port.readHome('h_ghost')).toEqual({ state: 'unavailable' });

    await app.onUninit();
    await settleAsyncSeams();
    expect(ctx.homeRuntimeRead).toBeUndefined();
    // The captured port instance is lazy over the wiring field, so a consumer
    // holding it across teardown cannot resurrect a stale reading.
    expect(port.readHome(SUB_HOME.homeId)).toEqual({ state: 'unavailable' });
  });
});
