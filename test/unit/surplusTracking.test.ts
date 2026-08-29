// Unit tests for the surplus-TRACKING modality (the third, modulating absorber):
// `resolveSurplusTrackingPosture` candidacy, the ladder helper
// `resolveHighestStepWithinKw`, and the variable-claimant branch of
// `resolveSurplusEligibility` — rung choice, the `commandableNow` zero-claim, the
// two floor policies, and the remainder a fixed claimant would have discarded.
// Pure over (state, params) — `nowTs` is passed explicitly, so no clock is faked.
import { describe, expect, it } from 'vitest';
import {
  resolveSurplusEligibility,
  resolveSurplusTrackingPosture,
  type SurplusFloorPolicy,
} from '../../lib/plan/planSurplusAbsorb';
import { resolveHighestStepWithinKw } from '../../lib/plan/planSteppedLoad';
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
  signedNetKw: number | null;
  nowTs: number;
  devices: PlanInputDevice[];
  floor?: SurplusFloorPolicy;
}): void => {
  resolveSurplusEligibility({
    devices: params.floor
      ? params.devices.map((dev) => ({ ...dev, surplusFloor: params.floor } as PlanInputDevice))
      : params.devices,
    state: params.state,
    signedNetKw: params.signedNetKw,
    getConfig: () => ({ surplusWilling: true, surplusDelta: 2 }),
    nowTs: params.nowTs,
  });
};

/** Drive the settle window so the engage flip actually lands. */
const engage = (params: {
  state: PlanEngineState;
  signedNetKw: number;
  devices: PlanInputDevice[];
  floor?: SurplusFloorPolicy;
}): void => {
  resolve({ ...params, nowTs: 0 });
  resolve({ ...params, nowTs: SURPLUS_ABSORB_SETTLE_MS + 1 });
};

const ceiling = (state: PlanEngineState, id: string = CHARGER_ID): string | undefined => (
  state.surplusTrackingStepByDevice[id]
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

  describe('floor policy', () => {
    it("'off' parks the device on its off rung when nothing fits", () => {
      const state = createPlanEngineState();
      resolve({ state, signedNetKw: -0.5, nowTs: 0, devices: [buildTracker()], floor: 'off' });
      expect(ceiling(state)).toBe('off');
    });

    it("'minimum' holds the floor rung when nothing fits", () => {
      const state = createPlanEngineState();
      resolve({ state, signedNetKw: -0.5, nowTs: 0, devices: [buildTracker()], floor: 'minimum' });
      expect(ceiling(state)).toBe('low');
    });

    it("'minimum' reserves the floor it is importing against, so a lower-priority device is not offered it", () => {
      const state = createPlanEngineState();
      const tank = buildPlanInputDevice({
        id: 'tank',
        name: 'tank',
        deviceType: 'temperature',
        currentTemperature: 50,
        expectedPowerKw: 0.2,
        targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 0, max: 95, step: 0.5 }],
      });
      // 0.5 kW export: nothing covers the charger's 1.25 kW floor, but under
      // `'minimum'` it keeps drawing it — so the pool goes negative and the tank,
      // which would otherwise have cleared its 0.2 + 0.25 bar, must not engage.
      engage({ state, signedNetKw: -0.5, devices: [buildTracker(), tank], floor: 'minimum' });
      expect(ceiling(state)).toBe('low');
      expect(state.surplusEligibilityByDevice.tank?.eligible).not.toBe(true);
    });

    it('defaults to the conservative off policy when the setting is absent', () => {
      const state = createPlanEngineState();
      resolve({ state, signedNetKw: -0.5, nowTs: 0, devices: [buildTracker()] });
      expect(ceiling(state)).toBe('off');
    });
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
    // its ladder at all.
    const below = createPlanEngineState();
    engage({ state: below, signedNetKw: -1.4, devices: [buildTracker()] });
    expect(ceiling(below)).toBe('off');

    const above = createPlanEngineState();
    engage({ state: above, signedNetKw: -1.6, devices: [buildTracker()] });
    expect(ceiling(above)).toBe('low');
  });
});
