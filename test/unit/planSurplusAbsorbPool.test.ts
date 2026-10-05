// Unit tests for the surplus allocator's POOL COMPOSITION with the inferred
// curtailed-surplus term (`resolveSurplusEligibility` in planSurplusAbsorb):
// additivity, junk-term neutrality (byte-identical to today's pool), the powerOk
// gate ignoring the term, priority reservation over an inferred-enlarged pool,
// and the surplus_pool debug record. Pure over (state, params) — `nowTs` is
// passed explicitly, so no clock is faked.
import { describe, expect, it, vi } from 'vitest';
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
import {
  SURPLUS_ABSORB_MIN_DWELL_MS,
  SURPLUS_ABSORB_SETTLE_MS,
} from '../../lib/plan/admission/surplusAbsorb';
import { type PlanEngineState } from '../../lib/plan/planState';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { SurplusLeftover } from '../../lib/plan/planSurplusAbsorb';

const DEVICE_ID = 'tank';
const MODE_C = 20;
const EXPECTED_DRAW_KW = 1.0; // engage bar = 1.0 + 0.25 reserve = 1.25 kW

const buildDevice = (id: string = DEVICE_ID, currentDrawKw?: number): PlanInputDevice => buildPlanInputDevice({
  id,
  name: id,
  ...(currentDrawKw === undefined ? {} : { currentDrawKw }),
  deviceType: 'temperature',
  currentTemperature: 50,
  expectedPowerKw: EXPECTED_DRAW_KW,
  targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
});

const surplusConfig = { surplusWilling: true, surplusDelta: 2 };

const resolve = (params: {
  state: PlanEngineState;
  signedNetKw: number;
  inferredSurplusKw: number;
  nowTs: number;
  devices?: PlanInputDevice[];
  getPriority?: (deviceId: string) => number;
  debugStructured?: (payload: Record<string, unknown>) => void;
  storageSurplusKw?: number;
}): SurplusLeftover => (
  resolveSurplusEligibility({
    devices: params.devices ?? [buildDevice()],
    state: params.state,
    signedNetKw: params.signedNetKw,
    inferredSurplusKw: params.inferredSurplusKw,
    storageSurplusKw: params.storageSurplusKw ?? 0,
    excludeIds: new Set(),
    getConfig: () => surplusConfig,
    debugStructured: params.debugStructured,
    nowTs: params.nowTs,
  })
);

const eligible = (state: PlanEngineState, id: string = DEVICE_ID): boolean => (
  state.surplusEligibilityByDevice[id]?.eligible === true
);

describe('resolveSurplusEligibility — inferred-term pool composition', () => {
  it('the inferred term enlarges the pool: engages at net~0 where measured export alone never would', () => {
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0 });
    expect(eligible(state)).toBe(false); // settle window just opened
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(true);
  });

  // This used to enumerate `null` / `undefined` / `NaN` / negative and prove the
  // pool clamped each to nothing. The producer answers a finite kW >= 0 for
  // every state it can be in and the seam is required, so those four are no
  // longer representable — the clamp went, and the only case left is the one
  // the producer really emits when it has nothing to offer.
  it('a claimed-nothing term is byte-identical to today\'s pool (no engage at net~0)', () => {
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: 0 });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE_ID]).toBeUndefined(); // no pending flip either
  });

  it('sustained import beyond the hard-off bar releases without the dwell once the term stops feeding', () => {
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0 });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(true);
    // The home imports 1 kW and the PRODUCER has latched its term to 0 (its
    // import guard fires at 0.30, below this gate's 0.35 hard-off bar — the
    // producer always stops feeding first). Pool collapses, hard-off clock runs.
    const importAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    resolve({ state, signedNetKw: 1.0, inferredSurplusKw: 0, nowTs: importAt });
    expect(eligible(state)).toBe(true); // settle still applies
    resolve({ state, signedNetKw: 1.0, inferredSurplusKw: 0, nowTs: importAt + SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(false); // released far inside the 5-min dwell
    expect(importAt + SURPLUS_ABSORB_SETTLE_MS).toBeLessThan(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
  });

  it('priority reservation runs over the inferred-enlarged pool: term for one device goes to the top priority', () => {
    const HI = 'tank-hi';
    const LO = 'tank-lo';
    const devices = [buildDevice(HI), buildDevice(LO)];
    const getPriority = (id: string): number => (id === HI ? 1 : 100);
    const state = createPlanEngineState();
    // Net 0, inferred 1.5 kW — covers one device (1.0 + 0.25), not two.
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0, devices, getPriority });
    resolve({
      state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, devices, getPriority,
    });
    expect(eligible(state, HI)).toBe(true);
    expect(eligible(state, LO)).toBe(false);
  });

  it('emits one surplus_pool record per pass carrying the full composition identity', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();
    resolve({ state, signedNetKw: -0.4, inferredSurplusKw: 1.2, nowTs: 0, debugStructured });
    expect(debugStructured).toHaveBeenCalledTimes(1);
    const payload = debugStructured.mock.calls[0]![0] as Record<string, number | string>;
    expect(payload).toMatchObject({
      event: 'surplus_pool',
      measuredExportKw: 0.4,
      addBackKw: 0,
      inferredSurplusKw: 1.2,
    });
    expect(payload.poolKw).toBeCloseTo(1.6, 6);
  });

  it('reconciles the record when the producer claims no term at all (0 kW)', () => {
    // The predecessor of this spec fed `NaN` to prove the pool clamped it. The
    // producer answers a finite kW >= 0 for every state it can be in — declining
    // to claim IS 0 — so the clamp went, and with it the only input that could
    // reach it. What still matters is the identity: the three components sum to
    // poolKw when the inferred term contributes nothing.
    const state = createPlanEngineState();
    const debugStructured = vi.fn();
    resolve({ state, signedNetKw: -0.4, inferredSurplusKw: 0, nowTs: 0, debugStructured });
    const payload = debugStructured.mock.calls[0]![0] as Record<string, number>;
    expect(payload.inferredSurplusKw).toBe(0);
    expect(payload.measuredExportKw + payload.addBackKw + payload.inferredSurplusKw)
      .toBeCloseTo(payload.poolKw, 6);
    expect(payload.poolKw).toBeCloseTo(0.4, 6);
  });
});

describe('resolveSurplusEligibility — what the devices leave for a home battery', () => {
  const tank = (currentDrawKw: number, expectedKw = EXPECTED_DRAW_KW): PlanInputDevice => buildPlanInputDevice({
    id: DEVICE_ID,
    name: DEVICE_ID,
    deviceType: 'temperature',
    currentTemperature: 50,
    expectedPowerKw: expectedKw,
    currentDrawKw,
    targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  });

  /** Engage the tank first: 3 kW exported for a settle window. */
  const engaged = (expectedKw = EXPECTED_DRAW_KW): PlanEngineState => {
    const state = createPlanEngineState();
    const devices = [tank(0, expectedKw)];
    resolve({ state, signedNetKw: -4, inferredSurplusKw: 0, nowTs: 0, devices });
    resolve({ state, signedNetKw: -4, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS, devices });
    expect(eligible(state)).toBe(true);
    return state;
  };

  it('takes the smallest step of a device waiting to start out of what the battery may store', () => {
    // 3 kW exported, the tank settling toward its 1 kW.
    const surplus = resolve({ state: createPlanEngineState(), signedNetKw: -3, inferredSurplusKw: 0, nowTs: 0, devices: [tank(0)] });
    expect(surplus).toEqual({ leftoverW: 2000, deviceDemand: 'waiting' });
  });

  it('takes nothing for a running device: its measured draw is already out of the export', () => {
    // A heat pump expected at 3 kW draws 1.2 kW; the battery's own mode stores the other 1.8 kW.
    const state = engaged(3);
    const surplus = resolve({
      state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000,
      devices: [tank(1.2, 3)], storageSurplusKw: 1.8,
    });
    expect(surplus).toEqual({ leftoverW: 1800, deviceDemand: 'running' });
  });

  it('reads an engaged device that draws nothing as satisfied', () => {
    const state = engaged();
    const surplus = resolve({
      state, signedNetKw: -3, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000, devices: [tank(0)],
    });
    expect(surplus).toEqual({ leftoverW: 3000, deviceDemand: 'none' });
  });

  it('reads a running device whose draw the surplus no longer covers as wanting nothing', () => {
    const state = engaged();
    // A cloud: the tank still draws its 1 kW, all of it from the grid.
    const surplus = resolve({
      state, signedNetKw: 1.5, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000, devices: [tank(1)],
    });
    expect(surplus.deviceDemand).toBe('none');
  });

  it('offers the devices the batteries\' term, so a battery storing solar never hides it from them', () => {
    const debugStructured = vi.fn();
    // The battery's own mode soaks up all 2 kW of export: the meter reads 0.
    const surplus = resolve({
      state: createPlanEngineState(), signedNetKw: 0, inferredSurplusKw: 0, nowTs: 0,
      devices: [tank(0)], storageSurplusKw: 2, debugStructured,
    });
    expect(debugStructured.mock.calls[0]![0]).toMatchObject({ event: 'surplus_pool', storageSurplusKw: 2 });
    expect(surplus).toEqual({ leftoverW: 1000, deviceDemand: 'waiting' });
  });

  it('reads a waiting device the pool could never fund as wanting nothing', () => {
    // 0.5 kW of export cannot fund the tank's 1 kW plus the reserve, battery or not.
    const surplus = resolve({
      state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0, devices: [tank(0)],
    });
    expect(surplus).toEqual({ leftoverW: 500, deviceDemand: 'none' });
  });

  it('composes the pool with no willing device, and records it only when a battery charges into it', () => {
    const debugStructured = vi.fn();
    const quiet = resolve({
      state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0, devices: [], debugStructured,
    });
    expect(quiet).toEqual({ leftoverW: 500, deviceDemand: 'none' });
    expect(debugStructured).not.toHaveBeenCalled();

    resolve({
      state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0,
      devices: [], storageSurplusKw: 1, debugStructured,
    });
    expect(debugStructured).toHaveBeenCalledTimes(1);
  });
});
