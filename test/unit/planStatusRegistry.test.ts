import { describe, expect, it, vi } from 'vitest';
import { createPlanStatusRegistry, planStatusRegistryOf } from '../../lib/plan/planStatusRegistry';
import type { PelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';

const status = (headroomKw: number): PelsStatus => ({
  headroomKw,
  hourlyUsageKwh: 0.4,
  priceLevel: PriceLevel.NORMAL,
  devicesOn: 1,
  devicesOff: 0,
  lastPowerUpdate: 1_700_000_000_000,
  dryRunEffective: false,
});

describe('createPlanStatusRegistry', () => {
  it('holds one status per home: absent before the first publish, the latest after, absent again once retired', () => {
    const registry = createPlanStatusRegistry();
    expect(registry.read('main')).toEqual({ state: 'absent' });
    registry.publish('main', status(1));
    registry.publish('h_area', status(2));
    registry.publish('main', status(3));
    expect(registry.read('main')).toEqual({ state: 'resolved', status: status(3) });
    expect(registry.read('h_area')).toEqual({ state: 'resolved', status: status(2) });
    registry.retire('h_area');
    expect(registry.read('h_area')).toEqual({ state: 'absent' });
    expect(registry.read('main')).toEqual({ state: 'resolved', status: status(3) });
  });

  it('tells every subscriber about every publish until it unsubscribes, and a throwing subscriber costs the others nothing', () => {
    const registry = createPlanStatusRegistry();
    const heard: Array<[string, number]> = [];
    const unsubscribe = registry.subscribe((homeId, published) => { heard.push([homeId, published.headroomKw!]); });
    registry.subscribe(() => { throw new Error('listener down'); });
    const late = vi.fn();
    registry.subscribe(late);

    registry.publish('main', status(1));
    unsubscribe();
    registry.publish('h_area', status(2));

    expect(heard).toEqual([['main', 1]]);
    expect(late).toHaveBeenCalledTimes(2);
    // The publish still landed despite the throwing listener.
    expect(registry.read('h_area')).toEqual({ state: 'resolved', status: status(2) });
  });
});

describe('planStatusRegistryOf', () => {
  it('narrows the untyped app shell to its registry, and anything else to null', () => {
    const registry = createPlanStatusRegistry();
    expect(planStatusRegistryOf({ planStatuses: registry })).toBe(registry);
    for (const shell of [undefined, null, 42, {}, { planStatuses: null }, { planStatuses: { read: 1 } }]) {
      expect(planStatusRegistryOf(shell)).toBeNull();
    }
  });
});
