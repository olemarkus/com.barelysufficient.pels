import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { PriceLevel } from '../../lib/price/priceLevels';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';

/**
 * A temperature device with no power reading goes through the temperature logic
 * and not the power-limiting logic (owner ruling 2026-09-23).
 *
 * v3.7.0 planned such a device (a VThermo-style thermostat) for its mode target
 * and price shift. The metered-admission change dropped every device without a
 * reading from the plan, so a managed thermostat with no power meter silently
 * stopped following its mode. It is planned again, but without a power axis: it
 * is never a shed candidate, and it carries no `currentDrawKw` for a power sum
 * to read as a `0`.
 */
describe('temperature device without a power reading', () => {
  const MODE_TARGETS = { Home: { heater: 20, vthermo: 21 } };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T06:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const targetCapability = (value: number) => (
    [{ id: 'target_temperature', value, unit: '°C', min: 5, max: 30, step: 0.5 }]
  );

  type ShedBehavior = { action: 'turn_off' } | { action: 'set_temperature'; temperature: number };

  const buildBuilder = (shedBehavior: ShedBehavior = { action: 'turn_off' }): PlanBuilder => new PlanBuilder({
    leaveOffOnRelease: () => 'released',
    getInferredSurplusKw: () => 0,
    getCapacityDryRun: () => false,
    setCapacityInShortfall: vi.fn(),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: 6, marginKw: 0, periodMinutes: 60 }),
    resolveTemperatureSetpoints: fixtureTemperatureSetpoints({
      getModeDeviceTargets: () => MODE_TARGETS,
      getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
      getShedBehavior: () => shedBehavior,
    }),
    getPriceOptimizationSettings: () => ({}),
    getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: 5400 }),
    getDailyBudgetSnapshot: () => null,
    // Far under what the house draws: a real deficit, so the power-limiting
    // logic runs and chooses what to limit.
    getDynamicSoftLimitOverride: () => 1.84,
    getShedBehavior: () => shedBehavior,
    log: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  }, createPlanEngineState());

  const heaterFields = {
    id: 'heater',
    name: 'Heater',
    deviceType: 'temperature' as const,
    currentTemperature: 19,
    currentTarget: 20,
    targets: targetCapability(20),
    controllable: true,
  };
  const heater = (metered: boolean) => (metered
    ? buildPlanInputDevice({ ...heaterFields, currentDrawKw: 3 })
    : buildPlanInputDevice({ ...heaterFields, unmetered: true }));

  async function buildOverPacePlan(): Promise<DevicePlan> {
    return buildBuilder().buildDevicePlanSnapshot([
      heater(true),
      buildPlanInputDevice({
        id: 'vthermo',
        name: 'VThermo',
        deviceType: 'temperature',
        currentTemperature: 18,
        currentTarget: 18,
        targets: targetCapability(18),
        controllable: true,
        unmetered: true,
      }),
    ]);
  }

  it('plans its mode target', async () => {
    const plan = await buildOverPacePlan();

    const vthermo = plan.devices.find((device) => device.id === 'vthermo');
    expect(vthermo).toBeDefined();
    if (!vthermo || !isTemperaturePlanDevice(vthermo)) throw new Error('vthermo is not a temperature plan device');
    expect(vthermo.plannedTarget).toBe(21);
  });

  it('is never limited for power, while a metered device over the same deficit is', async () => {
    const plan = await buildOverPacePlan();

    expect(plan.devices.find((device) => device.id === 'heater')?.plannedState).toBe('shed');
    expect(plan.devices.find((device) => device.id === 'vthermo')?.plannedState).toBe('keep');
  });

  it('follows its temperature logic once it loses its reading while limited', async () => {
    // Limited to its floor setpoint while it had a reading, then the reading is
    // gone: holding at and resuming from the floor are power logic, so the
    // device is not held there. It gets its mode target, exactly as it would on
    // the first plan after a restart.
    const builder = buildBuilder({ action: 'set_temperature', temperature: 15 });
    const limited = await builder.buildDevicePlanSnapshot([heater(true)]);
    const limitedHeater = limited.devices.find((device) => device.id === 'heater');
    expect(limitedHeater?.plannedState).toBe('shed');
    if (!limitedHeater || !isTemperaturePlanDevice(limitedHeater)) throw new Error('heater is not a temperature plan device');
    expect(limitedHeater.plannedTarget).toBe(15);

    const next = await builder.buildDevicePlanSnapshot([heater(false)]);
    const unmetered = next.devices.find((device) => device.id === 'heater');
    expect(unmetered?.plannedState).toBe('keep');
    if (!unmetered || !isTemperaturePlanDevice(unmetered)) throw new Error('heater is not a temperature plan device');
    expect(unmetered.plannedTarget).toBe(20);
  });

  it('carries no power figure for a sum to read', async () => {
    const plan = await buildOverPacePlan();

    const vthermo = plan.devices.find((device) => device.id === 'vthermo');
    expect(vthermo).toBeDefined();
    expect(vthermo && 'currentDrawKw' in vthermo).toBe(false);
  });
});
