import { describe, expect, it } from 'vitest';
import { decideStorageRelief, resumeContinuousStorage } from '../../lib/plan/battery/storageRelief';
import { applyStorageHandBacks, applyStorageLimits } from '../../lib/plan/battery/storageLimit';
import { buildStorageCandidate, resolveStorageSpend } from '../../lib/plan/shedding/storageCandidate';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';

const NOW = 1_000_000;
const battery = (overrides: Partial<ObservedStorageInput> = {}, id = 'battery'): PlanInputDevice & { storage: ObservedStorageInput } => ({
  ...buildPlanInputDevice({ id, name: id, isBatteryOrSolar: true, commandAuthority: false, currentDrawKw: 0 }),
  storage: {
    reading: 'observed', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false, signedPowerW: 0, claimHeld: true, admissible: true,
    verdict: 'responding', deliveryCeilingW: 2500, chargeCeilingW: 2500, powerLimitControl: true,
    continuousPlan: { setpointW: 0, validUntilMs: NOW + 60_000, reason: 'hold_energy' },
    ...overrides,
  },
});
const offers = (ids = ['battery']) => new Map(ids.map(id => [id, {
  availableW: 0, addedBackW: 0, belowW: 0, demandAbove: 'none' as const,
}]));

describe('continuous battery execution decisions', () => {
  it('retains the original own-mode power across limit hand-back and later idle release', () => {
    const native = battery();
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 3 });
    const original = decideStorageRelief([native], power, {}, offers(), NOW);
    const limited = applyStorageLimits(original,
      new Map([['battery', { setpointW: -1000, banked: true, storage: native.storage }]]), NOW);
    const supplying = battery({ signedPowerW: -1000,
      continuousPlan: { setpointW: -1000, validUntilMs: NOW + 60_000, reason: 'supply_house' },
    });
    const resumed = resumeContinuousStorage(applyStorageHandBacks(limited, new Set(['battery'])),
      limited, [supplying], power, offers(), NOW + 1000);
    expect(resumed.levers.battery.preClaimSignedW).toBe(0);
    expect(resumed.batteries[0].decision).toMatchObject({ kind: 'setpoint', restored: true });
    const released = decideStorageRelief([battery({ signedPowerW: -1000, continuousPlan: undefined })],
      power, resumed.levers, offers(), NOW + 2000);
    expect(released.batteries[0].decision).toEqual({ kind: 'release', reason: 'idle' });
    expect(released.shed.netCreditKw).toBe(-1);
  });

  it('opens a fresh discharge credit after a long zero hold without extending an unanswered window', () => {
    const plan = (setpointW: number) => ({ setpointW, validUntilMs: NOW + 600_000, reason: 'supply_house' as const });
    const idle = decideStorageRelief([battery({ continuousPlan: plan(0) })], buildMeasuredPower(), {}, offers(), NOW);
    const supplying = decideStorageRelief([battery({ continuousPlan: plan(-1000) })],
      buildMeasuredPower({ drawKw: 3 }), idle.levers, offers(), NOW + 60_000);
    expect(supplying.shed.netCreditKw).toBe(1);
    expect(supplying.levers.battery.increaseDecidedAtMs).toBe(NOW + 60_000);
    const deeper = decideStorageRelief([battery({ continuousPlan: plan(-1500) })],
      buildMeasuredPower({ drawKw: 3 }), supplying.levers, offers(), NOW + 70_000);
    expect(deeper.levers.battery.increaseDecidedAtMs).toBe(NOW + 60_000);
    const unanswered = decideStorageRelief([battery({ continuousPlan: plan(-2000) })],
      buildMeasuredPower({ drawKw: 3 }), deeper.levers, offers(), NOW + 91_000);
    expect(unanswered.shed.netCreditKw).toBe(0);
    const delivered = decideStorageRelief([battery({ signedPowerW: -1500, continuousPlan: plan(-2000) })],
      buildMeasuredPower({ drawKw: 3 }), deeper.levers, offers(), NOW + 91_000);
    expect(delivered.shed.netCreditKw).toBe(0.5);
  });

  it('retains a zero-watt hold between windows, including a full battery', () => {
    const result = decideStorageRelief([battery({ chargeCeilingW: 0 })], buildMeasuredPower(), {}, offers(), NOW);
    expect(result.batteries[0].decision).toEqual({ kind: 'setpoint', setpointW: 0, stepW: 5 });
    expect(result.levers.battery.purpose).toBe('continuous');
  });

  it('never invents capacity discharge when a charging window has no room', () => {
    const result = decideStorageRelief([battery({
      continuousPlan: { setpointW: 2000, validUntilMs: NOW + 60_000, reason: 'charge_grid' },
    })], buildMeasuredPower({ headroomKw: 0 }), {}, offers(), NOW);
    expect(result.batteries[0].setpointW).toBe(0);
    expect(result.levers.battery.purpose).toBe('continuous');
  });

  it('bounds economic discharge to actual house import and the configured reserve ceiling', () => {
    const input = battery({ continuousPlan: { setpointW: -2500, validUntilMs: NOW + 60_000, reason: 'supply_house' } });
    const power = buildMeasuredPower({ drawKw: 0.5 });
    expect(decideStorageRelief([input], power, {}, offers(), NOW).batteries[0].setpointW).toBe(-400);
    const reserved = battery({
      deliveryCeilingW: 0,
      continuousPlan: { setpointW: -2500, validUntilMs: NOW + 60_000, reason: 'supply_house' },
    });
    expect(decideStorageRelief([reserved], power, {}, offers(), NOW).batteries[0].setpointW).toBe(0);
  });

  it('withholds pending charge every cycle while the meter has not observed it', () => {
    const plan = { setpointW: 1500, validUntilMs: NOW + 60_000, reason: 'charge_grid' as const };
    const devices = [battery({ continuousPlan: plan }, 'a'), battery({ continuousPlan: plan }, 'b')];
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 2 });
    const first = decideStorageRelief(devices, power, {}, offers(['a', 'b']), NOW);
    expect(first.batteries.map(item => item.setpointW)).toEqual([1500, 400]);
    const next = decideStorageRelief(devices, power, first.levers, offers(['a', 'b']), NOW + 1000);
    expect(next.batteries.map(item => item.setpointW)).toEqual([1500, 400]);
  });

  it('prices capacity relief from the new routine target when stopping an observed discharge', () => {
    const input = battery({ signedPowerW: -2000 });
    const result = decideStorageRelief([input], buildMeasuredPower({ drawKw: 3, headroomKw: 1 }), {}, offers(), NOW);
    expect(result.shed.netCreditKw).toBe(-2);
    const candidate = buildStorageCandidate(input, result.levers.battery, 3, false, NOW);
    if (typeof candidate === 'string') throw new Error('Expected battery capacity candidate');
    expect(candidate.baseW).toBe(0);
    expect(resolveStorageSpend(candidate, 1)?.setpointW).toBe(-1100);
  });

  it('releases the routine hold when its plan ends or the owner disables control', () => {
    const previous: Record<string, StorageLeverState> = decideStorageRelief([battery()], buildMeasuredPower(), {}, offers(), NOW).levers;
    const expired = battery({ continuousPlan: { setpointW: 0, validUntilMs: NOW, reason: 'hold_energy' } });
    expect(decideStorageRelief([expired], buildMeasuredPower(), previous, offers(), NOW).batteries[0].decision)
      .toEqual({ kind: 'release', reason: 'idle' });
    expect(decideStorageRelief([battery({ powerLimitControl: false })], buildMeasuredPower(), previous, offers(), NOW).batteries[0].decision)
      .toEqual({ kind: 'release', reason: 'limit_off' });
  });
});
