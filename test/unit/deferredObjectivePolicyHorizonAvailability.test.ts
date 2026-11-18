import { describe, expect, it } from 'vitest';
import {
  buildDeferredObjectivePolicyHorizon,
  countDeferredObjectivePolicyHorizonBuckets,
  resolveDeadlineAwarePolicyHorizonReason,
  resolveDeferredObjectivePolicyHorizonReason,
  type DeferredObjectivePolicyHorizonInputs,
  type PriceHorizonEntry,
} from '../../lib/objectives/deferredObjectives/policyHorizon';
import { buildDeadlineAwarePolicyHorizon } from '../../lib/objectives/deferredObjectives/frozenDiagnostic';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.UTC(2026, 0, 14, 17);
const HOUR = 3_600_000;
const period = (start: number, end: number): PriceHorizonEntry => ({
  startMs: NOW + start * HOUR, endMs: NOW + end * HOUR, price: 1, moneyPrice: 1,
});
const inputs = (): DeferredObjectivePolicyHorizonInputs => ({
  nowMs: NOW, deadlineAtMs: NOW + 2 * HOUR, priceOptimizationEnabled: true,
  priceHorizon: [period(0, 1), period(1, 2)], dailyBudgetSnapshot: null,
  exemptFromBudget: false, powerLimits: capacityOnlyPowerLimits(10), hasSolarProduction: false,
  higherPriorityReservations: [], higherPriorityUnbookedPowerKw: 0,
});

describe('policy horizon availability without allocation buckets', () => {
  it.each([
    { name: 'available', enabled: true, prices: [period(0, 1), period(1, 2)], reason: null },
    { name: 'disabled ahead of missing prices', enabled: false, prices: [], reason: 'objective_price_feature_disabled' },
    { name: 'disabled with prices', enabled: false, prices: [period(0, 2)], reason: 'objective_price_feature_disabled' },
    { name: 'empty', enabled: true, prices: [], reason: 'objective_missing_price_horizon' },
    { name: 'gap at now', enabled: true, prices: [period(0.25, 2)], reason: 'objective_missing_price_horizon' },
    { name: 'internal gap', enabled: true, prices: [period(0, 0.5), period(1, 2)], reason: 'objective_missing_price_horizon' },
    { name: 'short of deadline', enabled: true, prices: [period(0, 1.75)], reason: 'objective_missing_price_horizon' },
    { name: 'overlap', enabled: true, prices: [period(-1, 1.5), period(1, 3)], reason: null },
    { name: 'only elapsed or future', enabled: true, prices: [period(-1, 0), period(2, 3)], reason: 'objective_missing_price_horizon' },
    { name: 'zero duration', enabled: true, prices: [period(0, 1), period(1.5, 1.5), period(1, 2)], reason: null },
    { name: 'source order', enabled: true, prices: [period(1, 2), period(0, 1)], reason: 'objective_missing_price_horizon' },
    { name: 'reversed bounds retain boundary ordering', enabled: true, prices: [period(0, 1), period(1.5, 0.5), period(1.5, 2)], reason: null },
  ])('$name', ({ enabled, prices, reason }) => {
    const source = { ...inputs(), priceOptimizationEnabled: enabled, priceHorizon: prices };
    expect(resolveDeferredObjectivePolicyHorizonReason(source)).toBe(reason);
    expect(buildDeferredObjectivePolicyHorizon(source).reasonCode).toBe(reason);
    expect(resolveDeadlineAwarePolicyHorizonReason(source)).toBe(reason);
  });

  it.each([true, false])('preserves expired-deadline precedence with prices enabled=%s', (enabled) => {
    const source = { ...inputs(), deadlineAtMs: NOW, priceOptimizationEnabled: enabled };
    expect(resolveDeadlineAwarePolicyHorizonReason(source)).toBeNull();
    expect(buildDeadlineAwarePolicyHorizon(source)).toEqual({ buckets: [], horizonBucketCount: 0, reasonCode: null });
    expect(countDeferredObjectivePolicyHorizonBuckets(source)).toBe(0);
  });

  it('counts only source pieces, including budget boundaries outside the clipped window', () => {
    const budget = partialDouble<DailyBudgetUiPayload>({
      todayKey: '2026-01-14', tomorrowKey: null,
      days: { '2026-01-14': partialDouble<DailyBudgetDayPayload>({
        budget: { enabled: true, dailyBudgetKWh: 10, priceShapingEnabled: true },
        buckets: partialDouble<DailyBudgetDayPayload['buckets']>({
          startUtc: [new Date(NOW).toISOString(), new Date(NOW + HOUR).toISOString()],
          plannedControlledKWh: [4, 4], plannedUncontrolledKWh: [1, 1],
        }),
      }) },
    });
    const source: DeferredObjectivePolicyHorizonInputs = {
      ...inputs(), nowMs: NOW + HOUR / 4, deadlineAtMs: NOW + 1.75 * HOUR,
      priceHorizon: [period(-0.5, 1.5), period(1.5, 2.5)], dailyBudgetSnapshot: budget,
      higherPriorityReservations: [{
        deviceId: 'higher', topologyKey: 'first', startsAtMs: NOW, admissionPowerKw: 1,
        plannedKWh: 0.5, exemptFromBudget: false,
        energySegments: [{ startMs: NOW + HOUR / 2, endMs: NOW + HOUR, plannedKWh: 0.5 }],
      }],
    };
    const built = buildDeferredObjectivePolicyHorizon(source);
    expect(built.reasonCode).toBeNull();
    expect(built.horizonBucketCount).toBe(5);
    expect(built.buckets.length).toBeGreaterThan(built.horizonBucketCount);
    expect(countDeferredObjectivePolicyHorizonBuckets(source)).toBe(built.horizonBucketCount);
    expect(countDeferredObjectivePolicyHorizonBuckets({ ...source, priceHorizon: [] })).toBe(0);
    expect(countDeferredObjectivePolicyHorizonBuckets({ ...source, priceOptimizationEnabled: false })).toBe(0);
  });
});
