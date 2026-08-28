import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import type { DevicePlan, PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureCurrentDrawKw, fixtureResidualKw, resolveFixtureCurrentOn } from '../utils/planTestUtils';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => {
  const merged = {
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    controllable: true,
    binaryCapabilityId: 'onoff' as const,
    ...overrides,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentDrawKw: fixtureCurrentDrawKw(merged),
    residualKw: merged.residualKw ?? fixtureResidualKw(merged),
    currentOn: resolveFixtureCurrentOn(merged),
  }) as PlanInputDevice;
};

/**
 * Regression cover for the 2026-08-16 restore-all (`TODO.md`).
 *
 * The shed grace defers a shed while a restore PELS issued may still be ramping.
 * It was wired so that deferring the shed also left the shedding-active latch
 * off — and the latch is what every restore-side lane consults to hold a device
 * that is already limited. While headroom is negative both reason ladders stand
 * down (`resolveOffDeviceReason`, `resolveCapacityRestoreBlockReason` return the
 * caller's own reason / null on `activeOvershoot`), so with the latch off and an
 * empty shed set NOTHING marked the off devices: they materialized as `keep` and
 * the executor turned every one of them back on, straight into a hard-cap
 * crossing.
 *
 * The shape below is the production one at 04:42:37Z: a charger restored ~30 s
 * ago (open activation attempt, inside the restore cooldown), five thermostats
 * held off from an earlier shed, and the house 3.5 kW past its pace.
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
   * One graced rebuild: the charger was restored 30 s ago, so its activation
   * attempt is open (the grace engages) and the global restore cooldown is still
   * running; the thermostat is off from an earlier shed; the house sits 3.5 kW
   * past its pace.
   */
  async function buildGracedPlan(): Promise<DevicePlan> {
    const state = createPlanEngineState();
    recordActivationAttemptStart({
      state,
      deviceId: 'charger',
      source: 'pels_restore',
      nowTs: Date.now() - 30_000,
    });
    state.lastRestoreMs = Date.now() - 30_000;

    return buildBuilder(state).buildDevicePlanSnapshot([
      buildDevice({ id: 'charger', name: 'Charger', currentDrawKw: 5.2, binaryControl: { on: true } }),
      buildDevice({ id: 'thermostat', name: 'Thermostat', currentDrawKw: 0, binaryControl: { on: false } }),
    ]);
  }

  function buildBuilder(state: ReturnType<typeof createPlanEngineState>): PlanBuilder {
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    return new PlanBuilder({
      getCapacityDryRun: () => false,
      setCapacityInShortfall: vi.fn(),
      capacityGuard,
      getCapacitySettings: () => ({ limitKw: 6, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 5.4 * 1000 }),
      getDailyBudgetSnapshot: () => null,
      // The binding pace, well under the 6 kW hard cap — the deficit is real and
      // far above the soft-overshoot deadband.
      getDynamicSoftLimitOverride: () => 1.84,
      getShedBehavior: () => ({ action: 'turn_off' }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
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
