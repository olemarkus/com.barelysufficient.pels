import { onTestFinished } from 'vitest';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { buildExecutionPlan } from '../../lib/plan/planExecutionProjection';
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import { configuredHardCap } from '../helpers/configuredHardCap';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { captureLogger } from '../utils/loggerCapture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';

describe('capacity timed-run logging', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('records a start only when an eligible heater passes restore admission', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 19, 12, 20);
    vi.setSystemTime(now);
    const log = captureLogger('debug', ['plan']);
    onTestFinished(log.restore);

    const heater = buildPlanInputDevice({
      id: 'heater', binaryControl: { on: false }, currentDrawKw: 0, expectedPowerKw: 0.8,
    });
    const settings = configuredHardCap(capacityOnlyPowerLimits(5, 0.3));
    const state = createPlanEngineState();
    state.shedDecisions.lastPlannedShedIds = new Set([heater.id]);
    state.restoreBackoff.noteInstability(now - 20_000);
    let powerW = 4280;
    const builder = new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => settings,
      getPowerTracker: () => withCapacityPace({ lastTimestamp: Date.now(), lastPowerW: powerW }, settings, 5.15),
    }, state);

    const build = async (seconds: number, watts: number) => {
      vi.setSystemTime(now + seconds * 1000);
      powerW = watts;
      const plan = await builder.buildDevicePlanSnapshot([heater]);
      return buildExecutionPlan(plan).devices[0]?.commands;
    };

    // The meter can make a timed start eligible again while the shed cooldown still holds it off.
    for (const [seconds, watts] of [[0, 4280], [10, 4500], [20, 4280], [30, 4280]] as const) {
      expect(await build(seconds, watts)).not.toMatchObject({ binary: { desiredOn: true } });
    }
    const held = expect.objectContaining({ deviceId: heater.id, plannedOn: false, reasonCode: 'cooldown_shedding' });
    expect(log.findEvents('capacity_timed_run_start_eligible')).toEqual([held, held]);
    expect(log.findEvents('capacity_timed_run_started')).toEqual([]);
    expect(log.findEvents('capacity_timed_run_ended')).toEqual([]);

    expect(await build(50, 4280)).toMatchObject({
      binary: { deviceId: heater.id, source: 'controlled', desiredOn: true },
    });
    expect(log.findEvents('capacity_timed_run_start_eligible')).toEqual([
      held, held, expect.objectContaining({ deviceId: heater.id, plannedOn: true }),
    ]);
    expect(log.findEvents('capacity_timed_run_started')).toEqual([
      expect.objectContaining({ deviceId: heater.id, kind: 'start' }),
    ]);
  });
});
