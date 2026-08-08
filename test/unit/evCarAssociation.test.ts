import { beforeEach, describe, expect, it } from 'vitest';
import type { AssociatedCarSnapshot } from '../../packages/contracts/src/types';
import {
  resolveAssociatedCar,
  type CarAssociationSources,
} from '../../lib/device/transport/carAssociation';

/**
 * The eligibility gate: the probe says which car matched a charger's plug edge,
 * the user says which cars that charger may associate, and only their agreement
 * produces an association.
 *
 * A pure function over two inputs, so unit tier. The parameter is the narrow
 * `Pick<TransportContext, ...>` the resolver actually reads, which is what lets
 * this build a real typed value instead of casting a whole `TransportContext`
 * — a cast would keep passing if the resolver later reached for a third field.
 */


const ASSOCIATED: AssociatedCarSnapshot = {
  carId: 'car-1',
  carName: 'Polestar 3',
  chargingState: 'plugged_in_charging',
  chargingStateObservedAtMs: 2_000,
  socPct: 42,
  socObservedAtMs: 2_000,
};

let eligibleCarIds: readonly string[];
let matched: AssociatedCarSnapshot | undefined;

const ctx = (): CarAssociationSources => ({
  providers: { getEvCarAssociationCarIds: () => eligibleCarIds },
  observationProducers: {
    evCarLink: { getAssociatedCarForCharger: () => matched },
  },
});

beforeEach(() => {
  eligibleCarIds = ['car-1'];
  matched = ASSOCIATED;
});

describe('resolveAssociatedCar', () => {
  it('associates a ticked car the probe matched', () => {
    expect(resolveAssociatedCar(ctx(), 'charger-1')).toEqual(ASSOCIATED);
  });

  it('associates nothing when the user has ticked no car for this charger', () => {
    // The default for every existing install: the probe may well have matched a
    // car, and it must stay invisible until the user opts the charger in.
    eligibleCarIds = [];
    expect(resolveAssociatedCar(ctx(), 'charger-1')).toBeUndefined();
  });

  it('associates nothing when the probe matched no car', () => {
    // Eligibility narrows the candidates; it never stands in for the evidence.
    // A ticked car plugged in at work reports the same connected state as one on
    // this charger, which is what `ev_car_session_elsewhere` reports.
    matched = undefined;
    expect(resolveAssociatedCar(ctx(), 'charger-1')).toBeUndefined();
  });

  it('associates nothing when the probe matched a car the user did not tick', () => {
    eligibleCarIds = ['car-2'];
    expect(resolveAssociatedCar(ctx(), 'charger-1')).toBeUndefined();
  });

  it('associates a matched car from a multi-car eligibility set', () => {
    eligibleCarIds = ['car-2', 'car-1'];
    expect(resolveAssociatedCar(ctx(), 'charger-1')).toEqual(ASSOCIATED);
  });
});
