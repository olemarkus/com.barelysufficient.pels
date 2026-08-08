import { beforeEach, describe, expect, it } from 'vitest';
import type { AssociatedCarSnapshot } from '../../packages/contracts/src/types';
import {
  applyAssociatedCarStateOfCharge,
  resolveAssociatedCar,
  type CarAssociationSources,
} from '../../lib/device/transport/carAssociation';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

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

/**
 * The car's own plug state is the guard on an adopted level: the level belongs
 * to the car's session, so a car that has left has no level to lend this
 * charger. Nothing here ages a reading — a level only moves while the car is
 * attached.
 */
describe('applyAssociatedCarStateOfCharge', () => {
  const charger = (): TransportDeviceSnapshot => ({
    id: 'charger-1',
    name: 'Elbillader',
    deviceClass: 'evcharger',
    evChargingState: 'plugged_in_charging',
    evCharging: true,
    targets: [],
  } as unknown as TransportDeviceSnapshot);

  const writeCtx = (snapshot: TransportDeviceSnapshot) => ({
    ...ctx(),
    latestSnapshotById: new Map([['charger-1', snapshot]]),
  });

  const reading = { chargerId: 'charger-1', carId: 'car-1', socPct: 63, socAtMs: 1_500 };

  it('writes the level while the car reports a connected state', () => {
    const snapshot = charger();
    expect(applyAssociatedCarStateOfCharge(writeCtx(snapshot), reading, 1_600)).toBe(true);
    expect(snapshot.stateOfCharge).toMatchObject({ percent: 63, source: 'car' });
  });

  it('keeps writing while the car is discharging — it is still attached', () => {
    matched = { ...ASSOCIATED, chargingState: 'plugged_in_discharging' };
    const snapshot = charger();
    expect(applyAssociatedCarStateOfCharge(writeCtx(snapshot), reading, 1_600)).toBe(true);
    expect(snapshot.stateOfCharge).toMatchObject({ percent: 63 });
  });

  it('writes nothing when the probe reports no association', () => {
    // Which is what a departed car looks like from here: the guard on the car's
    // own plug state lives in `resolveAssociatedCarSnapshot`, so an association
    // simply does not resolve for a car that has left.
    matched = undefined;
    const snapshot = charger();
    expect(applyAssociatedCarStateOfCharge(writeCtx(snapshot), reading, 1_600)).toBe(false);
    expect(snapshot.stateOfCharge).toBeUndefined();
  });
});
