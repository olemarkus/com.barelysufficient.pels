import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type {
  BinaryControlDiscriminantProbe, DevicePlan, MeteredDiscriminantProbe, MeteredPlanInputDevice, PlanInputDevice,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import {
  fixtureControlPosture, fixtureCurrentDrawKw, fixtureResidualKw, resolveFixtureCurrentOn,
} from '../utils/planTestUtils';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { withCapacityPace } from '../helpers/capacityPaceFixture';

const CAPACITY_SETTINGS = {
  capacityEnabled: true, gridImportLimitKw: null, limitKw: 6, marginKw: 0.2, periodMinutes: 60 as const,
};

const buildDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & MeteredDiscriminantProbe = {},
): MeteredPlanInputDevice => {
  const merged = {
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    control: fixtureControlPosture({ controllable: true }),
    available: true,
    binaryCapabilityId: 'onoff' as const,
    // Required: no charge target is the producer's answer for these loads.
    chargeTargetHold: { kind: 'none' } as const,
    ...overrides,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentDrawKw: fixtureCurrentDrawKw(merged),
    residualKw: merged.residualKw ?? fixtureResidualKw(merged),
    currentOn: resolveFixtureCurrentOn(merged),
  }) as MeteredPlanInputDevice;
};

/**
 * Regression cover for the 2026-08-16 restore-all.
 *
 * Funded shed grace defers a restriction while observed pressure may still clear.
 * It was wired so that deferring the shed also left the shedding-active latch
 * off — and the latch is what every restore-side lane consults to hold a device
 * that is already limited. While headroom is negative both reason ladders stand
 * down (`resolveOffDeviceReason`, `resolveCapacityRestoreBlockReason` return the
 * caller's own reason / null on `activeOvershoot`), so with the latch off and an
 * empty shed set NOTHING marked the off devices: they materialized as `keep` and
 * the executor turned every one of them back on, straight into a hard-cap
 * crossing.
 *
 * Retain the restore-cooldown and already-OFF device shape with a funded
 * 160 W deficit. The historical 3.5 kW deficit with no margin now correctly
 * receives no additional patience.
 */
describe('shed grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T04:42:37.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * One funded rebuild: observe the period boundary and a 10-second meter
   * interval, then pressure that leaves the protected response reserve intact.
   * A recent charger restore and an OFF thermostat retain the original hold
   * regression; activation attribution does not grant the patience.
   */
  async function buildGracedPlan(): Promise<DevicePlan> {
    const state = createPlanEngineState();
    const nowTs = Date.now();
    const periodStartMs = Math.floor(nowTs / 3_600_000) * 3_600_000;
    let powerW = 0;
    const builder = buildBuilder(state, () => powerW);
    for (const atMs of [periodStartMs - 20_000, periodStartMs - 10_000, periodStartMs, nowTs - 10_000]) {
      vi.setSystemTime(atMs);
      await builder.buildDevicePlanSnapshot([]);
    }
    vi.setSystemTime(nowTs);
    powerW = 2000;
    recordActivationAttemptStart(state, 'charger', Date.now() - 30_000);
    state.actuation.lastRestoreMs = Date.now() - 30_000;

    const plan = await builder.buildDevicePlanSnapshot([
      buildDevice({ id: 'charger', name: 'Charger', currentDrawKw: 1.8, binaryControl: { on: true } }),
      buildDevice({ id: 'thermostat', name: 'Thermostat', currentDrawKw: 0, binaryControl: { on: false } }),
    ]);
    expect(state.sheddingActive).toBe(true);
    return plan;
  }

  function buildBuilder(state: ReturnType<typeof createPlanEngineState>, getPowerW: () => number): PlanBuilder {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    return new PlanBuilder({
      ...planBuilderWiring(),
      capacityGuard,
      getCapacitySettings: () => CAPACITY_SETTINGS,
      getPowerTracker: () => withCapacityPace(
        { lastTimestamp: Date.now(), lastPowerW: getPowerW() }, CAPACITY_SETTINGS, 1.84,
      ),
    }, state);
  }

  it('holds a device that is already off instead of resuming it', async () => {
    const plan = await buildGracedPlan();

    const thermostat = plan.devices.find((device) => device.id === 'thermostat');
    expect(thermostat?.plannedState).toBe('shed');
  });

  it('still defers the new shed it was introduced to defer', async () => {
    const plan = await buildGracedPlan();

    const charger = plan.devices.find((device) => device.id === 'charger');
    expect(charger?.plannedState).toBe('keep');
  });
});
