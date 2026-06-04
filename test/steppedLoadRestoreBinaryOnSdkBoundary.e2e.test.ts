/**
 * SDK-boundary e2e: drives the REAL PELS executor pipeline (PlanExecutor →
 * executable-plan projection → steppedLoadExecutor → binary-control dispatch)
 * and the REAL device-snapshot parser (`parseDevice`). The ONLY mock is the
 * Homey SDK device boundary: the mock `deviceManager` whose `getSnapshot`
 * returns the snapshot produced by the real `parseDevice` from a mock Homey
 * device, whose `setCapability` is a spy, and whose `requestSteppedLoadStep`
 * delegates to the real `setObservedNativeSteppedLoadStep`.
 *
 * Guards against the prod bug fixed in 04e668ea: a Høiax stepped-load water
 * heater that a deferred objective wants restored to step 'low' got its
 * `max_power_*` step written but NEVER received the binary `onoff -> true`
 * command, so it stayed at 0 kW. The correct behaviour (asserted here, and
 * restored by the fix) is that a binary `onoff=true` write reaches the SDK
 * boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../lib/executor/planExecutor';
import { captureLogger, type LoggerCapture } from './utils/loggerCapture';
import { createPlanEngineState } from '../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../lib/actuator/deviceActuator';
import {
  observeNativeSteppedLoadCommandAdapter,
  setObservedNativeSteppedLoadStep,
} from '../lib/device/managerNativeSteppedCommand';
import {
  parseDevice,
  isDevicePowerCapable,
  type DeviceTransportParseDeps,
} from '../lib/device/transport/managerParseDevice';
import { DeviceMeasuredPowerResolver } from '../lib/device/measuredPowerResolver';
import { CONNECTED_200_STEPPED_LOAD_PROFILE } from '../lib/device/nativeSteppedLoadWiring';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';
import { withGetSnapshotByDeviceId } from './utils/deviceObservationMock';
import type { DevicePlan } from '../lib/plan/planTypes';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../lib/utils/types';

const KEEP_REASON = legacyDeviceReason('keep')!;
const DEVICE_ID = 'hoiax-1';
const FRESH_ISO = '2026-06-03T12:00:00.000Z';

const createLogger = (): Logger => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}) as unknown as Logger;

// ── REAL parseDevice deps (only the Homey device is a mock) ──────────────────
const buildParseDeps = (logger: Logger): DeviceTransportParseDeps => ({
  logger,
  providers: {
    // Load-bearing: enables the native stepped-load overlay for Høiax devices.
    getNativeEvWiringEnabled: () => true,
  },
  powerState: {
    expectedPowerKwOverrides: {},
    lastKnownPowerKw: {},
    lastEstimateDecisionLogByDevice: new Map(),
    lastPeakPowerLogByDevice: new Map(),
  },
  measuredPowerResolver: new DeviceMeasuredPowerResolver({
    logger,
    lastPositiveMeasuredPowerKw: {},
    minSignificantPowerW: 5,
  }),
  getCapabilityObj: (device) => (device.capabilitiesObj ?? {}) as never,
  isPowerCapable: (device, capsStatus, powerEstimate) =>
    isDevicePowerCapable({ device, capsStatus, powerEstimate }),
  resolveLatestLocalWriteMs: () => undefined,
});

// `absent`        → the real parser yields the OPTIMISTIC `currentOn: true`
//                   with no trusted binary observation (the bug-reproducing
//                   device state, determined empirically — see the report).
// `trusted-off`   → a clean trusted-off observation (`currentOn: false` +
//                   valid binary observation); the bug does NOT reproduce.
type OnoffVariant =
  | { kind: 'absent' }
  | { kind: 'trusted-off' };

const buildHoiaxDevice = (onoff: OnoffVariant): HomeyDeviceLike => {
  const capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> = {
    measure_power: { value: 0, lastUpdated: FRESH_ISO },
    target_temperature: { value: 65, setable: true, lastUpdated: FRESH_ISO },
    measure_temperature: { value: 60, lastUpdated: FRESH_ISO },
    // CONNECTED_200 profile: off(0)/low(700)/medium(1300)/max(2000).
    // Reads 'low_power' → the device is observed already AT step 'low', so the
    // step is materialized and `stepNeedsAdjustment` is false. Only the binary
    // turn-on remains — isolating the binary write from pre-restore step
    // sequencing, so the skip we hit is the `currentOn !== false` early-return
    // in steppedLoadExecutor.applySteppedLoadRestore.
    max_power_2000: { value: 'low_power', setable: true, lastUpdated: FRESH_ISO },
  };
  if (onoff.kind === 'trusted-off') {
    capabilitiesObj.onoff = { value: false, setable: true, lastUpdated: FRESH_ISO };
  }
  // `absent`: capabilitiesObj.onoff is left unset (the capability is still
  // advertised in `capabilities`, so the control capability id is 'onoff').
  return {
    id: DEVICE_ID,
    name: 'Connected 300',
    // Høiax water heaters present to Homey as the supported `heater` class;
    // Høiax detection is by ownerUri/driverUri, not class (must not be evcharger).
    class: 'heater',
    driverId: 'homey:app:no.hoiax:connected200',
    ownerUri: 'homey:app:no.hoiax',
    // `onoff` is always advertised (control capability id resolves to 'onoff');
    // whether capabilitiesObj.onoff is populated is the variable under test.
    capabilities: ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'max_power_2000'],
    capabilitiesObj,
    available: true,
    ready: true,
  };
};

const parseHoiaxSnapshot = (onoff: OnoffVariant, logger: Logger): TargetDeviceSnapshot => {
  const parsed = parseDevice({
    device: buildHoiaxDevice(onoff),
    now: Date.parse(FRESH_ISO) + 1_000,
    deps: buildParseDeps(logger),
  });
  if (!parsed) throw new Error('parseDevice returned null for the Høiax mock device');
  return parsed;
};

// ── The executor harness (mirrors test/integration/planExecutor.test.ts buildExecutor) ───
const buildExecutor = (snapshot: TargetDeviceSnapshot, device: HomeyDeviceLike) => {
  const triggerCards = {
    desired_stepped_load_changed: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_on_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_off_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_start_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_stop_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
  } as const;
  const state = createPlanEngineState();
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue([snapshot]),
    setCapability: vi.fn().mockResolvedValue(undefined),
    requestSteppedLoadStep: vi.fn(async (params: {
      deviceId: string;
      profile: Parameters<typeof setObservedNativeSteppedLoadStep>[0]['profile'];
      desiredStepId: string;
      planningPowerW: number;
      planningCurrentA: number;
      previousStepId?: string;
    }) => {
      const nativeRequested = await setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: params.deviceId,
        profile: params.profile,
        desiredStepId: params.desiredStepId,
        setCapability: (capabilityId, value) =>
          deviceManager.setCapability(params.deviceId, capabilityId, value),
      });
      if (nativeRequested) return { requested: true, transport: 'native_capability' as const };
      const triggerPromise = triggerCards.desired_stepped_load_changed.trigger({
        step_id: params.desiredStepId,
        planning_power_w: params.planningPowerW,
        planning_current_a: params.planningCurrentA,
        previous_step_id: params.previousStepId ?? '',
      }, { deviceId: params.deviceId });
      void Promise.resolve(triggerPromise);
      return { requested: true, transport: 'flow' as const };
    }),
  });

  // Register the native stepped-load command adapter on the mock deviceManager
  // (the executor delegates step writes to it via requestSteppedLoadStep).
  observeNativeSteppedLoadCommandAdapter({
    owner: deviceManager,
    deviceId: DEVICE_ID,
    device,
    clearWhenUnavailable: true,
  });

  const deps: PlanExecutorDeps = {
    homey: {
      settings: { set: vi.fn() },
      flow: {
        getTriggerCard: vi.fn((cardId: keyof typeof triggerCards) => triggerCards[cardId]),
      },
    } as unknown as Homey.App['homey'],
    deviceManager: deviceManager as never,
    // Route step writes through the actuator over the SAME device-manager stepped
    // method, preserving the SDK-boundary behavior this e2e asserts.
    actuator: createDeviceActuator({
      setCapability: (deviceId, capabilityId, value) => deviceManager.setCapability(deviceId, capabilityId, value),
      applyDeviceTargets: async () => undefined,
      triggerFlowBackedBinaryControl: async () => undefined,
      requestSteppedLoadStep: (params) => deviceManager.requestSteppedLoadStep(params),
    }),
    getCapacityGuard: () => undefined,
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const, temperature: null, stepId: null }),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    logTargetRetryComparison: vi.fn(),
    structuredLog: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    debugStructured: vi.fn(),
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  };
  return {
    executor: new PlanExecutor(deps, state),
    deviceManager,
    desiredSteppedTrigger: triggerCards.desired_stepped_load_changed,
  };
};

// A deferred objective wants this kept-on device restored to step 'low' from
// off. Plain DevicePlan — the real executable projection derives the intent.
const buildRestoreToLowPlan = (): DevicePlan => ({
  meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
  devices: [{
    id: DEVICE_ID,
    name: 'Connected 300',
    deviceClass: 'water_heater',
    currentOn: true,
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    controllable: true,
    controlModel: 'stepped_load',
    steppedLoadProfile: CONNECTED_200_STEPPED_LOAD_PROFILE,
    controlCapabilityId: 'onoff',
    // The device is already calibrated at step 'low'; the deferred objective
    // wants it kept on at low. The only outstanding action is the binary
    // turn-on (the device was turned off externally / is physically off).
    selectedStepId: 'low',
    desiredStepId: 'low',
    reason: KEEP_REASON,
  }],
});

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => { logCapture.restore(); });

describe('stepped-load restore binary onoff at the SDK boundary', () => {
  it('emits a binary onoff=true write when restoring a Høiax stepped load to low (bug repro)', async () => {
    const logger = createLogger();
    // The `onoff` capability value is ABSENT, so the real snapshot parser falls
    // back to an OPTIMISTIC `currentOn: true` with NO trusted binary
    // observation. The device is already calibrated at step 'low'.
    const device = buildHoiaxDevice({ kind: 'absent' });
    const snapshot = parseHoiaxSnapshot({ kind: 'absent' }, logger);

    // Pin the real parsed snapshot fields that drive the bug.
    expect(snapshot.currentOn).toBe(true);
    expect(snapshot.binaryControlObservation).toBeUndefined();
    expect(snapshot.controlModel).toBe('stepped_load');
    expect(snapshot.controlCapabilityId).toBe('onoff');
    expect(snapshot.reportedStepId).toBe('low');
    expect(snapshot.flowBacked).toBeUndefined();
    expect(snapshot.steppedLoadProfile?.steps.map((step) => step.id))
      .toEqual(['off', 'low', 'medium', 'max']);

    const { executor, deviceManager } = buildExecutor(snapshot, device);
    await executor.applyPlanActions(buildRestoreToLowPlan(), 'plan');

    // CORRECT behaviour (the deliverable assertion): the binary onoff=true write
    // must reach the SDK boundary so the device actually turns on. On this buggy
    // base it is ABSENT, so this assertion FAILS — that failure IS the repro.
    // (This single cycle mirrors prod's cycle 1: a step-prep write to `low` plus
    // the binary deferred; the optimistic `currentOn:true` is what wrongly keeps
    // the binary skipped on the materialized cycles that follow — see the
    // two-cycle prod-fidelity test for the full stuck sequence.)
    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'onoff', true);
  });

  it('CONTROL: emits a binary onoff=true write with a trusted-off observation', async () => {
    const logger = createLogger();
    // A clean trusted-off observation: `onoff: false` with a fresh timestamp.
    const device = buildHoiaxDevice({ kind: 'trusted-off' });
    const snapshot = parseHoiaxSnapshot({ kind: 'trusted-off' }, logger);

    // Pin the real parsed snapshot fields: the ONLY difference from the repro is
    // the trusted-off binary observation (currentOn:false + binary obs present).
    expect(snapshot.currentOn).toBe(false);
    expect(snapshot.binaryControlObservation).toEqual(expect.objectContaining({
      valid: true,
      capabilityId: 'onoff',
      observedValue: false,
    }));
    expect(snapshot.controlModel).toBe('stepped_load');
    expect(snapshot.controlCapabilityId).toBe('onoff');
    expect(snapshot.canSetControl).toBe(true);
    expect(snapshot.reportedStepId).toBe('low');

    const { executor, deviceManager } = buildExecutor(snapshot, device);
    await executor.applyPlanActions(buildRestoreToLowPlan(), 'plan');

    // With a trusted-off observation the bug does NOT reproduce: the binary
    // onoff=true write DOES reach the boundary on this same base commit. This
    // pins the trigger to the unknown/optimistic observation.
    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'onoff', true);
  });
});
