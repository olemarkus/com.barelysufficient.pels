/**
 * Prod-EXACT-sequence SDK-boundary e2e for the "stepped load never gets binary
 * onoff=true" incident (device "Connected 300", Høiax stepped-load water
 * heater, base 6f44524f; fix 04e668ea).
 *
 * This models the EXACT verified-from-logs prod failure sequence. The
 * load-bearing condition: the `onoff` capability value is ABSENT in the mock
 * Homey device (a should-never-happen anomaly). The REAL parseDevice now
 * honestly resolves `snapshot.binaryControl?.on === false` with NO trusted binary
 * observation (`binaryControlObservation === undefined`, observed binary state
 * 'unknown'). The missing binary observation is the prod trigger: historically
 * the parser fabricated an optimistic `currentOn:true`, and before the fix the
 * executor's restore path read that optimistic currentOn and short-circuited the
 * binary onoff=true dispatch. The executor now keys the defensive turn-on off the
 * 'unknown' binary observation, so the onoff=true write is issued regardless.
 *
 * It drives the REAL executor pipeline (PlanExecutor → executable-plan
 * projection → steppedLoadExecutor → binary-control dispatch) and the REAL
 * snapshot parser (`parseDevice`). The only mock is the Homey SDK device
 * boundary: the mock `deviceManager` whose `getSnapshot` returns the snapshot
 * produced by the real `parseDevice`, whose `setCapability` is a spy, and whose
 * `requestSteppedLoadStep` delegates to the real
 * `setObservedNativeSteppedLoadStep`.
 *
 * The prod sequence, modelled cycle-by-cycle on ONE PlanExecutor instance
 * (PlanEngineState / pendingBinaryCommands / pendingRestores / restore-cooldown
 * preserved across cycles):
 *   - Native wiring ON (Høiax device, getNativeEvWiringEnabled => true,
 *     max_power_2000 native stepped capability).
 *   - Cycle 1: native step reads MAX (max_power_2000 'high_power' →
 *     reportedStepId='max'); plan wants restore to 'low'. EXPECTED: a step-prep
 *     write of the native max_power step reaches the boundary (prod's
 *     max_power_3000=1 write at 20:00:02), binary deferred.
 *   - Between cycles: native step materializes to LOW (max_power_2000
 *     'low_power' → reportedStepId='low'); onoff STAYS ABSENT (currentOn stays the
 *     honest FALSE, binary observation still 'unknown' — the device never actually
 *     turned on). Clock advances ~5 min.
 *   - Cycle 2 + Cycle 3: re-run on the SAME executor with materialized-low and the
 *     still-missing binary observation. The load-bearing prod symptom (before the
 *     fix) was that binary
 *     onoff=true is NEVER issued (prod's 17-min stuck window: restore admitted
 *     every cycle, no turn-on). NOTE: this harness re-issues the native
 *     max_power step each cycle, where prod suppressed it once the device had
 *     confirmed the step — that redundant step write is a harness artifact, not
 *     asserted, and not the bug.
 *
 * The deliverable assertion: across the cycles the binary setCapability(
 * DEVICE_ID, 'onoff', true) must reach the SDK boundary (the device actually
 * turns on). Before the fix (04e668ea) it never did — the device stayed at
 * 0 kW while the objective read on_track. The fix issues a defensive binary-on
 * when the trusted binary observation is 'unknown'; this test guards against
 * that regressing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import {
  observeNativeSteppedLoadCommandAdapter,
  setObservedNativeSteppedLoadStep,
} from '../../lib/device/managerNativeSteppedCommand';
import {
  parseDevice,
  isDevicePowerCapable,
  type DeviceTransportParseDeps,
} from '../../lib/device/transport/managerParseDevice';
import { DeviceMeasuredPowerResolver } from '../../lib/device/measuredPowerResolver';
import { CONNECTED_200_STEPPED_LOAD_PROFILE } from '../../lib/device/nativeSteppedLoadWiring';
import { legacyDeviceReason } from '../utils/deviceReasonTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import type { DevicePlan } from '../../lib/plan/planTypes';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../../lib/utils/types';

const KEEP_REASON = legacyDeviceReason('keep')!;
const DEVICE_ID = 'hoiax-1';

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

// The native `max_power_2000` capability value the device reports. 'high_power'
// → parsed reportedStepId 'max'; 'low_power' → 'low'. onoff is ABSENT in both
// (capability advertised but capabilitiesObj.onoff unset), so the REAL parser
// honestly resolves currentOn:false + NO binaryControlObservation.
const buildHoiaxDevice = (params: { nativeStepValue: unknown; freshIso: string }): HomeyDeviceLike => {
  const { nativeStepValue, freshIso } = params;
  const capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> = {
    measure_power: { value: 0, lastUpdated: freshIso },
    target_temperature: { value: 65, setable: true, lastUpdated: freshIso },
    measure_temperature: { value: 60, lastUpdated: freshIso },
    // Prod-observed trigger: onoff capability VALUE is ABSENT (a
    // should-never-happen anomaly; capabilitiesObj.onoff left unset). The
    // capability is still advertised in `capabilities`, so controlCapabilityId
    // resolves to 'onoff', but the parser has no boolean to trust → currentOn
    // honest false, binaryControlObservation undefined (observed state 'unknown').
    // CONNECTED_200 profile: off(0)/low(700)/medium(1300)/max(2000).
    max_power_2000: { value: nativeStepValue, setable: true, lastUpdated: freshIso },
  };
  return {
    id: DEVICE_ID,
    name: 'Connected 300',
    // Høiax water heaters present to Homey as the `heater` class; Høiax
    // detection is by ownerUri/driverUri, not class.
    class: 'heater',
    driverId: 'homey:app:no.hoiax:connected200',
    ownerUri: 'homey:app:no.hoiax',
    capabilities: ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'max_power_2000'],
    capabilitiesObj,
    available: true,
    ready: true,
  };
};

const parseHoiaxSnapshot = (params: {
  nativeStepValue: unknown;
  freshIso: string;
  nowMs: number;
  logger: Logger;
}): TargetDeviceSnapshot => {
  const parsed = parseDevice({
    device: buildHoiaxDevice({ nativeStepValue: params.nativeStepValue, freshIso: params.freshIso }),
    now: params.nowMs,
    deps: buildParseDeps(params.logger),
  });
  if (!parsed) throw new Error('parseDevice returned null for the Høiax mock device');
  return parsed;
};

// ── The executor harness (mirrors test/planExecutor.test.ts buildExecutor) ───
// `getSnapshot` reads a mutable holder so between-cycle re-parses are visible to
// both `getSnapshot` and `getSnapshotByDeviceId`, matching the live transport.
const buildExecutor = (initialSnapshot: TargetDeviceSnapshot, device: HomeyDeviceLike) => {
  const snapshotHolder: { current: TargetDeviceSnapshot } = { current: initialSnapshot };
  const triggerCards = {
    desired_stepped_load_changed: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_on_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_off_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_start_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_stop_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
  } as const;
  const state = createPlanEngineState();
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn(() => [snapshotHolder.current]),
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
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    // Route step writes through the actuator over the SAME device-manager stepped
    // method, preserving the prod restore behavior this e2e asserts.
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
    snapshotHolder,
    state,
  };
};

// A deferred objective wants this Høiax kept on at step 'low'. The plan device
// mirrors the honestly-parsed snapshot (currentOn:false, no trusted binary
// observation because the onoff readback is absent) and the selected step the
// planner observed this cycle (prod: 'max' first, then 'low' once the native
// step materialized).
const buildRestoreToLowPlan = (selectedStepId: 'max' | 'low'): DevicePlan => ({
  meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
  devices: [{
    id: DEVICE_ID,
    name: 'Connected 300',
    deviceClass: 'water_heater',
    // Honest false — mirrors the parsed snapshot's currentOn:false (the onoff
    // readback is absent, so there is no trusted binary observation; the
    // defensive turn-on keys off the 'unknown' observation, not currentOn).
    binaryControl: { on: false },
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    controllable: true,
    controlModel: 'stepped_load',
    steppedLoadProfile: CONNECTED_200_STEPPED_LOAD_PROFILE,
    controlCapabilityId: 'onoff',
    selectedStepId,
    desiredStepId: 'low',
    reason: KEEP_REASON,
  }],
});

const setCapabilityCallList = (
  deviceManager: { setCapability: ReturnType<typeof vi.fn> },
): unknown[][] => deviceManager.setCapability.mock.calls;

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => {
  logCapture.restore();
  vi.useRealTimers();
});

describe('stepped-load restore binary onoff — prod-EXACT missing-onoff multi-cycle e2e', () => {
  it('eventually writes onoff=true across cycles when restoring a Høiax (max->low, missing-onoff anomaly, native)', async () => {
    const logger = createLogger();

    // Cycle 1 clock + snapshot: native step at MAX, onoff readback ABSENT so the
    // parser honestly resolves currentOn:false with no binary observation. Drive
    // the executor's Date.now() with fake timers from this base.
    const cycle1Iso = '2026-06-03T12:00:00.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const cycle1Snapshot = parseHoiaxSnapshot({
      nativeStepValue: 'high_power',
      freshIso: cycle1Iso,
      nowMs: cycle1Ms + 1_000,
      logger,
    });

    // Pin the prod-observed parsed state (the missing-onoff anomaly is the
    // trigger): currentOn honest false, NO trusted binary observation (observed
    // state 'unknown'), native step at max.
    expect(cycle1Snapshot.binaryControl?.on).toBe(false);
    expect(cycle1Snapshot.binaryControlObservation).toBeUndefined();
    expect(cycle1Snapshot.controlModel).toBe('stepped_load');
    expect(cycle1Snapshot.controlCapabilityId).toBe('onoff');
    expect(cycle1Snapshot.reportedStepId).toBe('max');

    const cycle1Device = buildHoiaxDevice({ nativeStepValue: 'high_power', freshIso: cycle1Iso });
    const { executor, deviceManager, snapshotHolder } = buildExecutor(cycle1Snapshot, cycle1Device);

    // ── CYCLE 1: native step at max, plan wants restore to low. EXPECTED: a
    // max_power_* step-prep write reaches the boundary (prod's max_power_3000=1
    // at 20:00:02), binary deferred behind the pre-restore step gate.
    await executor.applyPlanActions(buildRestoreToLowPlan('max'), 'plan');
    const cycle1Calls = [...setCapabilityCallList(deviceManager)];

    // ── Between cycles: the native step materializes to 'low' (the executor's
    // step write took effect at the device). onoff STAYS ABSENT (the device did
    // NOT turn on — the whole point), so currentOn stays the honest false and the
    // binary observation stays 'unknown'. Advance the clock ~5 minutes past the
    // 60-300s restore cooldown and re-parse via the REAL parseDevice.
    const cycle2Ms = cycle1Ms + 5 * 60 * 1000;
    const cycle2Iso = new Date(cycle2Ms).toISOString();
    vi.setSystemTime(cycle2Ms);
    const cycle2Snapshot = parseHoiaxSnapshot({
      nativeStepValue: 'low_power',
      freshIso: cycle2Iso,
      nowMs: cycle2Ms + 1_000,
      logger,
    });
    // The materialized-low, still-missing-onoff prod state (currentOn honest
    // false, binary observation still absent).
    expect(cycle2Snapshot.binaryControl?.on).toBe(false);
    expect(cycle2Snapshot.binaryControlObservation).toBeUndefined();
    expect(cycle2Snapshot.reportedStepId).toBe('low');
    snapshotHolder.current = cycle2Snapshot;

    await executor.applyPlanActions(buildRestoreToLowPlan('low'), 'plan');

    // ── CYCLE 3: same materialized-low, missing-onoff state, another ~5 min on.
    const cycle3Ms = cycle2Ms + 5 * 60 * 1000;
    const cycle3Iso = new Date(cycle3Ms).toISOString();
    vi.setSystemTime(cycle3Ms);
    const cycle3Snapshot = parseHoiaxSnapshot({
      nativeStepValue: 'low_power',
      freshIso: cycle3Iso,
      nowMs: cycle3Ms + 1_000,
      logger,
    });
    snapshotHolder.current = cycle3Snapshot;

    await executor.applyPlanActions(buildRestoreToLowPlan('low'), 'plan');

    // ── Prod-fidelity structural assertion (true on BOTH base and fix):
    // Cycle 1 produced a max_power_* step-prep write (faithful to prod cycle 1's
    // max_power_3000=1 at 20:00:02). The fix additionally emits its defensive
    // binary-on on cycle 1; the base emits ONLY the step write — both satisfy
    // "cycle 1 wrote the native step".
    expect(cycle1Calls.length).toBeGreaterThan(0);
    expect(cycle1Calls.some((c) => c[0] === DEVICE_ID && c[1] === 'max_power_2000')).toBe(true);

    // ── The deliverable / correct-behaviour assertion: across the cycles the
    // binary onoff=true write must reach the SDK boundary so the device turns
    // on. On the buggy base it NEVER does (the prod stuck window: restore
    // admitted every cycle, no binary) and this FAILS — that failure IS the
    // repro. The fix (04e668ea) issues a defensive binary-on when the trusted
    // onoff observation is 'unknown', so onoff=true reaches the boundary and
    // this PASSES.
    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'onoff', true);
  });
});
