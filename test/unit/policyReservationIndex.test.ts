import { expect, it } from 'vitest';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonInputs,
  type DeferredObjectivePriorityReservation,
} from '../../lib/objectives/deferredObjectives/policyHorizon';
import type { DeferredObjectiveHorizonBucket } from '../../lib/objectives/deferredObjectives/types';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import { partialDouble } from '../helpers/partialDouble';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

const HOUR = 3_600_000;
const QUARTER = HOUR / 4;
const START = Date.UTC(2026, 0, 1);
const GROSS_BACKGROUND = [1.3, 2.7];
const prices = Array.from({ length: 8 }, (_, index) => ({
  startMs: START + index * QUARTER,
  endMs: START + (index + 1) * QUARTER,
  price: 0.1 + index * 0.2,
  moneyPrice: 0.7 + index * 0.1,
}));
const budget = partialDouble<DailyBudgetUiPayload>({
  todayKey: '2026-01-01', tomorrowKey: null,
  days: {
    '2026-01-01': partialDouble<DailyBudgetDayPayload>({
      budget: { enabled: true, dailyBudgetKWh: 20, priceShapingEnabled: true },
      buckets: partialDouble<DailyBudgetDayPayload['buckets']>({
        startUtc: [new Date(START).toISOString(), new Date(START + HOUR).toISOString()],
        plannedControlledKWh: [2.3, 3.1],
        plannedUncontrolledKWh: [0.7, 1.1],
        plannedGrossUncontrolledKWh: GROSS_BACKGROUND,
      }),
    }),
  },
});

type EnergySegment = DeferredObjectivePriorityReservation['energySegments'][number];
type Window = Pick<EnergySegment, 'startMs' | 'endMs'>;
const overlaps = (bucket: Window, segment: Window): boolean => (
  segment.startMs < bucket.endMs && segment.endMs > bucket.startMs
);

// The former full reservation scan is the oracle, including device insertion
// order and the original energy-segment objects in reservation order.
const oldReservationScan = (
  bucket: Window, reservations: readonly DeferredObjectivePriorityReservation[],
): { admissionPowerKw: number; energySegments: EnergySegment[] } => {
  const admissionByDevice = new Map<string, number>();
  const energySegments: EnergySegment[] = [];
  for (const reservation of reservations) {
    const matching = reservation.energySegments.filter((segment) => overlaps(bucket, segment));
    if (matching.length === 0) continue;
    admissionByDevice.set(reservation.deviceId, Math.max(
      admissionByDevice.get(reservation.deviceId) ?? 0, reservation.admissionPowerKw,
    ));
    if (!reservation.exemptFromBudget) energySegments.push(...matching);
  }
  return {
    admissionPowerKw: [...admissionByDevice.values()].reduce((sum, power) => sum + power, 0),
    energySegments,
  };
};

const oldSplitAndScan = (
  base: readonly DeferredObjectiveHorizonBucket[],
  inputs: DeferredObjectivePolicyHorizonInputs,
): DeferredObjectiveHorizonBucket[] => base.flatMap((bucket) => {
  const boundaries = new Set([bucket.startMs, bucket.endMs]);
  for (const reservation of inputs.higherPriorityReservations) {
    for (const segment of reservation.energySegments) {
      if (!overlaps(bucket, segment)) continue;
      if (segment.startMs > bucket.startMs && segment.startMs < bucket.endMs) boundaries.add(segment.startMs);
      if (segment.endMs > bucket.startMs && segment.endMs < bucket.endMs) boundaries.add(segment.endMs);
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  return ordered.slice(0, -1).map((startMs, index) => {
    const endMs = ordered[index + 1];
    const fraction = (endMs - startMs) / (bucket.endMs - bucket.startMs);
    const higher = oldReservationScan({ startMs, endMs }, inputs.higherPriorityReservations);
    const admissionPowerKw = inputs.higherPriorityUnbookedPowerKw + higher.admissionPowerKw;
    const hourIndex = Math.floor((bucket.startMs - START) / HOUR);
    const backgroundKWh = GROSS_BACKGROUND[hourIndex] * 0.25 * fraction;
    const durationHours = (endMs - startMs) / HOUR;
    return {
      id: ordered.length === 2 ? bucket.id : `${bucket.id}:${startMs}-${endMs}`,
      sourceBucketId: bucket.sourceBucketId,
      startMs,
      endMs,
      price: bucket.price,
      ...(bucket.maxUsefulEnergyKWh === undefined
        ? {} : { maxUsefulEnergyKWh: bucket.maxUsefulEnergyKWh * fraction }),
      reservedHeadroomKw: Math.max(0, 12 - Math.max(0, backgroundKWh / durationHours) - Math.max(0, admissionPowerKw)),
      ...(admissionPowerKw > 0 ? { higherPriorityAdmissionPowerKw: admissionPowerKw } : {}),
      ...(higher.energySegments.length > 0 ? { higherPriorityEnergyReservations: higher.energySegments } : {}),
    };
  });
});

const reservation = (
  deviceId: string, power: number, exempt: boolean, energySegments: EnergySegment[],
): DeferredObjectivePriorityReservation => ({
  deviceId, topologyKey: deviceId, startsAtMs: START,
  admissionPowerKw: power, plannedKWh: energySegments.reduce((sum, segment) => sum + segment.plannedKWh, 0),
  exemptFromBudget: exempt, energySegments,
});
const segment = (start: number, end: number, plannedKWh = 0.1): EnergySegment => ({
  startMs: START + start * QUARTER, endMs: START + end * QUARTER, plannedKWh,
});

const compareWithOldScan = (
  reservations: DeferredObjectivePriorityReservation[], exemptFromBudget: boolean, unbookedPower: number,
): void => {
  const inputs: DeferredObjectivePolicyHorizonInputs = {
    nowMs: START, deadlineAtMs: START + 2 * HOUR, priceOptimizationEnabled: true,
    priceHorizon: prices, dailyBudgetSnapshot: budget, exemptFromBudget,
    powerLimits: capacityOnlyPowerLimits(12), hasSolarProduction: false,
    higherPriorityReservations: reservations, higherPriorityUnbookedPowerKw: unbookedPower,
  };
  const base = buildDeferredObjectivePolicyHorizon({ ...inputs, higherPriorityReservations: [] });
  const indexed = buildDeferredObjectivePolicyHorizon(inputs);
  expect(indexed.reasonCode).toBeNull();
  expect(indexed.horizonBucketCount).toBe(base.horizonBucketCount);
  expect(indexed.buckets).toEqual(oldSplitAndScan(base.buckets, inputs));
};

it('preserves the full scan for duplicate, exempt, spanning and exact-edge claims', () => {
  const reservations = [
    reservation('repeated', 0.1, false, [segment(3.3, 6.7), segment(0.2, 1.7, 0.2)]),
    reservation('exempt', 0.2, true, [segment(-2, 10, 0.7)]),
    reservation('repeated', 0.7, false, [segment(1, 2), segment(4, 4), segment(6, 8)]),
    reservation('boundary', 1.1, false, [segment(-1, 0), segment(8, 9), segment(2, 3)]),
    reservation('empty', 4, false, []),
  ];
  for (const exempt of [false, true]) compareWithOldScan(reservations, exempt, 0.2);
  compareWithOldScan([], false, 0);
});

it('matches old split and scan results over seeded randomized reservation sets', () => {
  let seed = 0x51a7c0de;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let sample = 0; sample < 200; sample += 1) {
    const reservations = Array.from({ length: Math.floor(random() * 30) }, (_, index) => {
      const segments = Array.from({ length: Math.floor(random() * 6) }, () => {
        const start = (Math.floor(random() * 121) - 20) / 10;
        const end = start + Math.floor(random() * 61) / 10;
        return segment(start, end, [0.1, 0.2, 0.7][Math.floor(random() * 3)]);
      });
      return reservation(
        `device-${index % 7}`, [0, 0.1, 0.2, 0.7, 1.3, 4.7][Math.floor(random() * 6)],
        random() < 0.4, segments,
      );
    });
    compareWithOldScan(reservations, random() < 0.5, random() < 0.5 ? 0 : 0.7);
  }
});
