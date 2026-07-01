import CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  type BinaryControlDiscriminantProbe,
  type PlanInputDevice,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { resolveFixtureCurrentOn } from '../utils/planTestUtils';

// Drives the REAL PlanBuilder to prove the pause-lower-priority hold: a reserved smart-task
// device flagged `holdLowerPriority` puts lower-priority managed devices into the shed set until
// it is active, subject to the mathematical feasibility-lift — all in the plan layer.

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
    ...loose,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentOn: resolveFixtureCurrentOn(merged),
  }) as PlanInputDevice;
};

// Reserved priority-1 heater (the smart-task device that carries the hold flag) plus one
// lower-priority thermostat. `reservedDrawKw` toggles active/inactive.
const buildDevices = (reservedDrawKw: number): PlanInputDevice[] => [
  buildInputDevice({
    id: 'heater',
    name: 'Connected 300',
    holdLowerPriority: true,
    measuredPowerKw: reservedDrawKw,
    expectedPowerKw: 1.19,
  }),
  buildInputDevice({
    id: 'thermostat',
    name: 'Termostat',
    measuredPowerKw: 0.3,
  }),
];

const makeBuilder = (params: { limitKw: number; totalKw: number; devices: PlanInputDevice[] }): PlanBuilder => {
  const capacityGuard = new CapacityGuard({ limitKw: params.limitKw, softMarginKw: 0.2 });
  capacityGuard.reportTotalPower(params.totalKw);
  return new PlanBuilder({
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
    // heater is priority 1 (top); thermostat lower (higher number sheds first).
    getPriorityForDevice: (deviceId: string) => (deviceId === 'heater' ? 1 : 10),
    getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
    // Keep normal capacity shedding out of the picture so the ONLY thing that can shed the
    // thermostat is the pause-hold; the feasibility math reads capacitySettings.limitKw, not this.
    getDynamicSoftLimitOverride: () => 10,
    log: vi.fn(),
    logDebug: vi.fn(),
    pendingBinaryCommandStore: emptyPendingStore,
  }, createPlanEngineState());
};

const stateOf = (plan: Awaited<ReturnType<PlanBuilder['buildDevicePlanSnapshot']>>, id: string): string | undefined => (
  plan.devices.find((device) => device.id === id)?.plannedState
);

describe('PlanBuilder pause-lower-priority hold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T10:30:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('holds the lower-priority device off while the reserved device is inactive and feasible', async () => {
    // ceiling = 10 - 0.2 = 9.8; otherLoad = 0.8 - 0 - 0.3 = 0.5; 0.5 + 1.19 = 1.69 <= 9.8 → hold.
    const builder = makeBuilder({ limitKw: 10, totalKw: 0.8, devices: buildDevices(0) });
    const plan = await builder.buildDevicePlanSnapshot(buildDevices(0));
    expect(stateOf(plan, 'thermostat')).toBe('shed');
    expect(stateOf(plan, 'heater')).not.toBe('shed');
  });

  it('LIFTS the hold when the reserved device cannot be admitted even with everything off', async () => {
    // hard cap 1.0, margin 0.2 → ceiling 0.8; reserved lowest step 1.19 kW alone exceeds it →
    // mathematically impossible → do NOT hold (the thermostat keeps running).
    const builder = makeBuilder({ limitKw: 1.0, totalKw: 0.8, devices: buildDevices(0) });
    const plan = await builder.buildDevicePlanSnapshot(buildDevices(0));
    expect(stateOf(plan, 'thermostat')).toBe('keep');
  });

  it('RELEASES the hold once the reserved device is active (drawing at >= its lowest step)', async () => {
    const builder = makeBuilder({ limitKw: 10, totalKw: 2.0, devices: buildDevices(1.19) });
    const plan = await builder.buildDevicePlanSnapshot(buildDevices(1.19));
    expect(stateOf(plan, 'thermostat')).toBe('keep');
  });

  it('keeps an already-off lower-priority device shed (restore never lifts the hold) across cycles', async () => {
    // Multi-cycle protection: once turned off, the thermostat is an observed-off restore
    // candidate — but pauseHold re-adds it to shedSet every cycle, and the restore pass never
    // lifts a plannedState==='shed' device (isRestoreLiveEligibleDevice). Reserved inactive +
    // feasible → the off thermostat stays shed instead of being restored into the free headroom.
    const devices: PlanInputDevice[] = [
      buildInputDevice({ id: 'heater', name: 'Connected 300', holdLowerPriority: true, measuredPowerKw: 0, expectedPowerKw: 1.19 }),
      buildInputDevice({ id: 'thermostat', name: 'Termostat', binaryControl: { on: false }, measuredPowerKw: 0 }),
    ];
    const builder = makeBuilder({ limitKw: 10, totalKw: 0.5, devices });
    const first = await builder.buildDevicePlanSnapshot(devices);
    expect(stateOf(first, 'thermostat')).toBe('shed');
    // Second rebuild against the same builder/state: pauseHold re-applies the hold, and the
    // restore pass still cannot lift a plannedState==='shed' device (isRestoreLiveEligibleDevice).
    const second = await builder.buildDevicePlanSnapshot(devices);
    expect(stateOf(second, 'thermostat')).toBe('shed');
  });
});
