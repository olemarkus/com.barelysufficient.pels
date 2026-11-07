import { describe, expect, it } from 'vitest';
import { isFairnessLimited } from '../../lib/plan/keepInvariantPosture';

// Priority 1 ranks highest. The prod 2026-11-02 house: thermostats at 2 and 3,
// the charger at 4, a heater at 6.
const devicesById = new Map([
  { id: 'thermostat-bath', priority: 2 },
  { id: 'thermostat-office', priority: 3 },
  { id: 'charger', priority: 4 },
  { id: 'heater', priority: 6 },
].map((device) => [device.id, device]));
const charger = { id: 'charger', priority: 4 };

describe('isFairnessLimited', () => {
  it('limits a device that is not boosted while any other device is limited', () => {
    expect(isFairnessLimited(new Set(['heater']), charger, false, devicesById)).toBe(true);
    expect(isFairnessLimited(new Set(['charger']), charger, false, devicesById)).toBe(false);
    expect(isFairnessLimited(new Set(), charger, false, devicesById)).toBe(false);
  });

  it('limits a boosted device only while a device ranked above it is limited', () => {
    expect(isFairnessLimited(new Set(['thermostat-bath', 'heater']), charger, true, devicesById)).toBe(true);
    expect(isFairnessLimited(new Set(['heater']), charger, true, devicesById)).toBe(false);
    expect(isFairnessLimited(new Set(['charger', 'heater']), charger, true, devicesById)).toBe(false);
  });
});
