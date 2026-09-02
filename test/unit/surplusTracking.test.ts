// Unit tests for the surplus-TRACKING modality (the third, modulating absorber):
// `resolveSurplusTrackingPosture` candidacy, the ladder helper
// `resolveHighestStepWithinKw`, and the variable-claimant branch of
// `resolveSurplusEligibility` — rung choice, the `commandableNow` zero-claim, the
// stop decision, and the remainder a fixed claimant would have discarded.
// Pure over (state, params) — `nowTs` is passed explicitly, so no clock is faked.
import { describe, expect, it } from 'vitest';
import {
  resolveSurplusEligibility,
  resolveSurplusTrackingPosture,
} from '../../lib/plan/planSurplusAbsorb';
import { resolveHighestStepWithinKw } from '../../lib/plan/planSteppedLoad';
import { applyPostSheddingHolds } from '../../lib/plan/planBuilderSurplus';
import {
  SURPLUS_ABSORB_SETTLE_MS,
  SURPLUS_TRACK_STEP_MIN_INTERVAL_MS,
} from '../../lib/plan/admission/surplusAbsorb';
import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import { buildPlanInputDevice, steppedProfile } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const CHARGER_ID = 'charger';
// steppedProfile rungs: off 0 W, low 1250 W, medium 2000 W, max 3000 W — so the
// ladder floor is 1.25 kW and the engage bar is 1.5 kW with the 0.25 reserve.

const candidateParams = (overrides: Partial<Parameters<typeof resolveSurplusTrackingPosture>[0]> = {}) => ({
  surplusWilling: true,
  targets: undefined,
  steppedLoadProfile: steppedProfile,
  controllable: true,
  managed: true,
  surplusPoolReachable: true,
  ...overrides,
});

const buildTracker = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => (
  buildPlanInputDevice({
    id: CHARGER_ID,
    name: CHARGER_ID,
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'off',
    currentOn: true,
    commandableNow: true,
    surplusTracking: true,
    priority: 1,
    ...overrides,
  } as Parameters<typeof buildPlanInputDevice>[0])
);

const resolve = (params: {
  state: PlanEngineState;
  signedNetKw: number;
  nowTs: number;
  devices: PlanInputDevice[];
  debugStructured?: (payload: Record<string, unknown>) => void;
}): void => {
  resolveSurplusEligibility({
    devices: params.devices,
    state: params.state,
    signedNetKw: params.signedNetKw,
    inferredSurplusKw: 0,
    getConfig: () => ({ surplusWilling: true, surplusDelta: 2 }),
    debugStructured: params.debugStructured,
    nowTs: params.nowTs,
  });
};

/** The `surplus_pool` composition record the allocator emits once per pass. */
const poolRecord = (params: {
  state: PlanEngineState;
  signedNetKw: number;
  nowTs: number;
  devices: PlanInputDevice[];
}): Record<string, unknown> => {
  const records: Record<string, unknown>[] = [];
  resolve({ ...params, debugStructured: (payload) => records.push(payload) });
  const pool = records.find((record) => record.event === 'surplus_pool');
  if (!pool) throw new Error('no surplus_pool record emitted');
  return pool;
};

/** Drive the settle window so the engage flip actually lands. */
const engage = (params: {
  state: PlanEngineState;
  signedNetKw: number;
  devices: PlanInputDevice[];
}): void => {
  resolve({ ...params, nowTs: 0 });
  resolve({ ...params, nowTs: SURPLUS_ABSORB_SETTLE_MS + 1 });
};

const ceiling = (state: PlanEngineState, id: string = CHARGER_ID): string | undefined => {
  const decision = state.surplusTrackingByDevice[id];
  return decision?.kind === 'rung' ? decision.stepId : undefined;
};

const stopped = (state: PlanEngineState, id: string = CHARGER_ID): boolean => (
  state.surplusTrackingByDevice[id]?.kind === 'stopped'
);

describe('resolveSurplusTrackingPosture — candidacy', () => {
  it('accepts a managed, controllable stepped load in a home whose pool can open', () => {
    expect(resolveSurplusTrackingPosture(candidateParams())).toBe(true);
  });

  it.each([
    ['not opted in', { surplusWilling: false }],
    ['opt-in absent', { surplusWilling: undefined }],
    ['pool can never open', { surplusPoolReachable: false }],
    ['no step ladder', { steppedLoadProfile: undefined }],
    ['not controllable', { controllable: false }],
    ['not managed', { managed: false }],
  ])('rejects when %s', (_label, overrides) => {
    expect(resolveSurplusTrackingPosture(candidateParams(overrides))).toBe(false);
  });

  it('rejects a temperature device — that modality gets the setpoint lift, not a ceiling', () => {
    expect(resolveSurplusTrackingPosture(candidateParams({
      targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 5, max: 30, step: 0.5 }],
    }))).toBe(false);
  });

  it('does NOT ask for standing demand — a charger qualifies where the dump-load posture will not', () => {
    // The binary posture's `hasStandingDemand` gate has no counterpart here; the
    // unplugged-charger concern it carries is answered by `commandableNow` at the
    // allocator instead (see the claim tests below).
    expect(resolveSurplusTrackingPosture(candidateParams())).toBe(true);
  });
});

describe('resolveHighestStepWithinKw', () => {
  const device = buildTracker();

  it('answers the highest active rung whose admission power fits', () => {
    expect(resolveHighestStepWithinKw(device, 2.5)?.id).toBe('medium');
    expect(resolveHighestStepWithinKw(device, 3.0)?.id).toBe('max');
  });

  it('answers the floor rung when only it fits', () => {
    expect(resolveHighestStepWithinKw(device, 1.3)?.id).toBe('low');
  });

  it('answers null below the floor — never the off rung', () => {
    expect(resolveHighestStepWithinKw(device, 1.0)).toBeNull();
    expect(resolveHighestStepWithinKw(device, 0)).toBeNull();
  });

  it('answers null for a non-finite budget rather than picking a rung', () => {
    expect(resolveHighestStepWithinKw(device, Number.NaN)).toBeNull();
  });
});

describe('surplus tracking — the variable claimant', () => {
  it('parks the device on the highest rung the pool covers', () => {
    const state = createPlanEngineState();
    // 3.3 kW export − 0.25 reserve = 3.05 kW budget → `max` (3.0 kW) fits.
    engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('max');
  });

  it('drops to a lower rung as the pool shrinks', () => {
    const state = createPlanEngineState();
    engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('max');
    // 2.3 kW export − 0.25 = 2.05 kW → `medium` (2.0 kW) is the highest that fits.
    resolve({ state, signedNetKw: -2.3, nowTs: SURPLUS_ABSORB_SETTLE_MS + 2, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('medium');
  });

  it('claims nothing for a device that cannot draw, so the pool passes to the next device', () => {
    const state = createPlanEngineState();
    const unplugged = buildTracker({ commandableNow: false });
    const tank = buildPlanInputDevice({
      id: 'tank',
      name: 'tank',
      deviceType: 'temperature',
      currentTemperature: 50,
      expectedPowerKw: 1.0,
      priority: 2,
      targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 0, max: 95, step: 0.5 }],
    });
    // The charger outranks the tank, and 1.5 kW would not cover both.
    engage({ state, signedNetKw: -1.5, devices: [unplugged, tank] });

    expect(ceiling(state)).toBeUndefined();
    expect(state.surplusEligibilityByDevice[CHARGER_ID]).toBeUndefined();
    // The tank got the whole pool because the unplugged charger reserved none of it.
    expect(state.surplusEligibilityByDevice.tank?.eligible).toBe(true);
  });

  it('hands the unclaimed remainder down the priority order', () => {
    const state = createPlanEngineState();
    const tank = buildPlanInputDevice({
      id: 'tank',
      name: 'tank',
      deviceType: 'temperature',
      currentTemperature: 50,
      expectedPowerKw: 1.0,
      priority: 2,
      targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 0, max: 95, step: 0.5 }],
    });
    // 4.5 kW export, and the charger's ladder tops out at 3.0 kW. It claims that
    // rung and no more, leaving 1.5 kW — enough to clear the tank's 1.0 + 0.25
    // engage bar. A FIXED claimant would have reserved `getHighestKnownPowerKw`
    // (4.0 kW here), left 0.5 kW, and starved the tank on surplus the charger
    // could never have drawn.
    engage({
      state,
      signedNetKw: -4.5,
      devices: [buildTracker({ expectedPowerKw: 4.0 }), tank],
    });
    expect(ceiling(state)).toBe('max');
    expect(state.surplusEligibilityByDevice.tank?.eligible).toBe(true);
  });

  describe('stopping', () => {
    it('stops the device when the surplus cannot fund even the ladder floor', () => {
      const state = createPlanEngineState();
      resolve({ state, signedNetKw: -0.5, nowTs: 0, devices: [buildTracker()] });
      expect(stopped(state)).toBe(true);
      expect(ceiling(state)).toBeUndefined();
    });

    it('says only THAT it stops — never which rung to park on', () => {
      // Where a stopped device parks is the configured shed action's answer,
      // resolved on the ordinary shed path. This module inventing a rung is the
      // bug that made a solar stop land somewhere a capacity stop never would.
      const state = createPlanEngineState();
      resolve({ state, signedNetKw: -0.5, nowTs: 0, devices: [buildTracker()] });
      expect(state.surplusTrackingByDevice[CHARGER_ID]).toEqual({ kind: 'stopped' });
    });

    it('keeps a rung it already holds on the bare pool — the reserve only buys a HIGHER one', () => {
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -3.3, devices: [buildTracker({ currentDrawKw: 0 })] });
      expect(ceiling(state)).toBe('max');

      // Pool = 0.05 measured + 3.0 added back = 3.05 kW. That covers `max`
      // (3.0 kW) bare but NOT with the 0.25 reserve, so a fresh purchase would
      // only reach `medium`. Re-pricing a rung the device already holds is what
      // turned a passing cloud into a charger current change.
      const drawing = [buildTracker({ currentDrawKw: 3.0, selectedStepId: 'max' })];
      resolve({ state, signedNetKw: -0.05, nowTs: SURPLUS_ABSORB_SETTLE_MS + 2, devices: drawing });
      expect(ceiling(state)).toBe('max');
    });

    it('marks a rung the pool did not pay for as UNFUNDED, so no card claims solar', () => {
      // While the release settle/dwell runs the gate still says the device may
      // run, so it holds its cheapest rung on grid power. That is the same
      // window every surplus modality has — but calling it "running on solar"
      // would be false, so the allocator records which it is.
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -1.6, devices: [buildTracker({ currentDrawKw: 0 })] });
      expect(state.surplusTrackingByDevice[CHARGER_ID]).toEqual({
        kind: 'rung', stepId: 'low', funded: true,
      });

      // Pool collapses to 0.3 kW — under the 1.25 kW floor, but still positive,
      // so the hard-off bypass does not arm and the dwell has to run.
      resolve({
        state,
        signedNetKw: -0.3,
        nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
        devices: [buildTracker({ currentDrawKw: 0 })],
      });
      expect(state.surplusTrackingByDevice[CHARGER_ID]).toEqual({
        kind: 'rung', stepId: 'low', funded: false,
      });
    });

    it('keeps its rung across the whole reserve band, so the settle owns the stop', () => {
      // The regression. The engage bar is floor + reserve (1.5 kW) and the gate
      // releases at a bare floor (1.25 kW). A pool inside that band used to fund
      // no rung at all, stopping the device on ONE build with no settle and no
      // dwell — a passing cloud ending a charging session outright.
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -1.6, devices: [buildTracker()] });
      expect(ceiling(state)).toBe('low');

      for (const [index, poolKw] of [1.45, 1.35, 1.3, 1.26].entries()) {
        resolve({
          state,
          signedNetKw: -poolKw,
          nowTs: SURPLUS_ABSORB_SETTLE_MS + 2 + index,
          devices: [buildTracker({ currentDrawKw: 0 })],
        });
        expect(stopped(state)).toBe(false);
        expect(ceiling(state)).toBe('low');
      }
    });
  });

  it('adds back the draw of a stopped device that is still drawing', () => {
    // A stop is a shed, and a shed parks the device wherever its configured shed
    // action says — `set_step`, or `turn_off` on a step-only stepper, both still
    // draw. That draw depresses measured export exactly as an engaged one does,
    // so without the add-back the pool reads low by the device's own consumption
    // and it can never earn its way back up: re-engaging took roughly twice the
    // true surplus it should have.
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: -0.2, nowTs: 0, devices: [buildTracker()] });
    expect(stopped(state)).toBe(true);

    // True surplus is now 1.8 kW, comfortably over the 1.5 kW engage bar — but
    // the device is drawing its 1.25 kW shed floor, so the meter shows only
    // 0.55 kW of export. The pool must reconstruct to 1.8 kW, not read 0.55.
    const drawing = [buildTracker({ currentDrawKw: 1.25, selectedStepId: 'low' })];
    resolve({ state, signedNetKw: -0.55, nowTs: 1, devices: drawing });
    resolve({ state, signedNetKw: -0.55, nowTs: SURPLUS_ABSORB_SETTLE_MS + 2, devices: drawing });
    expect(stopped(state)).toBe(false);
    expect(ceiling(state)).toBe('low');
  });

  it('does not credit the draw of a device it can no longer command', () => {
    // The claim path already returns 0 for a non-commandable device and clears
    // its decision. Crediting its draw as well would hand lower-priority devices
    // export that nothing is going to free — the device keeps consuming it, and
    // PELS has no way to ask it to stop.
    const state = createPlanEngineState();
    engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('max');

    const record = poolRecord({
      state,
      signedNetKw: -0.2,
      nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
      devices: [buildTracker({
        commandableNow: false, currentDrawKw: 3.0, selectedStepId: 'max',
      })],
    });
    expect(record.addBackKw).toBe(0);
  });

  it('leaves a boosted tracker to the boost — no add-back, and no decision', () => {
    // A boost outranks the surplus posture, so this module cannot end the draw.
    // It is ordinary household load from here: already in the meter, and not the
    // allocator's to hand to a higher-priority absorber as if it were export.
    const state = createPlanEngineState();
    engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('max');

    const record = poolRecord({
      state,
      signedNetKw: -0.2,
      nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
      devices: [buildTracker({
        boostRequested: true, currentDrawKw: 3.0, selectedStepId: 'max',
      })],
    });
    expect(record.addBackKw).toBe(0);
    expect(state.surplusTrackingByDevice[CHARGER_ID]).toBeUndefined();
  });

  it('drops the ceiling when the device stops being a candidate', () => {
    const state = createPlanEngineState();
    engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
    expect(ceiling(state)).toBe('max');
    resolve({
      state,
      signedNetKw: -3.3,
      nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
      devices: [buildTracker({ surplusTracking: undefined })],
    });
    expect(ceiling(state)).toBeUndefined();
  });

  // The add-back term in `composeSurplusPool` is what makes tracking stable at
  // all. A tracking device consumes the very export that bought it its rung, so
  // measured net walks back toward zero as it draws. Without the add-back the
  // next build would see a collapsed pool, drop the device to `off`, watch
  // export reappear, and re-engage — a limit cycle at the settle period.
  it('holds its rung once drawing, because its own draw is added back to the pool', () => {
    const state = createPlanEngineState();
    // PV covers 3.0 kW beyond the rest of the house. Cold start: nothing drawing,
    // so the whole 3.0 kW shows as export.
    engage({ state, signedNetKw: -3.0, devices: [buildTracker({ currentDrawKw: 0 })] });
    const engagedRung = ceiling(state);
    expect(engagedRung).toBe('medium');

    // Now it is drawing that rung, so measured export has shrunk by the same
    // 2.0 kW. The pool must reconstruct to 3.0 kW, not to the 1.0 kW the meter
    // now shows.
    resolve({
      state,
      signedNetKw: -1.0,
      nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
      devices: [buildTracker({ currentDrawKw: 2.0 })],
    });
    expect(ceiling(state)).toBe(engagedRung);
  });

  describe('rung pacing', () => {
    it('holds a climb back until the pacing interval has passed', () => {
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -1.6, devices: [buildTracker()] });
      expect(ceiling(state)).toBe('low');

      // Sun comes out one build later. The pool now covers `max`, but the
      // ceiling only moved up a moment ago — a charger current change every
      // build is exactly what the interval exists to prevent.
      resolve({
        state,
        signedNetKw: -3.3,
        nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
        devices: [buildTracker({ currentDrawKw: 1.25 })],
      });
      expect(ceiling(state)).toBe('low');

      resolve({
        state,
        signedNetKw: -3.3,
        nowTs: SURPLUS_ABSORB_SETTLE_MS + SURPLUS_TRACK_STEP_MIN_INTERVAL_MS + 2,
        devices: [buildTracker({ currentDrawKw: 1.25 })],
      });
      expect(ceiling(state)).toBe('max');
    });

    it('drops immediately — pacing is asymmetric on purpose', () => {
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
      expect(ceiling(state)).toBe('max');

      // A cloud, one build later. The device is drawing 3.0 kW against a true
      // surplus that just fell to 2.2 kW, so the meter now shows 0.8 kW of
      // IMPORT — and the pool reconstructs to 2.2 kW through the add-back,
      // leaving 1.95 kW after the reserve. The answer is to step down,
      // immediately: waiting would mean importing against surplus that is
      // already gone.
      resolve({
        state,
        signedNetKw: 0.8,
        nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
        devices: [buildTracker({ currentDrawKw: 3.0 })],
      });
      expect(ceiling(state)).toBe('low');
    });

    it('steps down rather than releasing when its own draw is what pushed net positive', () => {
      // The regression this guards: the shared hard-off test reads raw net
      // import at a 0.35 kW threshold. Applied to a modulating absorber it would
      // fire on ANY cloud — the device's own draw is what made net positive — and
      // slam it to `off` instead of down a rung. A tracking device is therefore
      // hard-off on the POOL being gone, not on the meter reading positive.
      const state = createPlanEngineState();
      engage({ state, signedNetKw: -3.3, devices: [buildTracker()] });
      resolve({
        state,
        signedNetKw: 1.5,
        nowTs: SURPLUS_ABSORB_SETTLE_MS + 2,
        devices: [buildTracker({ currentDrawKw: 3.0 })],
      });
      // Pool = -1.5 + 3.0 = 1.5 kW, budget 1.25 → still on the ladder, at `low`.
      expect(ceiling(state)).toBe('low');
    });
  });

  it('gates on the ladder FLOOR — the cost of running at all', () => {
    // The engage bar is the floor rung plus the reserve (1.25 + 0.25 = 1.5 kW),
    // not the rung finally chosen. 1.4 kW of export cannot buy the device onto
    // its ladder at all — from a cold start it never engages, so it stops.
    // (Once engaged the band is asymmetric: see the reserve-band case above,
    // where the same 1.4 kW keeps a rung the device already holds.)
    const below = createPlanEngineState();
    engage({ state: below, signedNetKw: -1.4, devices: [buildTracker()] });
    expect(stopped(below)).toBe(true);

    const above = createPlanEngineState();
    engage({ state: above, signedNetKw: -1.6, devices: [buildTracker()] });
    expect(ceiling(above)).toBe('low');
  });
});

describe('a solar stop that lands on a device capacity already priced', () => {
  it("clears the shedding planner's rung so the configured shed action decides", () => {
    // Both lanes can pick the same device in one build: `selectShedDevices` runs
    // first and may price a capacity shed at a gentle rung, and the solar hold is
    // merged afterwards. Materialization delivers the DECIDED rung and consults
    // the configured shed action only when none was decided, so leaving the
    // capacity rung in place parks the charger at that rung — importing from the
    // grid under a card reading "Waiting for solar surplus".
    const state = createPlanEngineState();
    const shedSet = new Set<string>([CHARGER_ID]);
    const shedStepTargets = new Map<string, string>([[CHARGER_ID, 'medium']]);

    applyPostSheddingHolds({
      shedSet,
      shedStepTargets,
      forceShedSet: [],
      surplusHoldIds: [CHARGER_ID],
      admittedDevices: [buildTracker()],
      state,
    });

    expect(shedSet.has(CHARGER_ID)).toBe(true);
    expect(shedStepTargets.has(CHARGER_ID)).toBe(false);
  });

  it('leaves the rung of a device the solar posture is not holding', () => {
    const state = createPlanEngineState();
    const shedStepTargets = new Map<string, string>([[CHARGER_ID, 'medium']]);

    applyPostSheddingHolds({
      shedSet: new Set<string>([CHARGER_ID]),
      shedStepTargets,
      forceShedSet: [],
      surplusHoldIds: [],
      admittedDevices: [buildTracker()],
      state,
    });

    expect(shedStepTargets.get(CHARGER_ID)).toBe('medium');
  });
});
