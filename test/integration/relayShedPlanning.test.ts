import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { buildSheddingPlanForSpec } from '../helpers/sheddingPlanForSpec';
import { capacityGuardSpy, sheddingWiring } from '../helpers/sheddingWiring';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';

const start = 1_000_000;
const retry = start + 90_000;

const load = (id: string, priority: number, on = true) => buildPlanInputDevice({
  id, priority, currentDrawKw: 2, expectedPowerKw: 2, binaryControl: { on },
});
const failed = { ...load('relay', 3), relayShedNoAck: { decisionAtMs: start, retryAtMs: retry } };

function setup() {
  const state = createPlanEngineState(start);
  state.currentRebuildTrigger = 'hard_cap_breach';
  const guard = capacityGuardSpy();
  async function decide(atMs: number, devices: PlanInputDevice[], deficitKw = 2) {
    const total = 5 + deficitKw;
    const { context, power } = buildPlanCycle({
      devices, nowTs: atMs, sampledAtMs: atMs, total, softLimit: 5, headroom: -deficitKw,
      capacitySoftLimit: 5, softLimitSource: 'capacity',
    });
    const plan = await buildSheddingPlanForSpec(context, power, state, {
      ...sheddingWiring(state), capacityGuard: guard, shortfallThresholdKw: 5,
      powerTracker: { lastTimestamp: atMs, lastPowerW: total * 1000 },
    });
    state.applySheddingOutcome(plan.outcome, plan.recoveredAtMs);
    return plan;
  }
  return { guard, state, decide };
}

describe('meter-driven relay shed recovery', () => {
  it('withdraws only the matching failed credit and takes the next ranked load inside the pending window', async () => {
    const { state, decide } = setup();
    const backup = load('backup', 1);
    const other = load('other', 2);
    const first = await decide(start, [load('relay', 3), other, backup], 4);
    expect(first.relayShedDecisions?.get('relay')).toEqual({ shedDecisionAtMs: start });
    const second = await decide(start + 1000, [failed, other, backup], 4);
    expect(second.shedSet).toEqual(new Set(['relay', 'other', 'backup']));
    expect(second.relayShedDecisions?.get('relay')).toEqual({ relayNoAckPosture: true });
    expect(state.shedPlanLatch?.decisions.get('other')).toMatchObject([{ kind: 'electrical', decidedAtMs: start }]);
    expect(state.shedPlanLatch?.decisions.get('backup')).toMatchObject([{ kind: 'electrical', decidedAtMs: start + 1000 }]);
  });

  it('keeps the failed relay paced, reports exhausted options, and grants a zero-credit ordinary retry', async () => {
    const { guard, decide } = setup();
    await decide(start, [load('relay', 3)]);
    for (const time of [start + 1000, retry - 1, retry]) {
      const plan = await decide(time, [failed]);
      expect(plan.shedSet.has('relay')).toBe(true);
      expect(plan.relayShedDecisions?.get('relay')?.shedDecisionAtMs).toBe(time === retry ? retry : undefined);
      expect(guard.recordPlanVerdict).toHaveBeenLastCalledWith(7, 5, expect.objectContaining({
        remainingActionableControlledLoadW: 0, remainingReducibleControlledLoadW: 0, shedReliefInFlight: false,
      }));
    }
    const clear = await decide(retry + 1000, [failed], -1);
    expect(clear.shedSet.size).toBe(0);
  });

  it('spends the failed dispatch recheck only when a meter-triggered build has assessed it', async () => {
    const { state, guard, decide } = setup();
    await decide(start, [load('relay', 3)]);
    vi.mocked(guard.recordPlanVerdict).mockClear();
    state.noteRelayShedNoAck(start + 500);
    state.currentRebuildTrigger = 'settings';
    await decide(start + 1000, [failed]);
    expect(state.relayShedVerdictAfterMs).toBe(start + 500);
    state.currentRebuildTrigger = 'hard_cap_breach';
    for (const oldReading of [start, start - 1000, start + 100]) {
      await decide(oldReading, [failed]);
      expect(state.relayShedVerdictAfterMs).toBe(start + 500);
    }
    expect(guard.recordPlanVerdict).not.toHaveBeenCalled();
    await decide(start + 1000, [failed]);
    expect(state.relayShedVerdictAfterMs).toBeUndefined();
    expect(guard.recordPlanVerdict).toHaveBeenCalledExactlyOnceWith(7, 5, expect.objectContaining({
      remainingActionableControlledLoadW: 0, shedReliefInFlight: false,
    }));
  });

  it('sends an eligible ordinary retry alongside a healthy backup and credits only that backup', async () => {
    const { state, decide } = setup();
    await decide(start, [load('relay', 3)]);
    await decide(start + 1000, [failed]);
    const plan = await decide(retry, [failed, load('backup', 1)]);
    expect(plan.shedSet).toEqual(new Set(['relay', 'backup']));
    expect(plan.relayShedDecisions?.get('relay')).toEqual({ shedDecisionAtMs: retry });
    expect(state.shedPlanLatch?.decisions.get('relay')?.at(-1)?.creditedKw).toBe(0);
    expect(state.shedPlanLatch?.decisions.get('backup')?.at(-1)?.creditedKw).toBe(2);
  });

  it('grants same-value permission only on a new meter decision with residual pressure after alternatives', async () => {
    const { state, decide } = setup();
    const off = load('relay', 3, false);
    const covered = await decide(start, [off, load('backup', 1)]);
    expect(covered.relayShedDecisions?.has('relay')).toBe(false);
    const open = await decide(retry, [off]);
    expect(open.relayShedDecisions?.get('relay')).toEqual({ relayRecoveryMeterAtMs: retry });
    expect(open.shedSet.has('relay')).toBe(false);
    expect((await decide(retry, [off])).relayShedDecisions?.has('relay')).toBe(false);
    state.currentRebuildTrigger = 'settings';
    expect((await decide(retry + 1000, [off])).relayShedDecisions?.has('relay')).toBe(false);
    state.currentRebuildTrigger = 'hard_cap_breach';
    expect((await decide(retry + 1000, [off])).relayShedDecisions?.get('relay')).toEqual({
      relayRecoveryMeterAtMs: retry + 1000,
    });
  });
});
