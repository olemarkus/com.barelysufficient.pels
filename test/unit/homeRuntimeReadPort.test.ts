// Unit coverage for `buildHomeRuntimeReadPort`
// (`setup/appInit/wireHomeRuntimeRegistry.ts`): the `AppContext` seam that
// exposes ONLY `readHome` over the private registry field. It is a pure lazy
// closure, so the behaviour worth pinning is narrow: an absent registry must
// collapse to the typed `unavailable` result (never a throw, never a fabricated
// reading), and the field must be re-read per call so the port both starts
// serving the moment wiring lands and goes inert when uninit clears it.
import { describe, expect, it } from 'vitest';
import type { HomeRuntimeReadPort, HomeRuntimeReading } from '../../lib/home/homeRuntimeRead';
import { buildHomeRuntimeReadPort } from '../../setup/appInit/wireHomeRuntimeRegistry';

const readingFor = (homeId: string): HomeRuntimeReading => ({
  homeId,
  plan: { generatedAtMs: 1_000, devices: [] },
  planUpdatedAtMs: 1_000,
  powerTracker: { lastPowerW: 2_400 },
  diagnostics: {
    homeId,
    meterDeviceId: 'm-a',
    dryRunEffective: false,
    lastMeterPowerKw: 2.4,
    capacityScalars: { limitKw: 7, marginKw: 0.2, dryRun: false },
    lastDeviceControlledMs: {},
  },
});

const stubRegistry = (): HomeRuntimeReadPort & { requested: string[] } => {
  const requested: string[] = [];
  return {
    requested,
    readHome: (homeId) => {
      requested.push(homeId);
      return homeId === 'h_a'
        ? { state: 'resolved', reading: readingFor(homeId) }
        : { state: 'unavailable' };
    },
  };
};

describe('buildHomeRuntimeReadPort', () => {
  it('reports unavailable while no registry is wired, without calling into one', () => {
    const port = buildHomeRuntimeReadPort(() => undefined);

    expect(port.readHome('h_a')).toEqual({ state: 'unavailable' });
  });

  it('forwards the homeId and returns the registry result verbatim once wired', () => {
    const registry = stubRegistry();
    let current: HomeRuntimeReadPort | undefined;
    const port = buildHomeRuntimeReadPort(() => current);

    // Pre-wiring: unavailable, and the registry is never consulted.
    expect(port.readHome('h_a')).toEqual({ state: 'unavailable' });
    expect(registry.requested).toEqual([]);

    current = registry;
    expect(port.readHome('h_a')).toEqual({
      state: 'resolved',
      reading: readingFor('h_a'),
    });
    expect(registry.requested).toEqual(['h_a']);

    // Uninit clears the field again; the same port instance goes inert.
    current = undefined;
    expect(port.readHome('h_a')).toEqual({ state: 'unavailable' });
    expect(registry.requested).toEqual(['h_a']);
  });
});
