import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { NO_SHEDDING_OUTCOME } from '../../lib/plan/planState';
import { reportShortfallToGuard } from '../../lib/plan/shedding/shortfallVerdict';
import type { PlanSheddingResult } from '../../lib/plan/shedding/types';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildMeasuredPower, buildPlanContextFixture } from '../utils/planContextPowerFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';

const guardDouble = () => ({
  recordPlanVerdict: vi.fn().mockResolvedValue(undefined),
  recordReading: vi.fn().mockResolvedValue(undefined),
}) as unknown as CapacityGuard;

/** A selection that re-asserts an earlier shed of `deviceId` and decides nothing new. */
const heldSelection = (deviceId: string): PlanSheddingResult => ({
  shedSet: new Set([deviceId]),
  shedReasons: new Map(),
  shedStepTargets: new Map(),
  outcome: NO_SHEDDING_OUTCOME,
  overshootStats: null,
});

// Over the hard-cap threshold with the only managed device already limited: the
// verdict is "nothing left" either way. Whether it is also "out of options"
// turns on whether that limit has landed.
describe('reportShortfallToGuard', () => {
  it('reports shed relief in flight while the limit PELS sent is unconfirmed', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.heater = { dispatchState: 'accepted', desired: false, startedMs: Date.now() - 5_000 };
    const capacityGuard = guardDouble();

    await reportShortfallToGuard(
      buildPlanContextFixture({
        devices: [buildPlanInputDevice({ id: 'heater', currentDrawKw: 2, binaryControl: { on: true }, controllable: true })],
      }),
      buildMeasuredPower({ drawKw: 7, headroomKw: -2, capacityBreached: true }),
      state,
      heldSelection('heater'),
      {
        capacityGuard,
        shortfallThresholdKw: 5,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        getShedBehavior: () => ({ action: 'turn_off' }),
        log: vi.fn(),
      },
    );

    expect(capacityGuard.recordPlanVerdict).toHaveBeenCalledWith(7, 5, expect.objectContaining({
      remainingActionableControlledLoad: false,
      shedReliefInFlight: true,
    }));
  });

  it('reports none in flight once the limit has landed', async () => {
    const state = createPlanEngineState();
    const capacityGuard = guardDouble();

    await reportShortfallToGuard(
      buildPlanContextFixture({
        devices: [buildPlanInputDevice({ id: 'heater', currentDrawKw: 0, binaryControl: { on: false }, controllable: true })],
      }),
      buildMeasuredPower({ drawKw: 7, headroomKw: -2, capacityBreached: true }),
      state,
      heldSelection('heater'),
      {
        capacityGuard,
        shortfallThresholdKw: 5,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        getShedBehavior: () => ({ action: 'turn_off' }),
        log: vi.fn(),
      },
    );

    expect(capacityGuard.recordPlanVerdict).toHaveBeenCalledWith(7, 5, expect.objectContaining({
      remainingActionableControlledLoad: false,
      shedReliefInFlight: false,
    }));
  });
});
