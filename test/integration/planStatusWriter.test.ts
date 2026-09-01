import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanStatusWriter } from '../../lib/plan/planStatusWriter';
import type { DevicePlan, StatusPlanChanges } from '../../lib/plan/planTypes';
import type { FlowPort, FlowToken, FlowTriggerCard } from '../../lib/ports/homeyRuntime';
import { buildPlanMeta } from '../utils/planTestUtils';
import { PriceLevel } from '../../lib/price/priceLevels';

/* -------------------------------------------------------------------------- *
 * PlanStatusWriter persist cadence. Pins the per-home posture-flip guarantee:
 * a change in the effective (membership-gated) dry-run must force a status
 * persist even inside the volatile throttle window, while the main home (which
 * passes `dryRunEffective: undefined`) keeps its exact throttle cadence.
 * -------------------------------------------------------------------------- */

const VOLATILE_WRITE_THROTTLE_MS = 60 * 1000;
// A realistic epoch base: the first write must land on a non-zero clock so
// `lastPelsStatusWriteMs` leaves its "never written" (0) sentinel behind.
const BASE_MS = 1_700_000_000_000;

type TriggerRecord = { tokens: unknown; state: unknown };

// Records every `price_level_changed` fire so the trigger can be asserted
// independently of whether a status write happened.
const recordingFlow = (fired: TriggerRecord[]): FlowPort => ({
  getTriggerCard: (): FlowTriggerCard => ({
    trigger: (tokens?: unknown, state?: unknown) => {
      fired.push({ tokens, state });
      return Promise.resolve(undefined);
    },
  }),
  createToken: (): Promise<FlowToken> => Promise.resolve({ setValue: () => Promise.resolve(undefined) }),
});

const plan = (totalKw: number): DevicePlan => ({
  meta: buildPlanMeta({ totalKw, softLimitKw: 6, headroomKw: 6 - totalKw }),
  devices: [],
});

const CHANGES: StatusPlanChanges = {
  actionChanged: false,
  actionSignature: 'sig',
  detailSignature: 'sig',
  metaSignature: 'sig',
};

type Harness = {
  writer: PlanStatusWriter;
  writeSpy: ReturnType<typeof vi.fn>;
  /**
   * Stands in for the whole status computation: `getLastPowerUpdate` is read
   * inside `compute` and nowhere else, so "was the status built?" is observable
   * as "was this called?".
   */
  computeSpy: ReturnType<typeof vi.fn>;
  /** Every `price_level_changed` fire, in order. */
  fired: TriggerRecord[];
  setDryRun: (value: boolean | undefined) => void;
  setLastPowerUpdate: (value: number | null) => void;
  setPriceLevel: (value: PriceLevel) => void;
};

const makeWriter = (initialDryRun: boolean | undefined, mainHome: boolean): Harness => {
  let dryRun = initialDryRun;
  let lastPowerUpdate = 1_745_000_000_000;
  let priceLevel = PriceLevel.UNKNOWN;
  const writeSpy = vi.fn();
  const fired: TriggerRecord[] = [];
  const computeSpy = vi.fn(() => lastPowerUpdate);
  const writer = new PlanStatusWriter({
    homey: { flow: recordingFlow(fired) },
    writePelsStatus: writeSpy,
    getCurrentHourPriceLevel: () => priceLevel,
    getLastPowerUpdate: computeSpy,
    // The main home wires no getEffectiveDryRun; sub-homes supply one.
    getEffectiveDryRun: mainHome ? undefined : () => dryRun as boolean,
  });
  return {
    writer,
    writeSpy,
    computeSpy,
    fired,
    setDryRun: (value) => { dryRun = value; },
    setLastPowerUpdate: (value) => { lastPowerUpdate = value ?? lastPowerUpdate; },
    setPriceLevel: (value) => { priceLevel = value; },
  };
};

describe('PlanStatusWriter posture-flip persist', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(BASE_MS);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('forces a persist when the effective dry-run flips inside the throttle window', () => {
    const h = makeWriter(true, false);

    nowSpy.mockReturnValue(BASE_MS);
    h.writer.update(plan(3), CHANGES); // initial persist
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    expect(h.writeSpy.mock.calls[0][0].dryRunEffective).toBe(true);

    // Effective posture flips true → false well within the throttle window and
    // with no action-signature change: the persist must NOT be throttled away.
    h.setDryRun(false);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(2);
    expect(h.writeSpy.mock.calls[1][0].dryRunEffective).toBe(false);
  });

  it('still throttles a non-posture volatile change inside the window (sub-home)', () => {
    const h = makeWriter(false, false);

    nowSpy.mockReturnValue(BASE_MS);
    h.writer.update(plan(3), CHANGES); // initial persist
    expect(h.writeSpy).toHaveBeenCalledTimes(1);

    // A volatile field changes (a fresh power-update bucket) but the posture is
    // unchanged: the existing throttle still suppresses the write.
    h.setLastPowerUpdate(1_000_000);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the main-home cadence untouched (posture-flip branch is inert)', () => {
    const h = makeWriter(undefined, true);

    nowSpy.mockReturnValue(BASE_MS);
    h.writer.update(plan(3), CHANGES); // initial persist
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    // The persisted main-home blob gains neither sub-home field (byte-identity):
    // both serialize away because the values are undefined.
    const persisted = JSON.parse(JSON.stringify(h.writeSpy.mock.calls[0][0]));
    expect(Object.prototype.hasOwnProperty.call(persisted, 'dryRunEffective')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(persisted, 'totalKw')).toBe(false);

    // A volatile change inside the window is throttled, exactly as before —
    // the undefined effective dry-run never trips the posture-flip force.
    h.setLastPowerUpdate(1_000_000);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(1);

    // Past the throttle window it writes again on the normal throttle cadence.
    nowSpy.mockReturnValue(BASE_MS + VOLATILE_WRITE_THROTTLE_MS + 6000);
    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- *
 * Skipping the computation a throttled cycle cannot use. Prod (13.5 h) built
 * the status 1501 times to produce 736 writes; the other 765 summarized the
 * plan and serialized the payload purely to be discarded.
 * -------------------------------------------------------------------------- */
describe('PlanStatusWriter dead-computation skip', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { nowSpy = vi.spyOn(Date, 'now').mockReturnValue(BASE_MS); });
  afterEach(() => { nowSpy.mockRestore(); });

  it('does not build the status on a throttled cycle that cannot write', () => {
    const h = makeWriter(undefined, true);

    h.writer.update(plan(3), CHANGES); // initial persist: must compute
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    const afterInitial = h.computeSpy.mock.calls.length;
    expect(afterInitial).toBeGreaterThan(0);

    // Inside the window, no action change, no posture flip: nothing this cycle
    // produces can reach a write, so the status must not be built at all.
    h.setLastPowerUpdate(1_000_000);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(4), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    expect(h.computeSpy).toHaveBeenCalledTimes(afterInitial);

    // Once the window lapses the write is live again, so the status is built.
    nowSpy.mockReturnValue(BASE_MS + VOLATILE_WRITE_THROTTLE_MS + 1000);
    h.writer.update(plan(4), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(2);
    expect(h.computeSpy.mock.calls.length).toBeGreaterThan(afterInitial);
  });

  it('still builds inside the window when the action signature changed', () => {
    const h = makeWriter(undefined, true);

    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    const afterInitial = h.computeSpy.mock.calls.length;

    // Asserts the COMPUTATION, not a write: with no devices the status blob is
    // identical for plan(3) and plan(4), so `resolveWriteReason`'s content-
    // identity check correctly suppresses the persist. What matters here is that
    // the fast path did not pre-empt that decision — an action-signature change
    // must always reach `resolveWriteReason` with a freshly built status.
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(4), { ...CHANGES, actionChanged: true });
    expect(h.computeSpy.mock.calls.length).toBeGreaterThan(afterInitial);
  });

  // The defect the skip introduced, and the reason the level is resolved BEFORE
  // the skip rather than read off the computed status. `power_source = flow`
  // drives rebuilds from Flow events, so there is no clock guaranteeing another
  // rebuild inside the hour: a level that changes on a skipped cycle and is not
  // fired there is not fired late, it is never fired. Here the whole cheap hour
  // begins and ends between two rebuilds an hour apart.
  it('fires price_level_changed on a cycle the dead-work skip throws away', () => {
    const h = makeWriter(undefined, true);

    h.writer.update(plan(3), CHANGES); // initial persist, level UNKNOWN
    expect(h.fired).toHaveLength(0);
    const afterInitial = h.computeSpy.mock.calls.length;

    // The hour turns cheap 5 s later — inside the throttle window, no action
    // change, no posture flip, so the status computation is (correctly) skipped.
    h.setPriceLevel(PriceLevel.CHEAP);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);

    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    expect(h.computeSpy.mock.calls.length).toBe(afterInitial);
    expect(h.fired).toEqual([{ tokens: { level: PriceLevel.CHEAP }, state: { priceLevel: PriceLevel.CHEAP } }]);
    expect(h.writer.getLastNotifiedPriceLevel()).toBe(PriceLevel.CHEAP);
  });

  it('does not re-fire price_level_changed while the level holds across skipped cycles', () => {
    const h = makeWriter(undefined, true);

    h.setPriceLevel(PriceLevel.EXPENSIVE);
    h.writer.update(plan(3), CHANGES);
    expect(h.fired).toHaveLength(1);

    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);
    nowSpy.mockReturnValue(BASE_MS + 20_000);
    h.writer.update(plan(3), CHANGES);

    expect(h.fired).toHaveLength(1);
  });

  it('still builds inside the window when the dry-run posture flips (sub-home)', () => {
    const h = makeWriter(true, false);

    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(1);
    const afterInitial = h.computeSpy.mock.calls.length;

    h.setDryRun(false);
    nowSpy.mockReturnValue(BASE_MS + 5000);
    h.writer.update(plan(3), CHANGES);
    expect(h.writeSpy).toHaveBeenCalledTimes(2);
    expect(h.computeSpy.mock.calls.length).toBeGreaterThan(afterInitial);
  });
});
