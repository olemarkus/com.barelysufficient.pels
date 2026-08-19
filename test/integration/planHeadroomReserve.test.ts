import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { HEADROOM_RESERVE_MAX_MS } from '../../lib/plan/planConstants';
import {
  type BinaryControlDiscriminantProbe,
  type PlanInputDevice,
  type TemperatureDiscriminantProbe,
  withBinaryDiscriminant,
  type ShedBehavior,
} from '../../lib/plan/planTypes';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { resolveFixtureCurrentOn } from '../utils/planTestUtils';
import { fixtureResidualKw } from '../helpers/buildPlanInputDevice';

// Drives the REAL PlanBuilder to prove the startup reservation: a device flagged
// `reservesStartupPower` holds its lowest-active-step power back from LOWER-PRIORITY devices'
// admission, without shedding anyone. The headline case is the 2026-07-31 production incident,
// where the lane this replaced turned off ten devices that were already drawing nothing.

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildInputDevice = (
  loose: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & TemperatureDiscriminantProbe
    & { id: string; name: string },
): PlanInputDevice => {
  const merged = {
    available: true,
    targets: [] as PlanInputDevice['targets'],
    binaryCapabilityId: 'onoff' as const,
    binaryControl: { on: true },
    controllable: true,
    managed: true,
    commandableNow: true,
    ...loose,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentOn: resolveFixtureCurrentOn(merged),
    residualKw: merged.residualKw ?? fixtureResidualKw(merged),
  }) as PlanInputDevice;
};

const makeBuilder = (params: {
  limitKw: number;
  totalKw: number;
  priorities?: Record<string, number>;
  softLimitKw?: number;
  shedBehaviors?: Record<string, ShedBehavior>;
}): {
  builder: PlanBuilder;
  reportTotalPower: (kw: number) => void;
  setSoftLimitKw: (kw: number) => void;
} => {
  const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
  // The tracker is the single power latch, so the builder's whole-home total is
  // driven by writing the sample here rather than reporting it to the guard.
  let lastPowerW = params.totalKw * 1000;
  // The dynamic soft limit is what the daily-budget lane already moves at runtime, so driving it
  // here is the honest way to put the home under pressure and then take it away again — the
  // capacity guard's own hour-average projection is not steerable from a single power report.
  let softLimitKw = params.softLimitKw ?? null;
  const builder = new PlanBuilder({
    capacityGuard: capacityGuard,
    setCapacityInShortfall: vi.fn(),
    getCapacitySettings: () => ({ limitKw: params.limitKw, marginKw: 0.2 }),
    getOperatingMode: () => 'Home',
    getModeDeviceTargets: () => ({}),
    getPriceOptimizationEnabled: () => false,
    getPriceOptimizationSettings: () => ({}),
    getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
    getPowerTracker: () => ({ buckets: {}, lastTimestamp: Date.now(), lastPowerW }),
    getDailyBudgetSnapshot: () => null,
    // heater is priority 1 (top); everything else lower (higher number sheds first).
    getPriorityForDevice: (deviceId: string) => params.priorities?.[deviceId] ?? (deviceId === 'heater' ? 1 : 10),
    getShedBehavior: (deviceId: string) => params.shedBehaviors?.[deviceId]
      ?? { action: 'turn_off' },
    getDynamicSoftLimitOverride: () => softLimitKw,
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: emptyPendingStore,
  }, createPlanEngineState());
  return {
    builder,
    reportTotalPower: (kw: number) => { lastPowerW = kw * 1000; },
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

  type DeviceOverride = Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & TemperatureDiscriminantProbe;

  // Off and waiting to start — the only state a reservation exists for. A device whose binary
  // control is confirmed ON has started, so it never reserves (see the duty-cycle regression in
  // test/unit/headroomReserve.test.ts).
  const reservingHeater = (over?: DeviceOverride) => buildInputDevice({
    id: 'heater',
    name: 'Connected 300',
    reservesStartupPower: true,
    binaryControl: { on: false },
    currentDrawKw: 0,
    expectedPowerKw: 1.19,
    ...over,
  });

  const lowerPriorityThermostat = (over?: DeviceOverride) => buildInputDevice({
    id: 'thermostat',
    name: 'Termostat',
    currentDrawKw: 0.6,
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
      lowerPriorityThermostat({ binaryControl: { on: false }, currentDrawKw: 0 }),
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
        currentDrawKw: 0,
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
    // `targetName` names the holder for the device-detail page and the logs; the
    // shortfall is what the CARD renders (what this device needs), resolved from
    // the post-reserve admission rather than the raw figure the decision used.
    expect(deviceOf(plan, 'thermostat')?.reason).toEqual({
      code: PLAN_REASON_CODES.reservedForStart,
      targetName: 'Connected 300',
    });
  });

  it('lets the device resume once the reserving device has started', async () => {
    // Same freed power, same priorities — the only difference is that the heater is now drawing,
    // so its reservation is satisfied and released.
    const { builder, settled } = await shedThenEase({
      heater: reservingHeater({ binaryControl: { on: true }, currentDrawKw: 1.19 }),
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

  // The hold-lane twin of the resume cases above. A thermostat shed by LOWERING ITS SETPOINT
  // stays observed-on, so it never enters the binary/stepped resume lanes — its raise goes
  // through `resolveRestoreDecision` in the shed-temperature hold lane. That lane was the one
  // restore path that ignored startup reservations: the raise took the promised block, so the
  // permission silently stopped working against exactly the cycling-load class the reservation
  // note was written for.
  describe('setpoint-shed (hold lane) admission', () => {
    const SHED_FLOOR_C = 12;
    const setpointBehaviors = {
      thermostat: { action: 'set_temperature' as const, temperature: SHED_FLOOR_C },
    };

    const setpointThermostat = (over?: DeviceOverride) => buildInputDevice({
      id: 'thermostat',
      name: 'Termostat',
      // `deviceType` is what routes the resume through the shed-temperature hold
      // lane (`isTemperaturePlanDevice`); without it the hold lane skips the
      // device and the case would pass vacuously against the binary lane.
      deviceType: 'temperature',
      binaryControl: { on: true },
      currentTarget: 21,
      targets: [{ id: 'target_temperature', value: 21, unit: 'C' }],
      currentDrawKw: 0.6,
      expectedPowerKw: 0.6,
      ...over,
    });

    // Same honest route as `shedThenEase`: pressure sheds the thermostat to its floor, the
    // setpoint is then observed AT the floor with the device idling at 0 W but still on
    // (or, for the unconfirmed-shed case, still reporting its normal target and drawing),
    // pressure eases, and the question becomes whether the raise may take the freed power.
    const shedThenEaseSetpoint = async (params: { heater: PlanInputDevice; settledTargetC?: number }) => {
      const settledTargetC = params.settledTargetC ?? SHED_FLOOR_C;
      const harness = makeBuilder({
        limitKw: 10, totalKw: 3.0, softLimitKw: 2.6, shedBehaviors: setpointBehaviors,
      });
      const pressured = await harness.builder.buildDevicePlanSnapshot([params.heater, setpointThermostat()]);
      // Premise checks: the shed happened, and it was a setpoint shed, not a turn-off.
      expect(stateOf(pressured, 'thermostat')).toBe('shed');
      expect(deviceOf(pressured, 'thermostat')?.shedAction).toBe('set_temperature');

      harness.setSoftLimitKw(4.6);
      vi.advanceTimersByTime(2 * 60_000);
      const settled = [
        params.heater,
        setpointThermostat({
          currentTarget: settledTargetC,
          targets: [{ id: 'target_temperature', value: settledTargetC, unit: 'C' }],
          currentDrawKw: settledTargetC === SHED_FLOOR_C ? 0 : 0.6,
        }),
      ];
      await harness.builder.buildDevicePlanSnapshot(settled);
      vi.advanceTimersByTime(90_000);
      return { builder: harness.builder, settled };
    };

    it('keeps a setpoint-shed device from raising into the reserved block, and says why', async () => {
      const { builder, settled } = await shedThenEaseSetpoint({ heater: reservingHeater() });
      const plan = await builder.buildDevicePlanSnapshot(settled);

      expect(stateOf(plan, 'thermostat')).toBe('shed');
      expect(deviceOf(plan, 'thermostat')?.reason).toEqual({
        code: PLAN_REASON_CODES.reservedForStart,
        targetName: 'Connected 300',
      });
    });

    it('keeps asserting the floor while the shed has not materialized', async () => {
      // The thermostat was commanded to the floor but still reports its normal
      // target. The reserve must NOT swap in the no-actuation reservedForStart
      // hold yet — that reason builds no intent, so the pending floor command
      // would stop being retried while the device keeps drawing inside the
      // reserved block. The hold must carry an actuating shed reason instead.
      const { builder, settled } = await shedThenEaseSetpoint({
        heater: reservingHeater(),
        settledTargetC: 21,
      });
      const plan = await builder.buildDevicePlanSnapshot(settled);

      expect(stateOf(plan, 'thermostat')).toBe('shed');
      expect(deviceOf(plan, 'thermostat')?.shedTemperature).toBe(SHED_FLOOR_C);
      expect(deviceOf(plan, 'thermostat')?.reason?.code).not.toBe(PLAN_REASON_CODES.reservedForStart);
    });

    it('lets the setpoint raise through once the reserving device has started', async () => {
      const { builder, settled } = await shedThenEaseSetpoint({
        heater: reservingHeater({ binaryControl: { on: true }, currentDrawKw: 1.19 }),
      });
      const plan = await builder.buildDevicePlanSnapshot(settled);

      expect(deviceOf(plan, 'thermostat')?.reason?.code).not.toBe(PLAN_REASON_CODES.reservedForStart);
      // Positive assertion: the raise actually goes through, so the hold lane's reserve check
      // cannot over-block once the reservation is satisfied and released.
      expect(stateOf(plan, 'thermostat')).toBe('keep');
    });
  });
});
