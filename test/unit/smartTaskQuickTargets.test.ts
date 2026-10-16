import { describe, expect, it } from 'vitest';
import {
  resolveSmartTaskDeviceDefaultGoal,
  resolveSmartTaskQuickTargets,
  type SmartTaskDeviceLike,
} from '../../packages/shared-domain/src/smartTaskDeviceKind';
import { estimateSmartTaskQuickTargets } from '../../lib/objectives/deferredObjectives/smartTaskQuickTargets';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../../packages/contracts/src/deferredObjectivePlanPreview';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';

const device = (fields: Partial<SmartTaskDeviceLike>): SmartTaskDeviceLike => ({
  isEvCharger: false, binaryControllable: false, targets: [], ...fields,
});

const thermostat = (currentTemperature: number, setpoint: number, min: number, max: number): SmartTaskDeviceLike => (
  device({ temperature: { currentTemperature, target: { value: setpoint, min, max, step: 0.5 } } })
);

describe('resolveSmartTaskQuickTargets', () => {
  // The cases are the production household's own devices (2026-10-16).
  it('steps a water heater by 5 °C from its setpoint up to its maximum', () => {
    expect(resolveSmartTaskQuickTargets(thermostat(61.6, 65, 20, 85), 'temperature')).toEqual([65, 70, 75, 80]);
    expect(resolveSmartTaskQuickTargets(thermostat(54, 65, 20, 75), 'temperature')).toEqual([65, 70, 75]);
  });

  it('steps a room by 1 °C from its setpoint', () => {
    expect(resolveSmartTaskQuickTargets(thermostat(20.2, 21, 4, 40), 'temperature')).toEqual([21, 22, 23, 24]);
  });

  it('starts above the current temperature when the setpoint is already reached', () => {
    // A frost-guard setpoint in a warm room, and a room already above its setpoint.
    expect(resolveSmartTaskQuickTargets(thermostat(17.1, 10, 4, 40), 'temperature')).toEqual([18, 19, 20, 21]);
    expect(resolveSmartTaskQuickTargets(thermostat(24.7, 21, 4, 40), 'temperature')).toEqual([25, 26, 27, 28]);
  });

  it('offers nothing at the device maximum', () => {
    expect(resolveSmartTaskQuickTargets(thermostat(30, 30, 10, 30), 'temperature')).toEqual([]);
  });

  it('offers the EV stops above the current level, filled to four', () => {
    const charger = (percent: number) => device({ isEvCharger: true, stateOfCharge: stateOfChargeFixture({ percent }) });
    expect(resolveSmartTaskQuickTargets(charger(30), 'ev_soc')).toEqual([50, 70, 80, 100]);
    expect(resolveSmartTaskQuickTargets(charger(58), 'ev_soc')).toEqual([70, 80, 90, 100]);
    expect(resolveSmartTaskQuickTargets(charger(85), 'ev_soc')).toEqual([90, 100]);
    expect(resolveSmartTaskQuickTargets(charger(100), 'ev_soc')).toEqual([]);
  });

  it('offers nothing for a charger without a known level, or for an energy task', () => {
    expect(resolveSmartTaskQuickTargets(device({ isEvCharger: true }), 'ev_soc')).toEqual([]);
    expect(resolveSmartTaskQuickTargets(device({ binaryControllable: true }), 'energy')).toEqual([]);
  });
});

describe('resolveSmartTaskDeviceDefaultGoal', () => {
  it('seeds a room from its first quick target, not the water-heater default', () => {
    expect(resolveSmartTaskDeviceDefaultGoal(thermostat(20.2, 21, 4, 40), 'temperature')).toBe(21);
  });
});

const NOW = Date.UTC(2026, 9, 16, 18, 10);
const SLOT = 30 * 60 * 1000;
const FIRST_SLOT = Date.UTC(2026, 9, 16, 18, 30);

const targetOf = (candidate: DeferredObjectivePlanPreviewCandidate): number => (
  candidate.kind === 'ev_soc' ? candidate.targetPercent : Number.NaN
);

// A planner stand-in: each target needs a fixed time from now, and the projected
// finish is when that time runs out.
const fakePreview = (hoursNeeded: Record<number, number>, pricedUntilMs = Number.POSITIVE_INFINITY) => {
  const calls: string[] = [];
  const preview = (candidate: DeferredObjectivePlanPreviewCandidate): DeferredObjectivePlanPreviewEstimate => {
    calls.push(`${targetOf(candidate)}@${candidate.deadlineAtMs}`);
    if (candidate.deadlineAtMs > pricedUntilMs) {
      return {
        status: 'unavailable', unavailableReason: 'missing_prices', budgetRole: 'none', scheduledHours: [],
        projectedFinishAtMs: null, energyEstimateKWh: null, energyExpectedKWh: null, costEstimate: null,
      };
    }
    const finish = NOW + hoursNeeded[targetOf(candidate)]! * 3_600_000;
    return {
      status: candidate.deadlineAtMs >= finish ? 'on_track' : 'cannot_meet',
      budgetRole: 'none', scheduledHours: [], projectedFinishAtMs: finish,
      energyEstimateKWh: 10, energyExpectedKWh: null, costEstimate: 12,
    };
  };
  return { preview, calls };
};

describe('estimateSmartTaskQuickTargets', () => {
  it('finds each earliest half hour and adds slack rounded up to the half hour', () => {
    const { preview } = fakePreview({ 70: 2, 80: 3 });
    const read = estimateSmartTaskQuickTargets('ev_soc', [70, 80], preview, NOW);
    expect(read.state).toBe('ready');
    if (read.state !== 'ready') return;
    // 70 %: finish 20:10 → earliest slot 20:30 (140 min out) → +42 min → 21:30.
    expect(read.targets.map((target) => target.deadlineAtMs)).toEqual([
      FIRST_SLOT + 6 * SLOT,
      FIRST_SLOT + 8 * SLOT,
    ]);
    expect(read.targets[0]!.estimate.status).toBe('on_track');
  });

  it('drops a target that cannot finish within a day, and every higher one', () => {
    const { preview } = fakePreview({ 70: 2, 80: 30, 90: 3 });
    const read = estimateSmartTaskQuickTargets('ev_soc', [70, 80, 90], preview, NOW);
    expect(read.state === 'ready' && read.targets.map((target) => target.target)).toEqual([70]);
  });

  it('reports why nothing can be timed', () => {
    const preview = (): DeferredObjectivePlanPreviewEstimate => ({
      status: 'unavailable', unavailableReason: 'invalid_session', budgetRole: 'none', scheduledHours: [],
      projectedFinishAtMs: null, energyEstimateKWh: null, energyExpectedKWh: null, costEstimate: null,
    });
    expect(estimateSmartTaskQuickTargets('ev_soc', [70], preview, NOW))
      .toEqual({ state: 'unavailable', reason: 'invalid_session' });
  });

  it('can finish by the very next half hour', () => {
    // 18:10 + 10 min → 18:30, then 6 min of slack rounds up to 19:00.
    const { preview } = fakePreview({ 50: 10 / 60 });
    const read = estimateSmartTaskQuickTargets('ev_soc', [50], preview, NOW);
    expect(read.state === 'ready' && read.targets[0]!.deadlineAtMs).toBe(FIRST_SLOT + SLOT);
  });

  it('searches only as far as the published prices, and keeps the slack inside them', () => {
    // Prices end at 23:30. A 4.5 h target (earliest 23:00) would pad to 00:30.
    const pricedUntil = FIRST_SLOT + 10 * SLOT;
    const { preview } = fakePreview({ 70: 2, 80: 4.5, 100: 8 }, pricedUntil);
    const read = estimateSmartTaskQuickTargets('ev_soc', [70, 80, 100], preview, NOW);
    expect(read.state).toBe('ready');
    if (read.state !== 'ready') return;
    expect(read.targets.map((target) => [target.target, target.deadlineAtMs])).toEqual([
      [70, FIRST_SLOT + 6 * SLOT],
      [80, pricedUntil],
    ]);
    for (const target of read.targets) expect(target.estimate.status).toBe('on_track');
  });

  it('reports missing prices when not even the next half hour is priced', () => {
    const { preview } = fakePreview({ 70: 2 }, NOW);
    expect(estimateSmartTaskQuickTargets('ev_soc', [70], preview, NOW))
      .toEqual({ state: 'unavailable', reason: 'missing_prices' });
  });

  it('never previews a target at the same deadline twice, and stays within 32 previews', () => {
    const { preview, calls } = fakePreview({ 50: 1, 70: 2, 80: 3, 100: 5 });
    estimateSmartTaskQuickTargets('ev_soc', [50, 70, 80, 100], preview, NOW);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls.length).toBeLessThanOrEqual(32);
  });
});
