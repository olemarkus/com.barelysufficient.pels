import { describe, expect, it } from 'vitest';
import { isFairnessLimited } from '../../lib/plan/keepInvariantPosture';

// Priority 1 ranks highest. The prod 2026-11-02 house: thermostats at 2 and 3,
// the charger at 4, a heater at 6.
const priorityById = new Map([
  ['thermostat-bath', 2],
  ['thermostat-office', 3],
  ['charger', 4],
  ['heater', 6],
]);
const charger = { id: 'charger', priority: 4 };

describe('isFairnessLimited', () => {
  it('limits a device that is not boosted while any other device is limited', () => {
    expect(isFairnessLimited(new Set(['heater']), charger, false, priorityById)).toBe(true);
    expect(isFairnessLimited(new Set(['charger']), charger, false, priorityById)).toBe(false);
    expect(isFairnessLimited(new Set(), charger, false, priorityById)).toBe(false);
  });

  it('limits a boosted device only while a device ranked above it is limited', () => {
    expect(isFairnessLimited(new Set(['thermostat-bath', 'heater']), charger, true, priorityById)).toBe(true);
    expect(isFairnessLimited(new Set(['heater']), charger, true, priorityById)).toBe(false);
    expect(isFairnessLimited(new Set(['charger', 'heater']), charger, true, priorityById)).toBe(false);
  });
});
