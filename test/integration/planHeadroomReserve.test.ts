import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { HEADROOM_RESERVE_MAX_MS } from '../../lib/plan/planConstants';
import {
  type BinaryControlDiscriminantProbe,
  type PlanInputDevice,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { resolveFixtureCurrentOn } from '../utils/planTestUtils';

// Drives the REAL PlanBuilder to prove the startup reservation: a device flagged
// `reservesStartupPower` holds its lowest-active-step power back from LOWER-PRIORITY devices'
// admission, without shedding anyone. The headline case is the 2026-07-31 production incident,
// where the lane this replaced turned off ten devices that were already drawing nothing.

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildInputDevice = (
  loose: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & { id: string; name: string },
): PlanInputDevice => {
  const merged = {
    targets: [] as PlanInputDevice['targets'],
    controlCapabilityId: 'onoff' as const,
    binaryControl: { on: true },
    controllable: true,
    managed: true,
    commandableNow: true,
    ...loose,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentOn: resolveFixtureCurrentOn(merged),
  }) as PlanInputDevice;
};

const makeBuilder = (params: {
  limitKw: number;
  totalKw: number;
  priorities?: Record<string, number>;
  softLimitKw?: number;
}): {
  builder: PlanBuilder;
  reportTotalPower: (kw: number) => void;
  setSoftLimitKw: (kw: number) => void;
} => {
  const capacityGuard = new CapacityGuard({ homeId: 'main', limitKw: params.limitKw, softMarginKw: 0.2 });
  capacityGuard.reportTotalPower(params.totalKw);
  // The dynamic soft limit is what the daily-budget lane already moves at runtime, so driving it
  // here is the honest way to put the home under pressure and then take it away again — the
  // capacity guard's own hour-average projection is not steerable from a single power report.
  let softLimitKw = params.softLimitKw ?? null;
  const builder = new PlanBuilder({
    setCapacityInShortfall: vi.fn(),
    getCapacityGuard: () => capacityGuard,
    getCapacitySettings: () => ({ limitKw: params.limitKw, marginKw: 0.2 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => false,
    getPriceOptimizationSettings: () => ({}),
    isCurrentHourCheap: () => false,
    isCurrentHourExpensive: () => false,
    getPowerTracker: () => ({ buckets: {}, lastTimestamp: Date.now() }),
    getDailyBudgetSnapshot: () => null,
    // heater is priority 1 (top); everything else lower (higher number sheds first).
    getPriorityForDevice: (deviceId: string) => params.priorities?.[deviceId] ?? (deviceId === 'heater' ? 1 : 10),
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    getDynamicSoftLimitOverride: () => softLimitKw,
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: emptyPendingStore,
  }, createPlanEngineState());
  return {
    builder,
    reportTotalPower: (kw: number) => capacityGuard.reportTotalPower(kw),
    setSoftLimitKw: (kw: number) => { softLimitKw = kw; },
  };
};

type Plan = Awaited<ReturnType<PlanBuilder['buildDevicePlanSnapshot']>>;
const deviceOf = (plan: Plan, id: string) => plan.devices.find((device) => device.id === id);
const stateOf = (plan: Plan, id: string): string | undefined => deviceOf(plan, id)?.plannedState;

describe('PlanBuilder startup power reservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T10:30:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  type DeviceOverride = Partial<PlanInputDevice> & BinaryControlDiscriminantProbe;

  // Off and waiting to start — the only state a reservation exists for. A device whose binary
  // control is confirmed ON has started, so it never reserves (see the duty-cycle regression in
  // test/unit/headroomReserve.test.ts).
  const reservingHeater = (over?: DeviceOverride) => buildInputDevice({
    id: 'heater',
    name: 'Connected 300',
    reservesStartupPower: true,
    binaryControl: { on: false },
    measuredPowerKw: 0,
    expectedPowerKw: 1.19,
    ...over,
  });

  const lowerPriorityThermostat = (over?: DeviceOverride) => buildInputDevice({
    id: 'thermostat',
    name: 'Termostat',
    measuredPowerKw: 0.6,
    expectedPowerKw: 0.6,
    ...over,
  });

  // A device PELS never turned off is not in the resume lane at all, so every case that exercises
  // the reservation has to get there honestly: capacity pressure sheds the thermostat, the device
  // is then observed off, pressure eases, and the question becomes whether it may resume into the
  // freed power. Returns the settled snapshot for the caller to plan against.
  const shedThenEase = async (params: {
    heater: PlanInputDevice;
    priorities?: Record<string, number>;
  }) => {
    // 3.0 kW drawn against a 2.6 kW soft limit: over by 0.4, so the 0.6 kW thermostat is shed.
    const harness = makeBuilder({
      limitKw: 10, totalKw: 3.0, softLimitKw: 2.6, priorities: params.priorities,
    });
    const pressured = await harness.builder.buildDevicePlanSnapshot([params.heater, lowerPriorityThermostat()]);
    // Premise check: without this shed the later assertions would pass vacuously.
    expect(stateOf(pressured, 'thermostat')).toBe('shed');

    // Pressure eases: the soft limit lifts to 4.6 kW, leaving 1.6 kW available — enough to resume
    // the 0.6 kW thermostat on its own, not once a 1.19 kW startup block is set aside for the heater.
    harness.setSoftLimitKw(4.6);
    vi.advanceTimersByTime(2 * 60_000);
    const settled = [
      params.heater,
      lowerPriorityThermostat({ binaryControl: { on: false }, measuredPowerKw: 0 }),
    ];
    // Recovering re-arms the 60 s shed cooldown (`getShedCooldownState` restarts it from
    // `lastRecoveryMs`), so burn one build on the recovery and let that clock run out — otherwise
    // every case would just read back "waiting before resuming" and never reach admission.
    await harness.builder.buildDevicePlanSnapshot(settled);
    vi.advanceTimersByTime(90_000);
    return { builder: harness.builder, settled };
  };

  it('regression (2026-07-31 22:04): does not touch idle devices that are already drawing nothing', async () => {
    // The incident: 2.48 kW of available power, a smart task holding the permission, and ten
    // controlled devices reporting zero draw. The old proactive-shed lane marked twelve devices
    // limited and issued ten writes for zero relief. A reservation must issue none of that: it
    // reserves power, it does not turn anything off.
    const devices: PlanInputDevice[] = [
      reservingHeater(),
      ...Array.from({ length: 10 }, (_, index) => buildInputDevice({
        id: `thermostat-${index}`,
        name: `Termostat ${index}`,
        measuredPowerKw: 0,
        expectedPowerKw: 0.6,
      })),
    ];
    // soft limit 5.0 (5.2 - 0.2 margin) against 2.52 kW drawn = the incident's 2.48 kW available.
    const { builder } = makeBuilder({ limitKw: 5.2, totalKw: 2.52 });
    const plan = await builder.buildDevicePlanSnapshot(devices);

    const shed = plan.devices.filter((device) => device.plannedState === 'shed');
    expect(shed.map((device) => device.id)).toEqual([]);
  });

  it('does not shed a lower-priority device that IS drawing — a reservation never turns anything off', async () => {
    const devices = [reservingHeater(), lowerPriorityThermostat()];
    const { builder } = makeBuilder({ limitKw: 10, totalKw: 0.8 }); // 9.0 kW available: no pressure
    const plan = await builder.buildDevicePlanSnapshot(devices);
    expect(stateOf(plan, 'thermostat')).toBe('keep');
    expect(stateOf(plan, 'heater')).not.toBe('shed');
  });

  it('keeps a shed lower-priority device from resuming into the reserved block, and says why', async () => {
    const { builder, settled } = await shedThenEase({ heater: reservingHeater() });
    const plan = await builder.buildDevicePlanSnapshot(settled);

    expect(stateOf(plan, 'thermostat')).toBe('shed');
    expect(deviceOf(plan, 'thermostat')?.reason).toEqual({
      code: PLAN_REASON_CODES.reservedForStart,
      targetName: 'Connected 300',
    });
  });

  it('lets the device resume once the reserving device has started', async () => {
    // Same freed power, same priorities — the only difference is that the heater is now drawing,
    // so its reservation is satisfied and released.
    const { builder, settled } = await shedThenEase({
      heater: reservingHeater({ binaryControl: { on: true }, measuredPowerKw: 1.19 }),
    });
    const plan = await builder.buildDevicePlanSnapshot(settled);

    expect(deviceOf(plan, 'thermostat')?.reason?.code).not.toBe(PLAN_REASON_CODES.reservedForStart);
    // Positive assertion: the thermostat actually resumes. Without this the case would pass even
    // if it stayed shed for an unrelated reason — or if the whole lane were deleted.
    expect(stateOf(plan, 'thermostat')).toBe('keep');
  });

  it('never constrains a device MORE important than the one holding the reservation', async () => {
    const { builder, settled } = await shedThenEase({
      heater: reservingHeater(),
      priorities: { heater: 5, thermostat: 1 },
    });
    const plan = await builder.buildDevicePlanSnapshot(settled);

    expect(deviceOf(plan, 'thermostat')?.reason?.code).not.toBe(PLAN_REASON_CODES.reservedForStart);
    expect(stateOf(plan, 'thermostat')).toBe('keep');
  });

  it('lapses an unsatisfiable reservation so lower-priority devices are not held forever', async () => {
    // The priority-2 case: the reserving device is outranked by load it cannot displace, so its
    // block never assembles. After the bound the reservation stands down rather than holding a
    // lower-priority device off indefinitely for a start that is not coming.
    const { builder, settled } = await shedThenEase({ heater: reservingHeater() });
    expect(deviceOf(await builder.buildDevicePlanSnapshot(settled), 'thermostat')?.reason?.code)
      .toBe(PLAN_REASON_CODES.reservedForStart);

    vi.advanceTimersByTime(HEADROOM_RESERVE_MAX_MS + 1000);
    const lapsed = await builder.buildDevicePlanSnapshot(settled);
    expect(deviceOf(lapsed, 'thermostat')?.reason?.code).not.toBe(PLAN_REASON_CODES.reservedForStart);
    // Positive assertion: the device actually gets to resume once the reservation lapses.
    expect(stateOf(lapsed, 'thermostat')).toBe('keep');
  });
});
