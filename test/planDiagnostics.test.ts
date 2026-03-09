import { buildDeviceDiagnosticsObservations } from '../lib/plan/planDiagnostics';
import type { PlanContext } from '../lib/plan/planContext';
import type { RestorePlanResult } from '../lib/plan/planRestore';
import type { DevicePlanDevice, PlanInputDevice } from '../lib/plan/planTypes';

const buildContext = (device: PlanInputDevice, desiredForMode: Record<string, number> = {}): PlanContext => ({
  devices: [device],
  desiredForMode,
  total: 4,
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 4,
  usedKWh: 1,
  minutesRemaining: 30,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
});

const buildRestoreResult = (overrides: Partial<RestorePlanResult> = {}): RestorePlanResult => ({
  planDevices: [],
  stateUpdates: {
    swappedOutFor: {},
    pendingSwapTargets: new Set<string>(),
    pendingSwapTimestamps: {},
    lastSwapPlanMeasurementTs: {},
  },
  restoredThisCycle: new Set<string>(),
  availableHeadroom: 1,
  restoredOneThisCycle: false,
  inCooldown: false,
  inRestoreCooldown: false,
  activeOvershoot: false,
  restoreCooldownSeconds: 0,
  shedCooldownRemainingSec: null,
  restoreCooldownRemainingSec: null,
  inShedWindow: false,
  restoreCooldownMs: 60 * 1000,
  lastRestoreCooldownBumpMs: null,
  ...overrides,
});

const buildObservation = (params: {
  inputDevice: PlanInputDevice;
  planDevice: DevicePlanDevice;
  restoreResult?: Partial<RestorePlanResult>;
  desiredForMode?: Record<string, number>;
}) => buildDeviceDiagnosticsObservations({
  context: buildContext(params.inputDevice, params.desiredForMode),
  planDevices: [params.planDevice],
  restoreResult: buildRestoreResult(params.restoreResult),
  priceOptimizationEnabled: false,
  priceOptimizationSettings: {},
  isCurrentHourCheap: () => false,
  isCurrentHourExpensive: () => false,
})[0];

describe('plan diagnostics observations', () => {
  it('classifies active overshoot as headroom for temperature devices', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        controllable: true,
        available: true,
      },
      restoreResult: {
        activeOvershoot: true,
        inCooldown: true,
        inShedWindow: true,
      },
      desiredForMode: { 'heater-1': 22 },
    });

    expect(observation).toMatchObject({
      includeDemandMetrics: true,
      unmetDemand: true,
      blockCause: 'headroom',
    });
  });

  it('classifies active overshoot as headroom for binary devices', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        deviceType: 'onoff',
        targets: [],
        hasBinaryControl: true,
        currentOn: false,
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
        plannedTarget: null,
        controllable: true,
        available: true,
      },
      restoreResult: {
        activeOvershoot: true,
        inCooldown: true,
        inShedWindow: true,
      },
    });

    expect(observation).toMatchObject({
      includeDemandMetrics: true,
      unmetDemand: true,
      blockCause: 'headroom',
    });
  });

  it('treats restore throttling as cooldown/backoff for binary devices', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        deviceType: 'onoff',
        targets: [],
        hasBinaryControl: true,
        currentOn: false,
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
        plannedTarget: null,
        controllable: true,
        available: true,
      },
      restoreResult: {
        restoredOneThisCycle: true,
      },
    });

    expect(observation.blockCause).toBe('cooldown_backoff');
  });

  it('classifies shed cooldown as cooldown/backoff for temperature devices', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        controllable: true,
        available: true,
      },
      restoreResult: {
        inCooldown: true,
        inShedWindow: true,
      },
      desiredForMode: { 'heater-1': 22 },
    });

    expect(observation.blockCause).toBe('cooldown_backoff');
  });

  it('excludes EV chargers from unmet-demand and starvation diagnostics', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'ev-1',
        name: 'Driveway EV',
        deviceType: 'onoff',
        targets: [],
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        currentOn: false,
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'ev-1',
        name: 'Driveway EV',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
        plannedTarget: null,
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        controllable: true,
        available: true,
      },
      restoreResult: {
        activeOvershoot: true,
      },
    });

    expect(observation).toMatchObject({
      includeDemandMetrics: false,
      unmetDemand: false,
      blockCause: 'not_blocked',
      desiredStateSummary: 'on',
    });
  });
});
