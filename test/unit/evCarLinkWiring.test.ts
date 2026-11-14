import { describe, expect, it } from 'vitest';
import { buildEvCarLinkChargerViews, type ChargerViewInput } from '../../lib/device/evCarLinkWiring';

const NOW = Date.parse('2026-11-13T07:00:00Z');

const charger = (overrides: Partial<ChargerViewInput>): ChargerViewInput => ({
  id: 'charger-1',
  name: 'Charger',
  isEvCharger: true,
  available: true,
  evChargingState: 'plugged_in_charging',
  measuredPowerKw: 11,
  measuredPowerObservedAtMs: NOW,
  ...overrides,
} as unknown as ChargerViewInput);

const views = (snapshot: ChargerViewInput) => buildEvCarLinkChargerViews([snapshot], () => []);

describe('buildEvCarLinkChargerViews power evidence', () => {
  it('carries the measured draw of an available charger', () => {
    expect(views(charger({}))[0]).toMatchObject({ measuredPowerW: 11000, measuredPowerObservedAtMs: NOW });
  });

  it('omits the draw of an unavailable charger instead of reading it as idle', () => {
    // An adapter that does not accept the session (a vehicle not opted in to
    // control) projects the device unavailable with 0 kW. That zero is a
    // projection, not a measurement: read as idle, a car charging at home on it
    // was logged as charging elsewhere twice a minute.
    const [view] = views(charger({ available: false, measuredPowerKw: 0 }));
    expect(view).toBeDefined();
    expect(view.measuredPowerW).toBeUndefined();
    expect(view.measuredPowerObservedAtMs).toBeUndefined();
  });
});
