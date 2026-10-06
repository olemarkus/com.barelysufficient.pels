// Unit tests for the surplus allocator's POOL COMPOSITION with the inferred
// curtailed-surplus term (`resolveSurplusEligibility` in planSurplusAbsorb):
// additivity, junk-term neutrality (byte-identical to today's pool), the powerOk
// gate ignoring the term, priority reservation over an inferred-enlarged pool,
// and the surplus_pool debug record; and a home battery as a consumer at its
// own place in the priority order (what each battery is offered, and what the
// devices ranked below it are left). Pure over (state, params) — `nowTs` is
// passed explicitly, so no clock is faked.
import { describe, expect, it, vi } from 'vitest';
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
import {
  SURPLUS_ABSORB_MIN_DWELL_MS,
  SURPLUS_ABSORB_SETTLE_MS,
} from '../../lib/plan/admission/surplusAbsorb';
import { type PlanEngineState } from '../../lib/plan/planState';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, NO_STORAGE_SURPLUS } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageSurplus, StorageSurplusOffer } from '../../lib/plan/planSurplusAbsorb';

const DEVICE_ID = 'tank';
const MODE_C = 20;
const EXPECTED_DRAW_KW = 1.0; // engage bar = 1.0 + 0.25 reserve = 1.25 kW

const buildDevice = (
  id: string = DEVICE_ID, currentDrawKw?: number, priority = 1,
): PlanInputDevice => buildPlanInputDevice({
  id,
  name: id,
  priority,
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
  debugStructured?: (payload: Record<string, unknown>) => void;
  storage?: StorageSurplus;
}): ReadonlyMap<string, StorageSurplusOffer> => (
  resolveSurplusEligibility({
    devices: params.devices ?? [buildDevice()],
    state: params.state,
    signedNetKw: params.signedNetKw,
    inferredSurplusKw: params.inferredSurplusKw,
    storage: params.storage ?? NO_STORAGE_SURPLUS,
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
    // Listed low first, so only the priority order can put the high one first.
    const devices = [buildDevice(LO, undefined, 100), buildDevice(HI, undefined, 1)];
    const state = createPlanEngineState();
    // Net 0, inferred 1.5 kW — covers one device (1.0 + 0.25), not two.
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: 0, devices });
    resolve({ state, signedNetKw: 0, inferredSurplusKw: 1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, devices });
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

describe('resolveSurplusEligibility — a home battery at its place in the priority order', () => {
  const BATTERY = 'battery';
  /** Last in the order (the default): devices, then the battery, then export. */
  const BATTERY_LAST = 100;

  const tank = (
    currentDrawKw: number, expectedKw = EXPECTED_DRAW_KW, id = DEVICE_ID, priority = 1,
  ): PlanInputDevice => buildPlanInputDevice({
    id,
    name: id,
    priority,
    deviceType: 'temperature',
    currentTemperature: 50,
    expectedPowerKw: expectedKw,
    currentDrawKw,
    targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  });

  /** A battery PELS may claim, storing this much solar, W, at this priority. */
  const storing = (chargeW: number, priority = BATTERY_LAST, dischargeW = 0): StorageSurplus => ({
    claimants: [{ deviceId: BATTERY, priority, chargeW, reservedW: chargeW }], dischargeW,
  });

  const offerOf = (offers: ReadonlyMap<string, StorageSurplusOffer>): StorageSurplusOffer | undefined => (
    offers.get(BATTERY)
  );

  /** Engage the tank first: 4 kW exported for a settle window. */
  const engaged = (expectedKw = EXPECTED_DRAW_KW): PlanEngineState => {
    const state = createPlanEngineState();
    const devices = [tank(0, expectedKw)];
    resolve({ state, signedNetKw: -4, inferredSurplusKw: 0, nowTs: 0, devices });
    resolve({ state, signedNetKw: -4, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS, devices });
    expect(eligible(state)).toBe(true);
    return state;
  };

  /** Whether the device has a pending engage or is engaged: it claims from the pool. */
  const settling = (state: PlanEngineState, id: string): boolean => (
    state.surplusEligibilityByDevice[id] !== undefined
  );

  it('makes no offer in a home without a battery', () => {
    const offers = resolve({ state: createPlanEngineState(), signedNetKw: -3, inferredSurplusKw: 0, nowTs: 0, devices: [tank(0)] });
    expect(offers.size).toBe(0);
  });

  describe('last in the order (the default)', () => {
    it('takes the smallest step of a device waiting to start out of what the battery is offered', () => {
      // 3 kW exported, the tank settling toward its 1 kW.
      const offers = resolve({
        state: createPlanEngineState(), signedNetKw: -3, inferredSurplusKw: 0, nowTs: 0,
        devices: [tank(0)], storage: storing(0),
      });
      expect(offerOf(offers)).toEqual({ availableW: 2000, demandAbove: 'waiting', belowW: 0, addedBackW: 0 });
    });

    it('takes nothing for a running device: its measured draw is already out of the export', () => {
      // A heat pump expected at 3 kW draws 1.2 kW; the battery's own mode stores the other 1.8 kW.
      const state = engaged(3);
      const offers = resolve({
        state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000,
        devices: [tank(1.2, 3)], storage: storing(1800),
      });
      expect(offerOf(offers)).toEqual({ availableW: 1800, demandAbove: 'running', belowW: 0, addedBackW: 1800 });
    });

    it('reads an engaged device that draws nothing as satisfied', () => {
      const state = engaged();
      const offers = resolve({
        state, signedNetKw: -3, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000,
        devices: [tank(0)], storage: storing(0),
      });
      expect(offerOf(offers)).toEqual({ availableW: 3000, demandAbove: 'none', belowW: 0, addedBackW: 0 });
    });

    it('reads a running device whose draw the surplus no longer covers as wanting nothing', () => {
      const state = engaged();
      // A cloud: the tank still draws its 1 kW, all of it from the grid.
      const offers = resolve({
        state, signedNetKw: 1.5, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000,
        devices: [tank(1)], storage: storing(0),
      });
      expect(offerOf(offers)?.demandAbove).toBe('none');
    });

    it('offers the devices the battery\'s charge, so a battery storing solar never hides it from them', () => {
      const debugStructured = vi.fn();
      // The battery's own mode soaks up all 2 kW of export: the meter reads 0.
      const offers = resolve({
        state: createPlanEngineState(), signedNetKw: 0, inferredSurplusKw: 0, nowTs: 0,
        devices: [tank(0)], storage: storing(2000), debugStructured,
      });
      expect(debugStructured.mock.calls[0]![0]).toMatchObject({
        event: 'surplus_pool', storageChargeKw: 2, storageDischargeKw: 0, poolKw: 2,
      });
      expect(offerOf(offers)).toEqual({ availableW: 1000, demandAbove: 'waiting', belowW: 0, addedBackW: 2000 });
    });

    it('reads a waiting device the pool could never fund as wanting nothing', () => {
      // 0.5 kW of export cannot fund the tank's 1 kW plus the reserve, battery or not.
      const offers = resolve({
        state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0,
        devices: [tank(0)], storage: storing(0),
      });
      expect(offerOf(offers)).toEqual({ availableW: 500, demandAbove: 'none', belowW: 0, addedBackW: 0 });
    });

    it('composes the pool with no willing device, and records it only when a battery charges into it', () => {
      const debugStructured = vi.fn();
      const quiet = resolve({
        state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0,
        devices: [], storage: storing(0), debugStructured,
      });
      expect(offerOf(quiet)).toEqual({ availableW: 500, demandAbove: 'none', belowW: 0, addedBackW: 0 });
      expect(debugStructured).not.toHaveBeenCalled();

      resolve({
        state: createPlanEngineState(), signedNetKw: -0.5, inferredSurplusKw: 0, nowTs: 0,
        devices: [], storage: storing(1000), debugStructured,
      });
      expect(debugStructured).toHaveBeenCalledTimes(1);
    });

    it('comes after a device sharing its priority', () => {
      const offers = resolve({
        state: createPlanEngineState(), signedNetKw: 0, inferredSurplusKw: 0, nowTs: 0,
        devices: [tank(0, EXPECTED_DRAW_KW, DEVICE_ID, 5)], storage: storing(2000, 5),
      });
      expect(offerOf(offers)).toEqual({ availableW: 1000, demandAbove: 'waiting', belowW: 0, addedBackW: 2000 });
    });

    it('decides the devices exactly as a battery with nothing to give, first or last', () => {
      // Two tanks on 2.5 kW of export: the battery's place changes nothing when it stores nothing.
      const run = (storage: StorageSurplus): PlanEngineState => {
        const state = createPlanEngineState();
        const devices = [tank(0, 1, 'a', 2), tank(0, 1, 'b', 7)];
        for (const nowTs of [0, SURPLUS_ABSORB_SETTLE_MS, SURPLUS_ABSORB_SETTLE_MS + 10_000]) {
          resolve({ state, signedNetKw: -2.5, inferredSurplusKw: 0, nowTs, devices, storage });
        }
        return state;
      };
      // The state's app start time comes from the wall clock; leave it out so
      // the runs compare on their decisions alone.
      const decisions = (state: PlanEngineState): string => JSON.stringify({ ...state, appStartedAtMs: 0 });
      const without = decisions(run(NO_STORAGE_SURPLUS));
      expect(decisions(run(storing(0, 1)))).toBe(without);
      expect(decisions(run(storing(0, 5)))).toBe(without);
      expect(decisions(run(storing(0, BATTERY_LAST)))).toBe(without);
    });
  });

  describe('ranked above a device', () => {
    it('takes its charge first: the waiting device below it is not offered it, and makes no demand on it', () => {
      // The battery's own mode stores all 2 kW of solar; the tank ranks below it.
      const state = createPlanEngineState();
      const offers = resolve({
        state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: 0,
        devices: [tank(0, EXPECTED_DRAW_KW, DEVICE_ID, 5)], storage: storing(2000, 1),
      });
      expect(offerOf(offers)).toEqual({ availableW: 2000, demandAbove: 'none', belowW: 0, addedBackW: 2000 });
      expect(settling(state, DEVICE_ID)).toBe(false);
    });

    it('leaves the device below it the export its own mode does not store', () => {
      const state = createPlanEngineState();
      const devices = [tank(0, EXPECTED_DRAW_KW, DEVICE_ID, 5)];
      // 1.5 kW exported past the battery's 2 kW: enough for the tank's 1 kW and the reserve.
      resolve({ state, signedNetKw: -1.5, inferredSurplusKw: 0, nowTs: 0, devices, storage: storing(2000, 1) });
      const offers = resolve({
        state, signedNetKw: -1.5, inferredSurplusKw: 0, nowTs: SURPLUS_ABSORB_SETTLE_MS, devices, storage: storing(2000, 1),
      });
      expect(eligible(state)).toBe(true);
      // The engaged tank's 1 kW is what it takes below the battery: no raise may fund it twice.
      expect(offerOf(offers)).toEqual({ availableW: 3500, demandAbove: 'none', belowW: 1000, addedBackW: 2000 });
    });

    it('is offered what the devices above it leave, and the devices below it only what it leaves', () => {
      // 1 kW exported and 2 kW stored: the tank above the battery claims its 1.5 kW first.
      const state = createPlanEngineState();
      const devices = [tank(0, 1.5, 'above', 1), tank(0, 1, 'below', 9)];
      const offers = resolve({
        state, signedNetKw: -1, inferredSurplusKw: 0, nowTs: 0, devices, storage: storing(2000, 5),
      });
      expect(offerOf(offers)).toEqual({ availableW: 1500, demandAbove: 'waiting', belowW: 0, addedBackW: 2000 });
      expect(settling(state, 'above')).toBe(true);
      // The battery keeps the 1.5 kW the tank above left: nothing is left for the one below.
      expect(settling(state, 'below')).toBe(false);

      // Last in the order, the battery would be offered only what both tanks leave.
      const last = createPlanEngineState();
      const lastOffers = resolve({
        state: last, signedNetKw: -1, inferredSurplusKw: 0, nowTs: 0, devices, storage: storing(2000),
      });
      expect(offerOf(lastOffers)).toEqual({ availableW: 500, demandAbove: 'waiting', belowW: 0, addedBackW: 2000 });
      expect(settling(last, 'below')).toBe(true);
    });

    it('passes on what it does not store to the next battery', () => {
      // 1 kW exported; two batteries each store 1 kW, and a 1.5 kW tank ranks above both.
      const state = createPlanEngineState();
      const offers = resolve({
        state, signedNetKw: -1, inferredSurplusKw: 0, nowTs: 0, devices: [tank(0, 1.5)],
        storage: {
          claimants: [
            { deviceId: 'first', priority: 5, chargeW: 1000, reservedW: 1000 },
            { deviceId: 'second', priority: 6, chargeW: 1000, reservedW: 1000 },
          ],
          dischargeW: 0,
        },
      });
      expect(offers.get('first')).toEqual({ availableW: 1500, demandAbove: 'waiting', belowW: 1000, addedBackW: 1000 });
      // The first keeps its 1 kW: the second is capped for the tank's other 0.5 kW, never both for the same.
      expect(offers.get('second')).toEqual({ availableW: 500, demandAbove: 'waiting', belowW: 0, addedBackW: 1000 });
    });
  });

  describe('discharge', () => {
    it('never offers a battery\'s discharge to a device, wherever the battery ranks', () => {
      for (const priority of [1, BATTERY_LAST]) {
        const state = createPlanEngineState();
        // 2 kW exported, all of it the battery's own discharge.
        const offers = resolve({
          state, signedNetKw: -2, inferredSurplusKw: 0, nowTs: 0,
          devices: [tank(0, EXPECTED_DRAW_KW, DEVICE_ID, 5)], storage: storing(0, priority, 2000),
        });
        expect(settling(state, DEVICE_ID)).toBe(false);
        expect(offerOf(offers)).toEqual({ availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 });
      }
    });

    it('counts every battery\'s discharge as import, never netted against another battery\'s charge', () => {
      const state = engaged();
      const devices = [tank(1)];
      // The meter reads 0 W: one battery discharges 0.5 kW to cover the tank while another stores 0.3 kW.
      // Netted, that is 0.2 kW of discharge, under the 0.35 kW hard-off bar; counted gross it is 0.5 kW.
      const storage: StorageSurplus = {
        claimants: [{ deviceId: 'charging', priority: BATTERY_LAST, chargeW: 300, reservedW: 300 }],
        dischargeW: 500,
      };
      const releaseAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
      resolve({ state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: releaseAt, devices, storage });
      resolve({ state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: releaseAt + SURPLUS_ABSORB_SETTLE_MS, devices, storage });
      // The pool (0.8 kW) no longer covers the tank, and the discharge is the
      // hard-off's import: it yields on the settle, not the five-minute dwell.
      expect(eligible(state)).toBe(false);
      expect(releaseAt + SURPLUS_ABSORB_SETTLE_MS).toBeLessThan(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
    });

    it('counts a discharge hiding the import as import, so an engaged device yields', () => {
      const state = engaged();
      const devices = [tank(1)];
      // The meter reads 0 W while the battery's own mode discharges 0.5 kW to cover the tank.
      const releaseAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
      resolve({ state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: releaseAt, devices, storage: storing(0, 1, 500) });
      resolve({
        state, signedNetKw: 0, inferredSurplusKw: 0, nowTs: releaseAt + SURPLUS_ABSORB_SETTLE_MS,
        devices, storage: storing(0, 1, 500),
      });
      expect(eligible(state)).toBe(false);
    });
  });
});
