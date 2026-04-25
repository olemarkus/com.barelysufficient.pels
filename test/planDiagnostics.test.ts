import { buildDeviceDiagnosticsObservations } from '../lib/plan/planDiagnostics';
import type { PlanContext } from '../lib/plan/planContext';
import type { RestorePlanResult } from '../lib/plan/planRestore';
import type { DevicePlanDevice, PlanInputDevice } from '../lib/plan/planTypes';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';

const r = legacyDeviceReason;

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
    swapByDevice: {},
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
  priceOptimizationEnabled?: boolean;
  priceOptimizationSettings?: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap?: () => boolean;
  isCurrentHourExpensive?: () => boolean;
}) => buildDeviceDiagnosticsObservations({
  context: buildContext(params.inputDevice, params.desiredForMode),
  planDevices: [params.planDevice],
  restoreResult: buildRestoreResult(params.restoreResult),
  priceOptimizationEnabled: params.priceOptimizationEnabled ?? false,
  priceOptimizationSettings: params.priceOptimizationSettings ?? {},
  isCurrentHourCheap: params.isCurrentHourCheap ?? (() => false),
  isCurrentHourExpensive: params.isCurrentHourExpensive ?? (() => false),
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
        reason: r('shed due to capacity'),
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
        reason: r('shed due to capacity'),
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
        reason: r('shed due to capacity'),
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
        reason: r('shed due to capacity'),
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
      eligibleForStarvation: false,
      suppressionState: 'none',
    });
  });

  it('builds starvation eligibility and counting cause from the formal temperature device model', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C', step: 0.5 }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        reason: r('shed due to capacity'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation).toMatchObject({
      eligibleForStarvation: true,
      observationFresh: true,
      currentTemperatureC: 18,
      intendedNormalTargetC: 21,
      targetStepC: 0.5,
      suppressionState: 'counting',
      countingCause: 'capacity',
      pauseReason: null,
    });
  });

  it('uses the operating-mode target rather than price-optimization deltas for starvation baseline', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'heater',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'heater',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 24,
        reason: r('shed due to capacity'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 20 },
      priceOptimizationEnabled: true,
      priceOptimizationSettings: { 'heater-1': { enabled: true, cheapDelta: 4, expensiveDelta: -4 } },
      isCurrentHourCheap: () => true,
    });

    expect(observation.desiredStateSummary).toBe('24.0C');
    expect(observation.intendedNormalTargetC).toBe(20);
    expect(observation.targetStepC).toBe(0.5);
  });

  it('marks stale temperature observations as not fresh without inventing continuity', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        observationStale: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'unknown',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        reason: r('shed due to capacity'),
        controllable: true,
        available: true,
        observationStale: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation.eligibleForStarvation).toBe(true);
    expect(observation.observationFresh).toBe(false);
    expect(observation.currentTemperatureC).toBe(18);
  });

  it('treats unknown shed reasons as non-counting instead of silently counting starvation', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        reason: r('waiting for moon phase alignment'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation).toMatchObject({
      suppressionState: 'paused',
      countingCause: null,
      pauseReason: 'unknown_suppression_reason',
    });
  });

  it('normalizes keep and restore hold states as paused starvation states', () => {
    const keepObservation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'not_applicable',
        plannedState: 'keep',
        currentTarget: 21,
        plannedTarget: 21,
        reason: r('keep (recently restored)'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });
    const restoreObservation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'not_applicable',
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 21,
        reason: r('restore pending (45s remaining)'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(keepObservation.pauseReason).toBe('keep');
    expect(keepObservation.suppressionState).toBe('paused');
    expect(restoreObservation.pauseReason).toBe('restore');
    expect(restoreObservation.suppressionState).toBe('paused');
  });

  it('uses explicit keep-state hold reasons for starvation suppression', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: false,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 21,
        reason: r('meter settling (30s remaining)'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation.pauseReason).toBe('cooldown');
    expect(observation.suppressionState).toBe('paused');
  });

  it('treats activation backoff as paused starvation rather than counting suppression', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        currentOn: false,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 21,
        reason: r('activation backoff (30s remaining)'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation.pauseReason).toBe('activation_backoff');
    expect(observation.suppressionState).toBe('paused');
    expect(observation.countingCause).toBeNull();
  });
});
