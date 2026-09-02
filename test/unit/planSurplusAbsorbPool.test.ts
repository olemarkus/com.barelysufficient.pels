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
import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const DEVICE_ID = 'tank';
const MODE_C = 20;
const EXPECTED_DRAW_KW = 1.0; // engage bar = 1.0 + 0.25 reserve = 1.25 kW

const buildDevice = (id: string = DEVICE_ID): PlanInputDevice => buildPlanInputDevice({
  id,
  name: id,
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
}): void => {
  resolveSurplusEligibility({
    devices: params.devices ?? [buildDevice()],
    state: params.state,
    signedNetKw: params.signedNetKw,
    inferredSurplusKw: params.inferredSurplusKw,
    getConfig: () => surplusConfig,
    debugStructured: params.debugStructured,
    nowTs: params.nowTs,
  });
};

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
