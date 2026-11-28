// A one-phase car on a three-phase charger: the solar surplus allocator prices
// each rung at the phases the car draws on, so the car climbs with the surplus
// instead of holding its lowest rung while the rest is exported.
import { describe, expect, it } from 'vitest';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { ChargingDrawPhases } from '../../packages/planner-types/src/phaseFootprint';
import { SURPLUS_ABSORB_SETTLE_MS } from '../../lib/plan/admission/surplusAbsorb';
import { surplusStepKw } from '../../lib/plan/surplusStepPricing';
import { resolveChargingDrawPhases } from '../../lib/phaseFootprint/resolvePhaseFootprint';
import { resolveChargerSessionDrawPhases } from '../../lib/device/chargerPhaseCurrents';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { MeteredPlanInputDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, NO_STORAGE_SURPLUS, resolveSurplusEligibilityForSpec } from '../utils/planTestUtils';

const CHARGER_ID = 'charger';
const ONE_PHASE: ChargingDrawPhases = { kind: 'observed', phases: 1 };
const LADDER: ChargingDrawPhases = { kind: 'ladder' };
// A three-phase amp ladder: 690 W per amp.
const threePhaseLadder: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningPowerW: 4140, planningCurrentA: 6 },
    { id: '10a', planningPowerW: 6900, planningCurrentA: 10 },
    { id: '16a', planningPowerW: 11040, planningCurrentA: 16 },
  ],
};

const charger = (overrides: {
  drawPhases: ChargingDrawPhases;
  stepId: string;
  drawKw: number;
}): MeteredPlanInputDevice => buildPlanInputDevice({
  id: CHARGER_ID,
  name: CHARGER_ID,
  isEvCharger: true,
  steppedLoadProfile: threePhaseLadder,
  selectedStepId: overrides.stepId,
  currentOn: overrides.stepId !== 'off',
  currentDrawKw: overrides.drawKw,
  commandableNow: true,
  surplusTracking: true,
  priority: 1,
  chargingDrawPhases: overrides.drawPhases,
} as Parameters<typeof buildPlanInputDevice>[0]) as MeteredPlanInputDevice;

const resolve = (state: PlanEngineState, devices: PlanInputDevice[], signedNetKw: number, nowTs: number): void => {
  resolveSurplusEligibilityForSpec({
    devices,
    state,
    signedNetKw,
    inferredSurplusKw: 0,
    storage: NO_STORAGE_SURPLUS,
    excludeIds: new Set(),
    getConfig: () => ({ enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 2 }),
    nowTs,
  });
};

const settle = (state: PlanEngineState, device: PlanInputDevice, signedNetKw: number): void => {
  resolve(state, [device], signedNetKw, 0);
  resolve(state, [device], signedNetKw, SURPLUS_ABSORB_SETTLE_MS + 1);
};

const ceiling = (state: PlanEngineState): string | undefined => {
  const decision = state.surplusTrackingByDevice[CHARGER_ID];
  return decision?.kind === 'rung' ? decision.stepId : undefined;
};

describe('surplus pricing for a car drawing on fewer phases than its charger', () => {
  it('scales a three-phase rung to the phases the car draws on, and leaves the ladder figure otherwise', () => {
    const sixAmps = threePhaseLadder.steps[1]!;
    expect(surplusStepKw(sixAmps, ONE_PHASE)).toBeCloseTo(1.38);
    expect(surplusStepKw(sixAmps, { kind: 'observed', phases: 3 })).toBeCloseTo(4.14);
    expect(surplusStepKw(sixAmps, LADDER)).toBeCloseTo(4.14);
  });

  it('climbs above 6 A when a one-phase car at 6 A leaves 2.9 kW exported', () => {
    const state = createPlanEngineState();
    // Pool 2.9 + 1.38 = 4.28 kW: 16 A on one phase is 3.68 kW and fits.
    settle(state, charger({ drawPhases: ONE_PHASE, stepId: '6a', drawKw: 1.38 }), -2.9);
    expect(ceiling(state)).toBe('16a');
  });

  it('holds the lowest rung at the ladder geometry without phase evidence', () => {
    const state = createPlanEngineState();
    // 4.5 kW exported engages 6 A; with its own 1.38 kW added back the pool is
    // 5.88 kW, still short of 10 A (6.9 kW).
    settle(state, charger({ drawPhases: LADDER, stepId: '6a', drawKw: 1.38 }), -4.5);
    expect(ceiling(state)).toBe('6a');
  });

  it('starts a paused one-phase car on 1.7 kW of surplus', () => {
    const state = createPlanEngineState();
    settle(state, charger({ drawPhases: ONE_PHASE, stepId: 'off', drawKw: 0 }), -1.7);
    expect(ceiling(state)).toBe('6a');
  });
});

describe('the phases a car draws on in a plug-in session', () => {
  it('never lowers within a session, so a three-phase ramp-down cannot read as one phase', () => {
    let session = resolveChargerSessionDrawPhases([6, 6, 6], 'plugged_in_charging', undefined);
    for (const currents of [[0, 6, 6], [0, 0, 6], [0, 0, 0]] as const) {
      session = resolveChargerSessionDrawPhases(currents, 'plugged_in_paused', session);
    }
    expect(session).toBe(3);
  });

  it('keeps a one-phase car through a pause and clears it at plug-out', () => {
    const charging = resolveChargerSessionDrawPhases([6, 0, 0], 'plugged_in_charging', undefined);
    const paused = resolveChargerSessionDrawPhases([0, 0, 0], 'plugged_in_paused', charging);
    expect(paused).toBe(1);
    expect(resolveChargerSessionDrawPhases([0, 0, 0], 'plugged_out', paused)).toBeUndefined();
  });

  it('keeps the session when the plug state is not readable', () => {
    expect(resolveChargerSessionDrawPhases([0, 0, 0], undefined, 1)).toBe(1);
  });
});

describe('resolveChargingDrawPhases', () => {
  const facts = {
    isEvCharger: true, chargerPhaseCurrentsA: undefined, sessionDrawPhases: undefined, learned: undefined,
  } as const;

  it('reads the live current when the device carries no session', () => {
    expect(resolveChargingDrawPhases({ ...facts, chargerPhaseCurrentsA: [0, 6, 0] })).toEqual(ONE_PHASE);
  });

  it('takes what the session has shown over a learned pattern', () => {
    expect(resolveChargingDrawPhases({ ...facts, sessionDrawPhases: 3, learned: { kind: 'single', phase: 'L2' } }))
      .toEqual({ kind: 'observed', phases: 3 });
    expect(resolveChargingDrawPhases({ ...facts, sessionDrawPhases: 1 })).toEqual(ONE_PHASE);
  });

  it('falls back to a settled learned pattern, and otherwise to the ladder', () => {
    expect(resolveChargingDrawPhases({ ...facts, learned: { kind: 'single', phase: 'L2' } })).toEqual(ONE_PHASE);
    expect(resolveChargingDrawPhases(facts)).toEqual(LADDER);
    expect(resolveChargingDrawPhases({ ...facts, isEvCharger: false, sessionDrawPhases: 1 })).toEqual(LADDER);
  });
});

describe('phase room for a one-phase car on a three-phase installation', () => {
  // The footprint stays all_three (the ladder's geometry): a rung's nameplate
  // spread over three phases is what the car's one phase really carries.
  const phase = (name: 'L1' | 'L2' | 'L3', drawKw: number) => ({
    phase: name, drawKw, targetKw: 5.175, roomKw: 5.175 - drawKw, breached: false, exportBreached: false, exportExcessKw: 0,
  });
  // Engaged first on ample room, then built with L1 drawing `l1DrawKw`.
  const climb = (l1DrawKw: number): string | undefined => {
    const state = createPlanEngineState();
    const car = buildPlanInputDevice({
      ...charger({ drawPhases: ONE_PHASE, stepId: '6a', drawKw: 1.38 }),
      phaseFootprint: { kind: 'all_three' },
    } as Parameters<typeof buildPlanInputDevice>[0]);
    const powerAt = (l1: number) => ({ kind: 'on' as const, phases: [phase('L1', l1), phase('L2', -1.125), phase('L3', -1.125)] });
    const builds = [[0, 1.875], [SURPLUS_ABSORB_SETTLE_MS + 1, 1.875], [SURPLUS_ABSORB_SETTLE_MS + 2, l1DrawKw]] as const;
    for (const [nowTs, l1] of builds) {
      resolveSurplusEligibilityForSpec({
        devices: [car], state, signedNetKw: -5, inferredSurplusKw: 0, storage: NO_STORAGE_SURPLUS,
        excludeIds: new Set(), nowTs, phase: powerAt(l1),
        getConfig: () => ({ enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 2 }),
      });
    }
    return ceiling(state);
  };

  it('climbs to 16 A while its phase has 3 kW of room', () => {
    // 16 A adds 2.3 kW on the car's phase.
    expect(climb(1.875)).toBe('16a');
  });

  it('holds 6 A when its phase has 0.8 kW of room, which 10 A (+0.92 kW) would overrun', () => {
    expect(climb(4.075)).toBe('6a');
  });
});
