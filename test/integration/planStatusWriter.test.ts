import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanStatusWriter } from '../../lib/plan/planStatusWriter';
import type { DevicePlan, StatusPlanChanges } from '../../lib/plan/planTypes';
import type { FlowPort, FlowToken, FlowTriggerCard } from '../../lib/ports/homeyRuntime';
import { buildPlanMeta } from '../utils/planTestUtils';

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

// getTriggerCard is never exercised here (price level stays UNKNOWN), so a bare
// typed stub is enough to satisfy the FlowPort contract.
const stubFlow = (): FlowPort => ({
  getTriggerCard: (): FlowTriggerCard => ({ trigger: () => Promise.resolve(undefined) }),
  createToken: (): Promise<FlowToken> => Promise.resolve({ setValue: () => Promise.resolve(undefined) }),
});

const plan = (totalKw: number): DevicePlan => ({
  meta: buildPlanMeta({ totalKw, softLimitKw: 6, headroomKw: 6 - totalKw, powerNowKw: totalKw}),
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
  setDryRun: (value: boolean | undefined) => void;
  setLastPowerUpdate: (value: number | null) => void;
};

const makeWriter = (initialDryRun: boolean | undefined, mainHome: boolean): Harness => {
  let dryRun = initialDryRun;
  let lastPowerUpdate: number | null = null;
  const writeSpy = vi.fn();
  const writer = new PlanStatusWriter({
    homey: { flow: stubFlow() },
    writePelsStatus: writeSpy,
    getCombinedPrices: () => null,
    getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
    getLastPowerUpdate: () => lastPowerUpdate,
    // The main home wires no getEffectiveDryRun; sub-homes supply one.
    getEffectiveDryRun: mainHome ? undefined : () => dryRun as boolean,
  });
  return {
    writer,
    writeSpy,
    setDryRun: (value) => { dryRun = value; },
    setLastPowerUpdate: (value) => { lastPowerUpdate = value; },
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
