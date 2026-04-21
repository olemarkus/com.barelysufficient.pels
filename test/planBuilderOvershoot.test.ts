import CapacityGuard from '../lib/core/capacityGuard';
import { recordActivationAttemptStart } from '../lib/plan/planActivationBackoff';
import { PlanBuilder } from '../lib/plan/planBuilder';
import { createPlanEngineState } from '../lib/plan/planState';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import { steppedInputDevice } from './utils/planTestUtils';

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: true,
  controllable: true,
  ...overrides,
});

describe('PlanBuilder overshoot diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T11:04:01.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs controlled and reducible load when overshoot is recoverable by control', async () => {
    const state = createPlanEngineState();

    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: (deviceId: string) => (
        deviceId === 'at-temp'
          ? { action: 'set_temperature', temperature: 15, stepId: null }
          : { action: 'turn_off', temperature: null, stepId: null }
      ),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      totalKw: 2.5,
      hardCapBreached: false,
      hardCapHeadroomKw: 2.5,
      remainingReducibleControlledLoad: true,
      remainingReducibleControlledLoadW: 900,
      activeControlledDevices: 2,
      activePlannedShedDevices: 1,
    }));
  });

  it('logs overshoot as exhausted when all shed candidates are already at minimum', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
    capacityGuard.reportTotalPower(4.8);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'at-temp',
        name: 'AtTemp',
        measuredPowerKw: 0.8,
        targets: [{ id: 'target_temperature', value: 15, unit: 'C' }],
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      totalKw: 4.8,
      hardCapBreached: true,
      hardCapHeadroomKw: expect.closeTo(-0.8, 6),
      remainingReducibleControlledLoad: false,
      remainingReducibleControlledLoadW: 0,
      activeControlledDevices: 1,
      activePlannedShedDevices: 1,
    }));
  });

  it('sheds live measured stepped load during startup overshoot even when the current step is unknown', async () => {
    const now = new Date('2026-04-15T11:04:01.000Z').getTime();
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastDeviceControlledMs['step-live'] = now - (10 * 60_000);
    state.lastPlannedShedIds = new Set(['carryover-off']);

    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(4.461);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: now }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: (deviceId: string) => (deviceId === 'step-live' ? 100 : 10),
      getDynamicSoftLimitOverride: () => 2.0,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: { info: vi.fn() } as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    const plan = await builder.buildDevicePlanSnapshot([
      {
        ...steppedInputDevice({
          id: 'step-live',
          name: 'Connected 300',
          currentOn: true,
          currentState: 'on',
          measuredPowerKw: 1.671,
          expectedPowerKw: 1.25,
        }),
        selectedStepId: undefined,
        desiredStepId: undefined,
      },
      buildDevice({
        id: 'carryover-off',
        name: 'Carryover Off',
        currentOn: false,
        currentState: 'off',
        measuredPowerKw: 0,
        expectedPowerKw: 0,
      }),
    ]);

    const liveStepped = plan.devices.find((device) => device.id === 'step-live');
    expect(liveStepped?.plannedState).toBe('shed');
    expect(liveStepped?.reason.code).toBe('capacity');
  });

  it('does not emit a changed overshoot summary when same-sample skip keeps authority unchanged', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: 500 }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    const devices = [
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ];

    await builder.buildDevicePlanSnapshot(devices);
    await builder.buildDevicePlanSnapshot(devices);

    expect(structuredLog.info).toHaveBeenCalledTimes(1);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      hardCapBreached: false,
      remainingReducibleControlledLoad: true,
      activeControlledDevices: 2,
    }));
  });

  it('clamps overshoot duration to zero when the start timestamp is in the future', async () => {
    const state = createPlanEngineState();
    state.wasOvershoot = true;
    state.overshootLogged = true;
    state.overshootStartedMs = Date.now() + 5_000;

    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'device-1',
        name: 'Device',
        measuredPowerKw: 0.1,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_cleared',
      durationMs: 0,
    }));
  });

  it('does not attribute overshoot when the total rise stays within the deadband', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['deadband-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'deadband-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
      capacityGuard.reportTotalPower(4.8);

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: vi.fn()
          .mockReturnValueOnce(1.3)
          .mockReturnValueOnce(0.9),
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      const devices = [
        buildDevice({
          id: 'deadband-device',
          name: 'Deadband Device',
          measuredPowerKw: 1.03,
        }),
      ];

      capacityGuard.reportTotalPower(1.01);
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(1.03);
      await builder.buildDevicePlanSnapshot(devices);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.02,
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attribute overshoot when the restored device is not a contributor', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['restored-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      const devices = [
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.5,
        }),
      ];

      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot(devices);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootTopControlledContributors: [],
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes overshoot when the restored device is a positive contributor', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['restored-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      capacityGuard.reportTotalPower(0.6);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.1,
        }),
      ]);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.7,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.7,
        overshootTopControlledContributors: [
          expect.objectContaining({
            deviceId: 'restored-device',
            deltaKw: 0.6,
          }),
        ],
      }));
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-device',
        restoreAgeMs: 1_000,
        penaltyLevel: 1,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attribute a later overshoot after a thermostat restore has shown load and survived the next power sample', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(0.75);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 30_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.55,
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps attribution open through a pending soft overshoot until a truly clean sample arrives', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(1.03);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.25,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
        observedActivePowerAtMs: start + 10_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 30_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
      }));
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not close restore attribution on a stale-hold rebuild with non-negative synthetic headroom', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      let lastTimestamp = start;
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastTimestamp = start + 10_000;
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      lastTimestamp = start + 20_000;
      vi.setSystemTime(start + 90_000);
      capacityGuard.reportTotalPower(0.75);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
        observedActivePowerAtMs: start + 10_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 100_000);
      lastTimestamp = start + 100_000;
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 100_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps attribution open when the only non-zero thermostat load is stale', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          observationStale: true,
          lastFreshDataMs: start - 5_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.8,
          observationStale: true,
          lastFreshDataMs: start - 5_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
