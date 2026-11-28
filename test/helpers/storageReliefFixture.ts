import { decideStorageRelief, type StorageRelief } from '../../lib/plan/battery/storageRelief';
import { spendLimitHeadroom, type MeasuredPower } from '../../lib/plan/planContext';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { StorageSurplusOffer } from '../../lib/plan/planSurplusAbsorb';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

/** An isolated battery-stage cycle whose pinned headroom is all physical room. */
export function decideStorageReliefFixture(
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  levers: Readonly<Record<string, StorageLeverState>>,
  offers: ReadonlyMap<string, StorageSurplusOffer>,
  nowTs: number,
  simulatedUndeliveredW: number,
): StorageRelief {
  return decideStorageRelief(
    devices, power, levers, offers, nowTs, simulatedUndeliveredW,
    spendLimitHeadroom(power.headroom, -simulatedUndeliveredW / 1000),
  );
}
