import { describe, expect, it } from 'vitest';
import type { CarObservation } from '../../lib/device/evCarLinkObservation';
import {
  type ActiveLinkView,
  resolveAssociatedCarSnapshot,
} from '../../lib/device/evCarLinkReadModel';

const car = (overrides: Partial<CarObservation> = {}): CarObservation => ({
  name: 'Polestar 3',
  state: 'plugged_in_charging',
  stateAtMs: 2_000,
  socPct: 42,
  socAtMs: 2_000,
  ...overrides,
});

const resolve = (params: {
  cars?: Array<[string, CarObservation]>;
  links?: Array<[string, ActiveLinkView]>;
  chargerId?: string;
}) => resolveAssociatedCarSnapshot({
  cars: new Map(params.cars ?? [['car-1', car()]]),
  links: new Map(params.links ?? [['charger-1', { carId: 'car-1', sinceMs: 1_000 }]]),
  chargerId: params.chargerId ?? 'charger-1',
});

describe('resolveAssociatedCarSnapshot', () => {
  it('resolves the associated car with its charging state and current charge', () => {
    expect(resolve({})).toEqual({
      carId: 'car-1',
      carName: 'Polestar 3',
      chargingState: 'plugged_in_charging',
      socPct: 42,
      socObservedAtMs: 2_000,
    });
  });

  it('serves a charge observed before this session began, with its timestamp', () => {
    // Cars publish `measure_battery` on change, so a session normally starts
    // with the last pre-plug reading and nothing new arrives until the level
    // rises. That reading is the car's real charge — a parked battery does not
    // move — and suppressing it would blank the level for cars reporting
    // correctly. Age is judged downstream, by the same rule that only decays a
    // charger's state-of-charge while charge is in motion.
    const resolved = resolve({ cars: [['car-1', car({ socAtMs: 999 })]] });
    expect(resolved?.socPct).toBe(42);
    expect(resolved?.socObservedAtMs).toBe(999);
  });

  it('reports the association even when the car has never reported a charge', () => {
    const resolved = resolve({ cars: [['car-1', car({ socPct: undefined })]] });
    expect(resolved?.carId).toBe('car-1');
    expect(resolved).not.toHaveProperty('socPct');
  });

  it('resolves nothing for a charger with no session', () => {
    expect(resolve({ chargerId: 'charger-2' })).toBeUndefined();
  });

  it('resolves nothing when the linked car is no longer observed', () => {
    expect(resolve({ cars: [] })).toBeUndefined();
  });
});
