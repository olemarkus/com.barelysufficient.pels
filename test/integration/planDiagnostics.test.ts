import { planContextPower } from '../utils/planContextPowerFixture';
import { buildDeviceDiagnosticsObservations } from '../../lib/plan/planDiagnostics';
import {
  isDeviceObservationStale,
  STALE_DEVICE_OBSERVATION_MS,
} from '../../lib/observer/observationFreshness';
import type { PlanContext } from '../../lib/plan/planContext';
import type { RestorePlanResult } from '../../lib/plan/restore';
import type {
  DevicePlanDevice,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { buildPlanInputDevice, buildPlanDevice } from '../utils/planTestUtils';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  DEVICE_DIAGNOSTICS_STATE_KEY,
  DeviceDiagnosticsService,
} from '../../lib/diagnostics/deviceDiagnosticsService';
import { createDeviceDiagnosticsStateStore } from '../../setup/deviceDiagnosticsStateAdapter';
import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../lib/utils/dateUtils';

const r = (reason: string) => fixtureDeviceReason(reason)!;

const buildContext = (
  device: PlanInputDevice,
  desiredForMode: Record<string, number> = {},
  softLimitSource: PlanContext['softLimitSource'] = 'capacity',
  // What the meter read, or `null` for a cycle with no measurement. The power
  // answers follow from it (`planContextPower`), as they do in production.
  fixtureTotalKw: number | null = 4,
  currentHourPriceLevel: PlanContext['currentHourPriceLevel'] = { cheap: false, expensive: false },
): PlanContext => ({
  devices: [device],
  desiredForMode,
  ...planContextPower(fixtureTotalKw),
  softLimit: 5,
  capacitySoftLimit: 5,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource,
  // Mirrors the producer resolution in `buildPlanContext`: daily binding + fresh
  // power + no capacity breach (total 4 < capacitySoftLimit 5 in this fixture).
  budgetReleasableHeadroomHold: softLimitSource === 'daily' && fixtureTotalKw !== null,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  hourBucketKey: '2026-01-01T00',
  budgetKWh: 4,
  usedKWh: 1,
  minutesRemaining: 30,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel,
});

// A real epoch, not 0: `nowTs` is `Date.now()` in production and now dates the
// ceiling shortfall's recent-shed window.
const FIXTURE_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

const buildRestoreResult = (overrides: Partial<RestorePlanResult> = {}): RestorePlanResult => ({
  planDevices: [],
  stateUpdates: {
    swapByDevice: {},
  },
  restoredThisCycle: new Set<string>(),
  headroomReserves: [],
  availableHeadroom: 1,
  capacityAvailableKw: 1,
  budgetAvailableKw: null,
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
  inStartupStabilization: false,
  nowTs: FIXTURE_NOW_MS,
  restoreCooldownMs: 60 * 1000,
  lastRestoreCooldownBumpMs: null,
  ...overrides,
  restoreCooldownPreview: overrides.restoreCooldownPreview ?? null,
});

type InputDeviceFixture = Partial<PlanInputDevice>
  & BinaryControlDiscriminantProbe
  & TemperatureDiscriminantProbe
  & { evChargingState?: string; binaryCapabilityId?: string; deviceType?: 'temperature' | 'onoff' };
type PlanDeviceFixture = Partial<DevicePlanDevice>
  & TemperatureDiscriminantProbe
  & {
    reason?: DevicePlanDevice['reason'] | string;
    evChargingState?: string;
    binaryCapabilityId?: string;
    deviceType?: 'temperature' | 'onoff';
  };

const buildObservation = (params: {
  inputDevice: InputDeviceFixture;
  planDevice: PlanDeviceFixture;
  restoreResult?: Partial<RestorePlanResult>;
  desiredForMode?: Record<string, number>;
  softLimitSource?: PlanContext['softLimitSource'];
  fixtureTotalKw?: number | null;
  priceOptimizationEnabled?: boolean;
  priceOptimizationSettings?: Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  currentHourPriceLevel?: PlanContext['currentHourPriceLevel'];
  // Observer-resolved staleness for the device (defaults fresh). Drives the
  // diagnostics freshness gate exactly as the production observer dep does.
  getObservationStale?: (deviceId: string) => boolean;
}) => buildDeviceDiagnosticsObservations({
  context: buildContext(
    buildPlanInputDevice(params.inputDevice),
    params.desiredForMode,
    params.softLimitSource,
    params.fixtureTotalKw,
    params.currentHourPriceLevel,
  ),
  getObservationStale: params.getObservationStale ?? (() => false),
  // Production always stamps the plan device's `deviceType` from the snapshot, so
  // mirror the input device's modality onto the plan device the fixture builds.
  // The temperature-cluster reads (`currentTarget` / `currentTemperature`) on the
  // plan device narrow through `isTemperaturePlanDevice`, which keys on it.
  planDevices: [buildPlanDevice({ deviceType: params.inputDevice.deviceType, ...params.planDevice })],
  restoreResult: buildRestoreResult(params.restoreResult),
  priceOptimizationEnabled: params.priceOptimizationEnabled ?? false,
  priceOptimizationSettings: params.priceOptimizationSettings ?? {},
})[0];

describe('plan diagnostics observations', () => {
  it('classifies active overshoot as headroom for temperature devices', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceType: 'temperature',
        currentTemperature: 18,
        currentTarget: 18,
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
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
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
        binaryCapabilityId: 'onoff',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'switch-1',
        name: 'Water Heater',
        currentState: 'off',
        plannedState: 'shed',
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
        currentTemperature: 18,
        currentTarget: 18,
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
        objectiveKind: 'ev_soc',
        deviceType: 'onoff',
        targets: [],
        // `deviceClass` is the producer's ONLY charger evidence
        // (`isEvObserved` -> `isEvDevice`). The parse boundary always sets it
        // alongside the capability; spelling only the capability here made the
        // fixture rely on a test-helper heuristic broader than production.
        deviceClass: 'evcharger',
        binaryCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        binaryControl: { on: false },
        controllable: true,
        available: true,
      },
      planDevice: {
        id: 'ev-1',
        name: 'Driveway EV',
        objectiveKind: 'ev_soc',
        currentState: 'off',
        plannedState: 'shed',
        deviceClass: 'evcharger',
        binaryCapabilityId: 'evcharger_charging',
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

  // Regression: a turn_off shed leaves the setpoint at the mode target, so the
  // setpoint-gap test reads a device PELS has switched off as fully satisfied
  // and every counter gated on `unmetDemand` records nothing. In production that
  // zeroed the daily-budget loop's evidence for five days while thermostats sat
  // off for hours, and the loop decayed through a day that overshot by 2 kWh.
  it('counts a turn_off shed below target as unmet demand and a hold below target', () => {
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
    const offShed: DevicePlanDevice = buildPlanDevice({
      id: 'heater-1',
      name: 'Hall Heater',
      deviceClass: 'thermostat',
      currentState: 'off',
      plannedState: 'shed',
      shedAction: 'turn_off',
      // The setpoint never moved — that is the whole point.
      currentTarget: 18,
      plannedTarget: 18,
      reason: r('shed due to capacity'),
      controllable: true,
      available: true,
      currentTemperature: 16,
      expectedPowerKw: 1.14,
    });

    expect(buildObservation({
      inputDevice,
      planDevice: offShed,
      desiredForMode: { 'heater-1': 18 },
    })).toMatchObject({
      pelsHoldsBelowTarget: true,
      unmetDemand: true,
      // Still false: the SETPOINT gap really is zero. The producer-resolved
      // hold signal is what carries the shed; `targetDeficitMs` keeps meaning
      // what its name says.
      targetDeficitActive: false,
    });

    // Off but already at/above target — genuinely satisfied, not held back.
    expect(buildObservation({
      inputDevice: { ...inputDevice, currentTemperature: 18.5 },
      planDevice: { ...offShed, currentTemperature: 18.5 },
      desiredForMode: { 'heater-1': 18 },
    })).toMatchObject({ pelsHoldsBelowTarget: false, unmetDemand: false });

    // The user turned it off — PELS is not withholding anything.
    expect(buildObservation({
      inputDevice,
      planDevice: { ...offShed, plannedState: 'keep' },
      desiredForMode: { 'heater-1': 18 },
    })).toMatchObject({ pelsHoldsBelowTarget: false, unmetDemand: false });
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
      currentHourPriceLevel: { cheap: true, expensive: false },
    });

    expect(observation.desiredStateSummary).toBe('24.0C');
    expect(observation.intendedNormalTargetC).toBe(20);
    expect(observation.targetStepC).toBe(0.5);
  });

  it('marks a stale observation as not fresh (observer-sourced) so starvation will not count it', () => {
    // Freshness is sourced from the OBSERVER (the `getObservationStale` dep wired
    // from `ctx.getObservedState`), NOT off a plan-device field. Drive the REAL
    // freshness resolver over an aged `lastFreshDataMs` (not a manual flag): a stale
    // device is still eligible (eligibility ignores freshness) but `observationFresh`
    // is false, which gates it out of starvation counting downstream
    // (`isValidStarvationObservation`). A stale sample is not "confirmed no progress".
    const observation = buildObservation({
      getObservationStale: () => isDeviceObservationStale({
        lastFreshDataMs: Date.now() - STALE_DEVICE_OBSERVATION_MS - 60_000,
      }),
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
        currentState: 'on',
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

    expect(observation.eligibleForStarvation).toBe(true);
    expect(observation.observationFresh).toBe(false);
  });

  it('marks a fresh observation as fresh (observer-sourced) — eligible to count', () => {
    const observation = buildObservation({
      getObservationStale: () => isDeviceObservationStale({ lastFreshDataMs: Date.now() }),
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
        currentState: 'on',
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

    expect(observation.eligibleForStarvation).toBe(true);
    expect(observation.observationFresh).toBe(true);
    expect(observation.suppressionState).toBe('counting');
    expect(observation.countingCause).toBe('capacity');
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
        // A code this build does not know — the whole point of the test. Cast at
        // the boundary rather than routed through the fixture grammar, which now
        // rejects labels it cannot parse into a complete reason.
        reason: { code: 'waiting_for_moon_phase_alignment' } as unknown as DeviceReason,
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
        reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid },
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

  it('normalizes a keep hold as paused and a pending restore as counting', () => {
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

    // A device PELS is commanding in full is not held back by PELS.
    expect(keepObservation.pauseReason).toBe('keep');
    expect(keepObservation.suppressionState).toBe('paused');
    // A device PELS declined to resume this cycle IS held back by PELS — the queue being
    // busy is PELS's own pacing, not the device getting served.
    expect(restoreObservation.countingCause).toBe('restore');
    expect(restoreObservation.suppressionState).toBe('counting');
    expect(restoreObservation.pauseReason).toBeNull();
  });

  it('counts a meter-settling hold — PELS is still the reason the device is off', () => {
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

    expect(observation.countingCause).toBe('cooldown');
    expect(observation.suppressionState).toBe('counting');
    expect(observation.pauseReason).toBeNull();
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
        },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
      softLimitSource: 'daily',
      // No measurement this cycle — the hold exists regardless of the budget.
      fixtureTotalKw: null,
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

  it('counts activation backoff — the retry timer is PELS pacing itself, not service', () => {
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

    expect(observation.countingCause).toBe('activation_backoff');
    expect(observation.suppressionState).toBe('counting');
    expect(observation.pauseReason).toBeNull();
  });

  it('counts a resume PELS throttled', () => {
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
        plannedTarget: 18,
        reason: r('restore throttled'),
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    expect(observation.countingCause).toBe('restore_throttled');
    expect(observation.suppressionState).toBe('counting');
    expect(observation.pauseReason).toBeNull();
  });

  // A startup reservation is bounded (`HEADROOM_RESERVE_MAX_MS`, 15 min) and issues no write,
  // which is why it used to PAUSE the clock. It counts now: the device is off because PELS
  // decided a higher-priority device gets the block first, and boundedness is a property of
  // the mechanism, not something the held device experiences. Note the reserve's ceiling is
  // exactly the starvation entry delay, so a maximally long reservation sits right at the
  // `Held back` boundary — deliberate, and recorded in
  // `notes/deferred-load-objectives/preemptive-power-reservation.md`.
  it('counts a hold on another device\'s startup reservation, named as its own cause', () => {
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
        plannedState: 'shed',
        currentTarget: 18,
        plannedTarget: 18,
        reason: { code: PLAN_REASON_CODES.reservedForStart, targetName: 'Car charger' },
        controllable: true,
        available: true,
        currentTemperature: 18,
      },
      desiredForMode: { 'heater-1': 21 },
    });

    // Its own cause, not folded into `capacity` — device detail must be able to say the
    // device is waiting on a reservation rather than on the hard cap.
    expect(observation.countingCause).toBe('reserved_for_start');
    expect(observation.suppressionState).toBe('counting');
    expect(observation.pauseReason).toBeNull();
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

    // Feed the REAL producer's output across many rebuild cycles. The restore
    // producer alternates `insufficient_headroom` and `daily_budget` for the same
    // daily-bound hold; the re-attribution keeps the GRANULAR counting cause
    // steady on `daily_budget`, which is what device detail and the
    // `device_starvation_*` logs report. (The overview's flat budget/capacity
    // bucket that used to flip with it — taking the rescue button with it — was
    // deleted 2026-08-04; the overview now carries no cause to flip.)
    const start = Date.now();
    const seenCountingCauses = new Set<string | null>();
    for (const offset of [0, 9, 16, 25, 40, 55]) {
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [buildSteadyDailyHeadroomObservation()],
      });
      const summary = service.getUiPayload().diagnosticsByDeviceId['heater-1']?.starvation;
      if (summary?.isStarved) seenCountingCauses.add(summary.starvationCause);
    }

    expect([...seenCountingCauses]).toEqual(['daily_budget']);
    expect(service.getOverviewStarvation('heater-1')).toMatchObject({ isStarved: true });

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
      reason: { code: PLAN_REASON_CODES.dailyBudget },
      controllable: true,
      available: true,
      currentTemperature: 18,
    },
    desiredForMode: { 'heater-1': 21 },
    softLimitSource: 'daily',
  });

  it('holds a stable counting cause while the plan reason oscillates dailyBudget <-> insufficient_headroom', () => {
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

    // Alternate the two budget-family reasons across rebuilds. The granular
    // counting cause must never leave `daily_budget` — that is the regression
    // guard the re-attribution exists for, and it still feeds device detail and
    // the starvation logs.
    const start = Date.now();
    const seenCountingCauses = new Set<string | null>();
    const offsets = [0, 9, 16, 25, 40, 55];
    offsets.forEach((offset, index) => {
      const observation = index % 2 === 0
        ? buildSteadyDailyHeadroomObservation()
        : buildDailyBudgetHoldObservation();
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [observation],
      });
      const summary = service.getUiPayload().diagnosticsByDeviceId['heater-1']?.starvation;
      if (summary?.isStarved) seenCountingCauses.add(summary.starvationCause);
    });

    expect([...seenCountingCauses]).toEqual(['daily_budget']);
    expect(service.getOverviewStarvation('heater-1')).toMatchObject({ isStarved: true });
    service.destroy();
  });
});

// The 2026-08-08 rule (`notes/starvation/README.md`): the clock runs whenever PELS is the
// reason the device is down. A restore cooldown used to PAUSE it, which is what let a
// device cycling between a capacity hold and its 60 s cooldown look like it was being
// served. Driven through the real producer + the real episode tracker, because the point of
// the change is what the two do together over time.
describe('a device held under a restore cooldown accumulates held-back time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createService = () => {
    const store = new Map<string, unknown>();
    const settings = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    return new DeviceDiagnosticsService({
      diagnosticsStateStore: createDeviceDiagnosticsStateStore({ settings } as never),
      getTimeZone: () => 'Europe/Oslo',
      isDebugEnabled: () => false,
    });
  };

  // Mode target 21, PELS commands 18 and is sitting out its restore cooldown.
  const buildRestoreCooldownObservation = () => buildObservation({
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
      plannedTarget: 18,
      reason: r('cooldown (restore, 45s remaining)'),
      controllable: true,
      available: true,
      currentTemperature: 18,
    },
    desiredForMode: { 'heater-1': 21 },
  });

  it('enters held-back after the entry delay and attributes the time to the cooldown', () => {
    const service = createService();
    const start = Date.now();

    for (const offset of [0, 9, 16, 25]) {
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [buildRestoreCooldownObservation()],
      });
    }

    const starvation = service.getUiPayload().diagnosticsByDeviceId['heater-1']?.starvation;
    expect(starvation?.isStarved).toBe(true);
    // 1 min from entry (t15) to t16, plus the t16→t25 span.
    expect(starvation?.starvedAccumulatedMs).toBe(10 * 60 * 1000);
    expect(starvation?.starvationCause).toBe('cooldown');
    expect(starvation?.starvationPauseReason).toBeNull();
    service.destroy();
  });

  // The guard on the wider rescue offer: counting is not the gate, the 15-minute entry delay
  // is. A device inside an ordinary 60 s cooldown is nowhere near "Held back", so it is not
  // in the rescuable list and its card grows no "Let it run now" chip.
  it('does not offer a rescue for a device merely inside its cooldown', () => {
    const service = createService();
    const start = Date.now();

    for (const offset of [0, 1, 2]) {
      service.observePlanSample({
        nowTs: start + offset * 60 * 1000,
        observations: [buildRestoreCooldownObservation()],
      });
    }

    expect(service.getUiPayload().diagnosticsByDeviceId['heater-1']?.starvation.isStarved).toBe(false);
    expect(service.getOverviewStarvation('heater-1')).toBeNull();
    service.destroy();
  });
});

/**
 * The producer and the persisted counters, joined.
 *
 * The five-day production blackout lived exactly in this seam: the observation
 * builder said "no setpoint gap", the diagnostics service believed it, and every
 * counter gated on `unmetDemand` read zero while devices sat off for hours.
 * Asserting each half separately is what let that pass review, so this drives
 * the REAL producer into the REAL service and reads the persisted day totals.
 */
describe('turn_off shed reaches the persisted demand counters', () => {
  const TZ = 'Europe/Oslo';
  const noonToday = (): number => (
    getDateKeyStartMs(getDateKeyInTimeZone(new Date(), TZ), TZ) + (12 * 60 * 60 * 1000)
  );

  const createService = () => {
    const store = new Map<string, unknown>();
    const settings = { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) };
    return new DeviceDiagnosticsService({
      diagnosticsStateStore: createDeviceDiagnosticsStateStore({ settings } as never),
      getTimeZone: () => TZ,
      isDebugEnabled: () => false,
      structuredLog: { info: () => {}, error: () => {} } as never,
      debugStructured: () => {},
    });
  };

  it('records blocked time for a device PELS switched off below its target', () => {
    const observation = buildObservation({
      inputDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        managed: true,
        controllable: true,
        available: true,
        currentTemperature: 16,
        targets: [{ id: 'target_temperature', value: 18, unit: 'C', step: 0.5 }],
      },
      planDevice: {
        id: 'heater-1',
        name: 'Hall Heater',
        deviceClass: 'thermostat',
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'turn_off',
        // The setpoint never moved — the shape the old evidence could not see.
        currentTarget: 18,
        plannedTarget: 18,
        reason: r('shed due to daily budget'),
        controllable: true,
        available: true,
        currentTemperature: 16,
        expectedPowerKw: 1.14,
      },
      desiredForMode: { 'heater-1': 18 },
      softLimitSource: 'daily',
    });

    const service = createService();
    const start = noonToday();
    // Every 5 min for an hour: wider spans than the 10-minute cap are skipped.
    for (let minute = 0; minute <= 60; minute += 5) {
      service.observePlanSample({ nowTs: start + (minute * 60 * 1000), observations: [observation] });
    }

    const totals = service.getDaySuppressionTotals(getDateKeyInTimeZone(new Date(start), TZ));
    // The hour of off-shed lands on `blockedByHeadroomMs` — the counter that
    // read exactly zero for this shape during the production blackout.
    expect(totals?.blockedByHeadroomMs).toBe(60 * 60 * 1000);
    // The setpoint-gap counter stays zero: the setpoint really never moved.
    expect(totals?.targetDeficitMs ?? 0).toBe(0);
  });
});
