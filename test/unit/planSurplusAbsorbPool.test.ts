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
  signedNetKw: number | null;
  inferredSurplusKw?: number | null;
  powerKnown?: boolean;
  nowTs: number;
  devices?: PlanInputDevice[];
  getPriority?: (deviceId: string) => number;
  debugStructured?: (payload: Record<string, unknown>) => void;
}): void => {
  resolveSurplusEligibility({
    devices: params.devices ?? [buildDevice()],
    state: params.state,
    signedNetKw: (params.powerKnown ?? true) ? params.signedNetKw : null,
    inferredSurplusKw: params.inferredSurplusKw,
    getConfig: () => surplusConfig,
    getPriority: params.getPriority ?? (() => 100),
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

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['negative', -3],
  ])('a %s inferred term is byte-identical to today\'s pool (no engage at net~0)', (_label, term) => {
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: 0, inferredSurplusKw: term, nowTs: 0 });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: term, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE_ID]).toBeUndefined(); // no pending flip either
  });

  it('powerOk=false ignores the term entirely: an engaged device releases despite a huge inferred value', () => {
    const state = createPlanEngineState();
    // Engage on the inferred term first.
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0 });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(true);
    // Meter goes stale: no surplus to allocate — the inferred term must not hold
    // the engagement (never raise blind on inference alone). Power-unknown is also
    // a hard-off condition, so the release skips the min dwell after one settle.
    const lostAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    resolve({ state, signedNetKw: null, powerKnown: false, inferredSurplusKw: 99, nowTs: lostAt });
    expect(eligible(state)).toBe(true); // release settle still applies
    resolve({
      state, signedNetKw: null, powerKnown: false, inferredSurplusKw: 99, nowTs: lostAt + SURPLUS_ABSORB_SETTLE_MS,
    });
    expect(eligible(state)).toBe(false);
    expect(lostAt + SURPLUS_ABSORB_SETTLE_MS).toBeLessThan(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
  });

  it('sustained import beyond the hard-off bar releases without the dwell once the term stops feeding', () => {
    const state = createPlanEngineState();
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0 });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(eligible(state)).toBe(true);
    // The home imports 1 kW and the PRODUCER has latched the term to null (its
    // import guard fires at 0.30, below this gate's 0.35 hard-off bar — the
    // producer always stops feeding first). Pool collapses, hard-off clock runs.
    const importAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    resolve({ state, signedNetKw: 1.0, inferredSurplusKw: null, nowTs: importAt });
    expect(eligible(state)).toBe(true); // settle still applies
    resolve({ state, signedNetKw: 1.0, inferredSurplusKw: null, nowTs: importAt + SURPLUS_ABSORB_SETTLE_MS });
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

  it('logs a junk/absent inferred term as its clamped 0 contribution (record reconciles to poolKw)', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();
    resolve({ state, signedNetKw: -0.4, inferredSurplusKw: Number.NaN, nowTs: 0, debugStructured });
    const payload = debugStructured.mock.calls[0]![0] as Record<string, number>;
    // The logged component is the CLAMPED value that entered the pool (0), so the
    // three components sum to poolKw even for a junk/negative raw term.
    expect(payload.inferredSurplusKw).toBe(0);
    expect(payload.measuredExportKw + payload.addBackKw + payload.inferredSurplusKw)
      .toBeCloseTo(payload.poolKw, 6);
    expect(payload.poolKw).toBeCloseTo(0.4, 6);
  });

  it('logs a negative inferred term as its clamped 0 contribution', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();
    resolve({ state, signedNetKw: -0.4, inferredSurplusKw: -3, nowTs: 0, debugStructured });
    const payload = debugStructured.mock.calls[0]![0] as Record<string, number>;
    expect(payload.inferredSurplusKw).toBe(0);
    expect(payload.poolKw).toBeCloseTo(0.4, 6);
  });
});
