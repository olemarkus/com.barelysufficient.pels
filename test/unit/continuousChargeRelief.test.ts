import { describe, expect, it } from 'vitest';
import { resolveContinuousChargeRelief } from '../../lib/plan/shedding/continuousChargeRelief';
import { decideStorageRelief } from '../../lib/plan/battery/storageRelief';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';

const NOW = 1_000_000;
const offers = new Map([['battery', { availableW: 0, addedBackW: 0, belowW: 0, demandAbove: 'none' as const }]]);
const battery = (targetW: number, observedW: number): PlanInputDevice & { storage: ObservedStorageInput } => ({
  ...buildPlanInputDevice({ id: 'battery', isBatteryOrSolar: true, currentDrawKw: 0 }),
  storage: {
    reading: 'observed', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false, signedPowerW: observedW, claimHeld: true, admissible: true,
    verdict: 'responding', deliveryCeilingW: 2500, chargeCeilingW: 2500, powerLimitControl: true,
    continuousPlan: { setpointW: targetW, validUntilMs: NOW + 600_000, reason: 'charge_grid' },
  },
});

function transition(previousW: number, targetW: number, observedW: number) {
  const state = createPlanEngineState(NOW);
  const power = buildMeasuredPower({ drawKw: 5, headroomKw: 4 });
  state.storageLeverByDevice = { ...decideStorageRelief([battery(previousW, previousW)], power, {}, offers, NOW - 60_000).levers };
  const devices: PlanInputDevice[] = [battery(targetW, observedW)];
  const storage = decideStorageRelief(devices, power, state.storageLeverByDevice, offers, NOW);
  return { state, devices, storage, power };
}

describe('continuous stopped-charge ledger', () => {
  it('banks a new reduction once without turning it into a capacity hold', () => {
    const { state, devices, storage, power } = transition(2000, 0, 2000);
    const result = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW, powerW: 5000 }, NOW);
    expect(result?.totalKw).toBe(2);
    expect(storage.levers.battery.purpose).toBe('continuous');
    state.storageLeverByDevice = { ...storage.levers };
    state.shedPlanLatch = result!.retained;
    const repeat = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW + 1000, powerW: 5000 }, NOW + 1000);
    expect(repeat?.totalKw).toBe(2);
    expect(repeat?.retained.decisions.get('battery')).toEqual([{ decidedAtMs: NOW, creditedKw: 2 }]);
  });

  it('folds an unanswered deeper reduction onto its live stamp and preserves another device', () => {
    const { state, devices, storage, power } = transition(1000, 0, 2000);
    state.shedPlanLatch = { powerW: 5000, stepTargets: new Map(), decisions: new Map([
      ['battery', [{ decidedAtMs: NOW - 10_000, creditedKw: 1 }]],
      ['heater', [{ decidedAtMs: NOW - 5000, creditedKw: 0.5 }]],
    ]) };
    devices.push(buildPlanInputDevice({ id: 'heater', binaryControl: { on: false }, currentDrawKw: 0 }));
    const result = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW, powerW: 5000 }, NOW);
    expect(result?.totalKw).toBe(2.5);
    expect(result?.retained.decisions.get('battery')).toEqual([{ decidedAtMs: NOW - 10_000, creditedKw: 2 }]);
    expect(result?.retained.decisions.get('heater')).toEqual([{ decidedAtMs: NOW - 5000, creditedKw: 0.5 }]);
  });

  it('never renews an expired unanswered charge reduction', () => {
    const { state, devices, storage, power } = transition(1000, 0, 2000);
    state.shedPlanLatch = { powerW: 5000, stepTargets: new Map(), decisions: new Map([
      ['battery', [{ decidedAtMs: NOW - 40_000, creditedKw: 1 }]],
    ]) };
    const result = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW, powerW: 5000 }, NOW);
    expect(result?.totalKw).toBe(0);
  });

  it('gives a newly stopped charge its own window after the previous target delivered', () => {
    const { state, devices, storage, power } = transition(1000, 0, 1000);
    state.shedPlanLatch = { powerW: 6000, stepTargets: new Map(), decisions: new Map([
      ['battery', [{ decidedAtMs: NOW - 10_000, creditedKw: 1 }]],
    ]) };
    const result = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW, powerW: 5000 }, NOW);
    expect(result?.retained.decisions.get('battery')).toEqual([{ decidedAtMs: NOW, creditedKw: 1 }]);
  });

  it('cancels pending relief when charging is raised again, retaining the surviving stamp', () => {
    const { state, devices, storage, power } = transition(1000, 2000, 3000);
    state.shedPlanLatch = { powerW: 5000, stepTargets: new Map(), decisions: new Map([
      ['battery', [{ decidedAtMs: NOW - 10_000, creditedKw: 2 }]],
    ]) };
    const result = resolveContinuousChargeRelief(state, devices, storage, power, { atMs: NOW, powerW: 5000 }, NOW);
    expect(result?.totalKw).toBe(1);
    expect(result?.retained.decisions.get('battery')).toEqual([{ decidedAtMs: NOW - 10_000, creditedKw: 1 }]);
  });
});
