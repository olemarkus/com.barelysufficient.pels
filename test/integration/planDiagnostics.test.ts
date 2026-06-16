import { buildDeviceDiagnosticsObservations } from '../../lib/plan/planDiagnostics';
import type { PlanContext } from '../../lib/plan/planContext';
import type { RestorePlanResult } from '../../lib/plan/restore';
import type {
  DevicePlanDevice,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { buildPlanInputDevice, buildPlanDevice } from '../utils/planTestUtils';
import { legacyDeviceReason } from '../utils/deviceReasonTestUtils';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DeviceDiagnosticsService,
} from '../../lib/diagnostics/deviceDiagnosticsService';
import { createDeviceDiagnosticsStateStore } from '../../setup/deviceDiagnosticsStateAdapter';
import { starvationRowOffersRescue } from '../../packages/shared-domain/src/planStarvation';

const r = (reason: string) => legacyDeviceReason(reason)!;

const buildContext = (
  device: PlanInputDevice,
  desiredForMode: Record<string, number> = {},
  softLimitSource: PlanContext['softLimitSource'] = 'capacity',
  powerFreshnessState: PlanContext['powerFreshnessState'] = 'fresh',
): PlanContext => ({
  devices: [device],
  desiredForMode,
  total: 4,
  powerKnown: powerFreshnessState === 'fresh',
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState,
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  softLimitSource,
  hourBucketKey: '2026-01-01T00',
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
  shedCooldownStartedAtMs: null,
  shedCooldownTotalSec: null,
  restoreCooldownRemainingSec: null,
  restoreCooldownStartedAtMs: null,
  restoreCooldownTotalSec: null,
  inShedWindow: false,
  restoreCooldownMs: 60 * 1000,
  lastRestoreCooldownBumpMs: null,
  ...overrides,
});

type InputDeviceFixture = Partial<PlanInputDevice>
  & BinaryControlDiscriminantProbe
  & TemperatureDiscriminantProbe
  & { evChargingState?: string; deviceType?: 'temperature' | 'onoff' };
type PlanDeviceFixture = Partial<DevicePlanDevice>
  & TemperatureDiscriminantProbe
  & {
    reason?: DevicePlanDevice['reason'] | string;
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
  };

const buildObservation = (params: {
  inputDevice: InputDeviceFixture;
  planDevice: PlanDeviceFixture;
  restoreResult?: Partial<RestorePlanResult>;
  desiredForMode?: Record<string, number>;
  softLimitSource?: PlanContext['softLimitSource'];
  powerFreshnessState?: PlanContext['powerFreshnessState'];
  priceOptimizationEnabled?: boolean;
  priceOptimizationSettings?: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap?: () => boolean;
  isCurrentHourExpensive?: () => boolean;
}) => buildDeviceDiagnosticsObservations({
  context: buildContext(
    buildPlanInputDevice(params.inputDevice),
    params.desiredForMode,
    params.softLimitSource,
    params.powerFreshnessState,
  ),
  // Production always stamps the plan device's `deviceType` from the snapshot, so
  // mirror the input device's modality onto the plan device the fixture builds.
  // The temperature-cluster reads (`currentTarget` / `currentTemperature`) on the
  // plan device narrow through `isTemperaturePlanDevice`, which keys on it.
  planDevices: [buildPlanDevice({ deviceType: params.inputDevice.deviceType, ...params.planDevice })],
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
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
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
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
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'ev-1',
        name: 'Driveway EV',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: null,
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
        binaryControl: { on: true },
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
      // PELS commands the held 18° setpoint (3° under the 21° mode target).
      commandedTargetC: 18,
      targetStepC: 0.5,
      suppressionState: 'counting',
      countingCause: 'capacity',
      pauseReason: null,
    });
  });

  it('resolves the commanded target from the planned setpoint, falling back to the current setpoint', () => {
    const inputDevice: PlanInputDevice = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Hall Heater',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      managed: true,
      controllable: true,
      available: true,
      currentTemperature: 18,
      targets: [{ id: 'target_temperature', value: 18, unit: 'C', step: 0.5 }],
    });
    const basePlanDevice: DevicePlanDevice = buildPlanDevice({
      id: 'heater-1',
      name: 'Hall Heater',
      deviceClass: 'thermostat',
      currentState: 'not_applicable',
      plannedState: 'shed',
      currentTarget: 19,
      reason: r('shed due to capacity'),
      controllable: true,
      available: true,
      currentTemperature: 18,
    });

    // Planned setpoint present → that is what PELS is commanding.
    expect(buildObservation({
      inputDevice,
      planDevice: { ...basePlanDevice, plannedTarget: 16 },
      desiredForMode: { 'heater-1': 21 },
    }).commandedTargetC).toBe(16);

    // No planned setpoint → fall back to the held current setpoint.
    expect(buildObservation({
      inputDevice,
      planDevice: basePlanDevice,
      desiredForMode: { 'heater-1': 21 },
    }).commandedTargetC).toBe(19);
  });

  it('flags a turn_off shed of a temperature device as a PELS-commanded off shed', () => {
    const inputDevice: PlanInputDevice = buildPlanInputDevice({
      id: 'heater-1',
      name: 'Hall Heater',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      managed: true,
      controllable: true,
      available: true,
      currentTemperature: 16,
      targets: [{ id: 'target_temperature', value: 18, unit: 'C', step: 0.5 }],
    });
    const basePlanDevice: DevicePlanDevice = buildPlanDevice({
      id: 'heater-1',
      name: 'Hall Heater',
      deviceClass: 'thermostat',
      currentState: 'off',
      plannedState: 'shed',
      currentTarget: 18,
      plannedTarget: 18,
      reason: r('shed due to capacity'),
      controllable: true,
      available: true,
      currentTemperature: 16,
    });

    // turn_off shed → no lowered setpoint, but flagged as a PELS off shed.
    expect(buildObservation({
      inputDevice,
      planDevice: { ...basePlanDevice, shedAction: 'turn_off' },
      desiredForMode: { 'heater-1': 18 },
    })).toMatchObject({
      pelsCommandsTurnOffShed: true,
      commandedTargetC: 18,
      currentTemperatureC: 16,
      intendedNormalTargetC: 18,
    });

    // A kept device (PELS not shedding) is never an off shed, even off+cold.
    expect(buildObservation({
      inputDevice,
      planDevice: { ...basePlanDevice, plannedState: 'keep', shedAction: 'turn_off' },
      desiredForMode: { 'heater-1': 18 },
    }).pelsCommandsTurnOffShed).toBe(false);

    // A setpoint-lowering shed is not a turn_off off shed.
    expect(buildObservation({
      inputDevice,
      planDevice: { ...basePlanDevice, shedAction: 'set_temperature', plannedTarget: 16 },
      desiredForMode: { 'heater-1': 18 },
    }).pelsCommandsTurnOffShed).toBe(false);
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
        binaryControl: { on: true },
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
        binaryControl: { on: true },
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

  it('keeps unknown shed reasons explicitly attributed instead of mapping them to a known cause', () => {
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
        binaryControl: { on: true },
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

  it('attributes a deferred-objective avoid hold as a paused starvation state', () => {
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
        binaryControl: { on: false },
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
        reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid, detail: null },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation).toMatchObject({
      suppressionState: 'paused',
      countingCause: null,
      pauseReason: 'deferred_objective_avoid',
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
        binaryControl: { on: true },
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
        binaryControl: { on: true },
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
        binaryControl: { on: false },
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

  it('re-attributes a daily-bound insufficient-headroom hold to the daily_budget counting cause', () => {
    // Live "Termostat Synne" repro: the device is held off because the binding
    // soft limit is the DAILY BUDGET, but the restore producer emits
    // `insufficient_headroom`. The producer knows `softLimitSource === 'daily'`,
    // so the counting cause resolves to the releasable budget bucket — the daily
    // budget is the real lever, not the (far higher) physical capacity cap.
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        binaryControl: { on: false },
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 18,
        reason: {
          code: PLAN_REASON_CODES.insufficientHeadroom,
          needKw: 0.9,
          availableKw: 0.1,
          postReserveMarginKw: -0.1,
          minimumRequiredPostReserveMarginKw: 0.2,
          penaltyExtraKw: null,
          swapReserveKw: null,
          effectiveAvailableKw: null,
          swapTargetName: null,
        },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
      softLimitSource: 'daily',
    });

    expect(observation).toMatchObject({
      suppressionState: 'counting',
      countingCause: 'daily_budget',
      pauseReason: null,
    });
  });

  it('keeps a genuinely capacity-bound insufficient-headroom hold attributed to insufficient_headroom', () => {
    // Regression guard: when the physical capacity cap is the binding soft limit,
    // the headroom shortfall is a real capacity hold — it must NOT masquerade as a
    // releasable budget cause (which would offer a phantom rescue).
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        binaryControl: { on: false },
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 18,
        reason: {
          code: PLAN_REASON_CODES.insufficientHeadroom,
          needKw: 0.9,
          availableKw: 0.1,
          postReserveMarginKw: -0.1,
          minimumRequiredPostReserveMarginKw: 0.2,
          penaltyExtraKw: null,
          swapReserveKw: null,
          effectiveAvailableKw: null,
          swapTargetName: null,
        },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
      softLimitSource: 'capacity',
    });

    expect(observation).toMatchObject({
      suppressionState: 'counting',
      countingCause: 'insufficient_headroom',
      pauseReason: null,
    });
  });

  it('keeps a daily-bound headroom hold in the capacity bucket while power is not fresh (stale_hold)', () => {
    // When the meter is not fresh (`stale_hold` here uses a synthetic 0 headroom; the harsher
    // `stale_fail_closed` forces -1), `powerKnown` is false and the hold exists regardless of
    // the daily budget. Lifting the daily budget cannot make restoring safe until a fresh power
    // sample arrives, so the hold must NOT be re-attributed to the releasable budget bucket even
    // though `softLimitSource === 'daily'`.
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        binaryControl: { on: false },
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'keep',
        currentTarget: 18,
        plannedTarget: 18,
        reason: {
          code: PLAN_REASON_CODES.insufficientHeadroom,
          needKw: 0.9,
          availableKw: 0.1,
          postReserveMarginKw: -0.1,
          minimumRequiredPostReserveMarginKw: 0.2,
          penaltyExtraKw: null,
          swapReserveKw: null,
          effectiveAvailableKw: null,
          swapTargetName: null,
        },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
      softLimitSource: 'daily',
      powerFreshnessState: 'stale_hold',
    });

    expect(observation).toMatchObject({
      suppressionState: 'counting',
      countingCause: 'insufficient_headroom',
      pauseReason: null,
    });
  });

  it('does not re-attribute a non-headroom capacity shed even under a daily-bound soft limit', () => {
    // Only the headroom-shortfall family is budget-driven. A genuine capacity shed
    // (`shed due to capacity`) keeps its capacity cause — re-attribution is scoped
    // to the `insufficient_headroom` restore-hold, not every counting cause.
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 18,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Termostat Synne',
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
      softLimitSource: 'daily',
    });

    expect(observation).toMatchObject({
      suppressionState: 'counting',
      countingCause: 'capacity',
    });
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
        binaryControl: { on: false },
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

describe('daily-bound headroom starvation flows through to the overview budget bucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildSteadyDailyHeadroomObservation = () => buildObservation({
    inputDevice: {
      id: 'heater-1',
      name: 'Termostat Synne',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      managed: true,
      controllable: true,
      available: true,
      currentTemperature: 18,
      binaryControl: { on: false },
      targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
    },
    planDevice: {
      id: 'heater-1',
      name: 'Termostat Synne',
      deviceClass: 'thermostat',
      currentState: 'off',
      plannedState: 'keep',
      currentTarget: 18,
      plannedTarget: 18,
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 0.9,
        availableKw: 0.1,
        postReserveMarginKw: -0.1,
        minimumRequiredPostReserveMarginKw: 0.2,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
        swapTargetName: null,
      },
      controllable: true,
      available: true,
      currentTemperature: 18,
    },
    desiredForMode: { 'heater-1': 21 },
    softLimitSource: 'daily',
  });

  it('resolves to a stable budget bucket that offers a rescue (no cycle-to-cycle flip)', () => {
    const store = new Map<string, unknown>();
    const settings = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    const service = new DeviceDiagnosticsService({
      diagnosticsStateStore: createDeviceDiagnosticsStateStore({ settings } as never),
      getTimeZone: () => 'Europe/Oslo',
      isDebugEnabled: () => false,
    });

    // Feed the REAL producer's output across many rebuild cycles. Previously the
    // restore producer alternated `insufficient_headroom` (→ capacity, rescue
    // hidden) and `daily_budget` (→ budget, rescue shown) for the same daily-bound
    // hold, so the overview cause flipped and the rescue button flickered. With the
    // producer re-attribution the cause is steady, so the bucket never flips.
    const start = Date.now();
    const seenCauses = new Set<string>();
    for (const offset of [0, 9, 16, 25, 40, 55]) {
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [buildSteadyDailyHeadroomObservation()],
      });
      const overview = service.getOverviewStarvation('heater-1');
      if (overview) seenCauses.add(overview.cause);
    }

    expect([...seenCauses]).toEqual(['budget']);
    const finalOverview = service.getOverviewStarvation('heater-1');
    expect(finalOverview).toMatchObject({ isStarved: true, cause: 'budget' });
    expect(starvationRowOffersRescue(finalOverview!.cause)).toBe(true);

    expect(DEVICE_DIAGNOSTICS_STATE_KEY).toBe('device_diagnostics_v1');
    service.destroy();
  });

  // Same off, below-target device; only the plan's REASON oscillates cycle-to-cycle
  // between `dailyBudget` (shed framing → budget) and `insufficient_headroom` (restore
  // hold). This is the real "Termostat Synne" flip: pre-fix the headroom cycles bucketed
  // to capacity (rescue hidden) while the dailyBudget cycles bucketed to budget (rescue
  // shown), so the rescue affordance flickered. The producer re-attribution makes the
  // headroom cycles resolve to budget too, so the bucket is stable across the oscillation.
  const buildDailyBudgetHoldObservation = () => buildObservation({
    inputDevice: {
      id: 'heater-1',
      name: 'Termostat Synne',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      managed: true,
      controllable: true,
      available: true,
      currentTemperature: 18,
      binaryControl: { on: false },
      targets: [{ id: 'target_temperature', value: 18, unit: 'C' }],
    },
    planDevice: {
      id: 'heater-1',
      name: 'Termostat Synne',
      deviceClass: 'thermostat',
      currentState: 'off',
      plannedState: 'keep',
      currentTarget: 18,
      plannedTarget: 18,
      reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null },
      controllable: true,
      available: true,
      currentTemperature: 18,
    },
    desiredForMode: { 'heater-1': 21 },
    softLimitSource: 'daily',
  });

  it('holds a stable budget bucket while the plan reason oscillates dailyBudget <-> insufficient_headroom', () => {
    const store = new Map<string, unknown>();
    const settings = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    const service = new DeviceDiagnosticsService({
      diagnosticsStateStore: createDeviceDiagnosticsStateStore({ settings } as never),
      getTimeZone: () => 'Europe/Oslo',
      isDebugEnabled: () => false,
    });

    // Alternate the two budget-family reasons across rebuilds. The overview cause must
    // never leave the budget bucket — that is the regression guard for the flicker.
    const start = Date.now();
    const seenCauses = new Set<string>();
    const offsets = [0, 9, 16, 25, 40, 55];
    offsets.forEach((offset, index) => {
      const observation = index % 2 === 0
        ? buildSteadyDailyHeadroomObservation()
        : buildDailyBudgetHoldObservation();
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [observation],
      });
      const overview = service.getOverviewStarvation('heater-1');
      if (overview) seenCauses.add(overview.cause);
    });

    expect([...seenCauses]).toEqual(['budget']);
    const finalOverview = service.getOverviewStarvation('heater-1');
    expect(finalOverview).toMatchObject({ isStarved: true, cause: 'budget' });
    expect(starvationRowOffersRescue(finalOverview!.cause)).toBe(true);
    service.destroy();
  });
});
