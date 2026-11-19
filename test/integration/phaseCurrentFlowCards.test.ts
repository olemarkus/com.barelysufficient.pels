import { registerPhaseCurrentCards } from '../../flowCards/phaseCurrentCards';
import type { PhaseMeter } from '../../lib/power/mainFusePhaseSource';
import { PhaseReadingTracker } from '../../lib/power/phaseReading';
import type { PhaseTriple } from '../../lib/ports/homeMeterReadings';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const ABOVE = 'phase_current_went_above';
const BACK_BELOW = 'phase_current_went_back_below';
const CONDITION = 'phase_current_above';
const METER: PhaseMeter = { powerSource: 'homey_energy', meterDeviceId: 'meter-main', capabilities: null };

const LIMIT = { phase: 'L1', direction: 'import', amps: 16 };
const WATCH = { ...LIMIT, seconds: 20 };
const ANY_PHASE = { ...WATCH, phase: 'any' };

const { flow } = mockHomeyInstance;
const waitForRefresh = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(above: unknown[], backBelow: unknown[]) {
  flow._triggerCardArgumentValues = { [ABOVE]: above, [BACK_BELOW]: backBelow };
  const tracker = new PhaseReadingTracker();
  let meter = METER;
  let nowMs = 0;
  registerPhaseCurrentCards(flow, tracker, () => meter, () => new Date(nowMs), testLogger);
  return {
    tracker,
    switchMeter(next: PhaseMeter) { meter = next; },
    advanceTo(atMs: number) { nowMs = atMs; },
    sample(atMs: number, current: PhaseTriple) {
      nowMs = atMs;
      const [a, b, c] = current;
      tracker.admit(meter, { state: 'read', capabilityIds: [], powerW: [a * 230, b * 230, c * 230], currentA: current },
        (a + b + c) * 230, atMs);
    },
  };
}

beforeEach(() => resetMockHomey());

describe('phase current Flow cards', () => {
  it('raises for Any phase across a handoff and clears when every phase is below the clear level', async () => {
    const { sample } = setup([ANY_PHASE, ANY_PHASE], [ANY_PHASE]);
    await waitForRefresh();

    sample(0, [17, 0, 0]);
    sample(10_000, [15, 18, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toBeUndefined();
    sample(20_000, [15, 18, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    const [rise] = flow._triggerCardTriggers[ABOVE];
    expect(rise.tokens).toEqual({
      phase: 'L2', current_a: 18, power_kw: 4.14, direction: 'import', duration_seconds: 20,
    });
    await expect(flow._triggerCardRunListeners[ABOVE](ANY_PHASE, rise.state)).resolves.toBe(true);
    await expect(flow._triggerCardRunListeners[ABOVE](WATCH, rise.state)).resolves.toBe(false);
    await expect(flow._triggerCardRunListeners[ABOVE]({ ...ANY_PHASE, seconds: 10 }, rise.state)).resolves.toBe(false);

    sample(30_000, [17, 15, 0]);
    sample(40_000, [16, 15, 0]);
    sample(50_000, [17, 15, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    expect(flow._triggerCardTriggers[BACK_BELOW]).toBeUndefined();
    sample(60_000, [15, 0, 0]);
    expect(flow._triggerCardTriggers[BACK_BELOW]).toHaveLength(1);
    expect(flow._triggerCardTriggers[BACK_BELOW][0].tokens).toMatchObject({
      phase: 'L1', current_a: 15, duration_seconds: 60,
    });
  });

  it('runs a recovery-only Flow and preserves a qualified episode across gaps', async () => {
    const exportWatch = { ...WATCH, direction: 'export', seconds: 0 };
    const { sample, tracker } = setup([], [exportWatch]);
    await waitForRefresh();
    sample(0, [-18, 0, 0]);
    tracker.admit(METER, { state: 'none', capabilityIds: [] }, 0, 10_000);
    await expect(flow._conditionCardListeners[CONDITION](exportWatch)).rejects.toThrow(/fresh phase meter reading/u);
    sample(30_000, [-19, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toBeUndefined();
    sample(100_000, [5, 0, 0]);
    expect(flow._triggerCardTriggers[BACK_BELOW][0].tokens).toEqual({
      phase: 'L1', current_a: 0, power_kw: 1.15, direction: 'export', duration_seconds: 100,
    });
  });

  it('keeps an unqualified hold through a rejected sample but restarts it after a gap', async () => {
    const { sample, tracker } = setup([WATCH], []);
    await waitForRefresh();
    sample(0, [18, 0, 0]);
    tracker.admit(METER, { state: 'unavailable' }, 0, 10_000);
    sample(20_000, [18, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    sample(30_000, [14, 0, 0]);
    sample(40_000, [18, 0, 0]);
    sample(110_000, [18, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    sample(130_000, [18, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(2);
  });

  it('uses measured current with a signed phase and refuses stale, remapped or unsigned sets', async () => {
    const { tracker, advanceTo, switchMeter } = setup([], []);
    const run = flow._conditionCardListeners[CONDITION];
    tracker.admit(METER, { state: 'read', capabilityIds: [], powerW: [-500, 0, 0], currentA: [-18, 0, 0] }, -500, 0);
    await expect(run({ ...ANY_PHASE, direction: 'export' })).resolves.toBe(true);
    await expect(run(LIMIT)).resolves.toBe(false);
    advanceTo(60_001);
    await expect(run(LIMIT)).rejects.toThrow(/fresh phase meter reading/u);

    advanceTo(0);
    const remapped: PhaseMeter = { ...METER, capabilities: {
      facet: 'power', L1: 'measure_power.l2', L2: 'measure_power.l1', L3: 'measure_power.l3',
    } };
    switchMeter(remapped);
    await expect(run(LIMIT)).rejects.toThrow(/fresh phase meter reading/u);
    tracker.admit(remapped, { state: 'read', capabilityIds: [], currentA: [20, 0, 0] }, 1000, 0);
    await expect(run(LIMIT)).rejects.toThrow(/fresh phase meter reading/u);
  });

  it('discards late old-source reads and resets qualified crossings for a replacement meter', async () => {
    const immediate = { ...WATCH, seconds: 0 };
    const { tracker, sample, switchMeter } = setup([immediate], [immediate]);
    await waitForRefresh();
    sample(0, [18, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    const replacement = { ...METER, meterDeviceId: 'replacement' };
    switchMeter(replacement);
    tracker.admitCurrent(
      METER, replacement, { state: 'read', capabilityIds: [], powerW: [0, 0, 0] }, 0, 10_000, 10_000,
    );
    expect(tracker.current()).toEqual({ kind: 'none' });
    sample(20_000, [0, 0, 0]);
    expect(flow._triggerCardTriggers[BACK_BELOW]).toBeUndefined();
    sample(30_000, [18, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(2);
  });

  it('uses apparent phase power for the tracker without offering a direction to Flows', async () => {
    const { tracker } = setup([{ ...WATCH, seconds: 0 }], []);
    await waitForRefresh();
    tracker.admit(METER, { state: 'read', capabilityIds: [], apparentPowerVA: [4600, 0, 0] }, 4600, 0);
    expect(tracker.current()).toMatchObject({ kind: 'healthy', basis: 'apparent_power' });
    expect(flow._triggerCardTriggers[ABOVE]).toBeUndefined();
    await expect(flow._conditionCardListeners[CONDITION](LIMIT)).rejects.toThrow(/fresh phase meter reading/u);
  });

  it('keeps a rule when nothing changed and discards an older refresh response', async () => {
    const immediate = { ...WATCH, seconds: 0 };
    const { sample } = setup([immediate], []);
    await waitForRefresh();
    sample(0, [18, 0, 0]);
    let finishOlderRead = () => {};
    flow._triggerCardArgumentValues[ABOVE] = new Promise<unknown[]>((resolve) => {
      finishOlderRead = () => resolve([]);
    });
    flow._triggerCardUpdateListeners[ABOVE]();
    flow._triggerCardArgumentValues[ABOVE] = [immediate, { ...WATCH, phase: 'L4' }];
    flow._triggerCardUpdateListeners[ABOVE]();
    await waitForRefresh();
    finishOlderRead();
    await waitForRefresh();

    sample(10_000, [19, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(1);
    sample(20_000, [14, 0, 0]);
    sample(30_000, [19, 0, 0]);
    expect(flow._triggerCardTriggers[ABOVE]).toHaveLength(2);
  });

  it('registers the condition when a phase tracker is unavailable', async () => {
    registerPhaseCurrentCards(flow, undefined, () => METER, () => new Date(0), testLogger);
    await expect(flow._conditionCardListeners[CONDITION](LIMIT)).rejects.toThrow(/fresh phase meter reading/u);
  });
});
