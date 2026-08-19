/**
 * Flow-boundary integration coverage for flow-backed stepped-load
 * restore-from-off ordering ("Elbillader" Easee EV charger, 1-phase
 * target-power stepping).
 *
 * Easee resets its temporary current limit when a charging session starts.
 * Therefore a step confirmed while OFF is not durable activation evidence:
 * the executor must issue binary ON first and always reassert the desired step
 * immediately afterwards. A fast OFF/reset echo must reapply the step without
 * issuing a second toggle-style binary ON.
 *
 * That suppression is gone as of 2026-07-25: a non-off flow report while the
 * binary axis reads off is admitted as observed evidence, so the confirmation
 * now rides the ordinary report path rather than a while-off special case. The
 * deliverable assertion below is unchanged — this spec still guards the
 * restore-from-off deadlock.
 *
 * This spec drives the REAL pipeline around that loop: the real
 * `AppDeviceControlHelpers` (pending desired-step runtime state + snapshot
 * decoration — where the bug lives), the real snapshot parser
 * (`parseDevice`), and the real executor pipeline (PlanExecutor →
 * executable-plan projection → steppedLoadExecutor → binary dispatch). The
 * ONLY mocks are the Homey SDK seams: the mock device/deviceManager and the
 * flow trigger card; the user's flow is simulated by calling the real report
 * entry point with the step the trigger commanded.
 *
 * Deliverable assertions: binary ON reaches the SDK boundary before the step
 * Flow trigger; the post-activation step is sent even when the pre-activation
 * report already matches; and an OFF/32 A reset reissues only the step.
 *
 * Invariant guard: the report becomes observed evidence, but the binary axis
 * still owns the on/off fold — `binaryControl.on` stays false, so a non-off
 * observed step never resurrects a charger PELS has turned off. The stepped
 * shed-release dispatch path is unaffected: it runs only for devices with NO
 * binary control capability (`!snapshot.binaryCapabilityId` in
 * `shedReleaseActuation`), and this charger has `evcharger_charging`.
 */
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { AppDeviceControlHelpers } from '../../setup/appDeviceControlHelpers';
import {
  parseDevice,
  isDevicePowerCapable,
  type DeviceTransportParseDeps,
} from '../../lib/device/transport/managerParseDevice';
import { DeviceMeasuredPowerResolver } from '../../lib/device/measuredPowerResolver';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../../lib/utils/types';

const KEEP_REASON = fixtureDeviceReason('keep')!;
const DEVICE_ID = 'easee-1';
const DEVICE_NAME = 'Elbillader';

// The prod 1-phase target-power step ladder (230 V × amps), lowest step 6 A.
const EV_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '8a', planningPowerW: 1840 },
  ],
};
const PROFILES: DeviceControlProfiles = { [DEVICE_ID]: EV_PROFILE };

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
  }),
  getCapabilityObj: (device) => (device.capabilitiesObj ?? {}) as never,
  isPowerCapable: (device, capsStatus, measuredPower, powerEstimate) =>
        isDevicePowerCapable({ device, capsStatus, measuredPower, powerEstimate }),
  resolveLatestLocalWriteMs: () => undefined,
});

// An Easee-style charger: official `evcharger_charging` control capability
// (trusted off), NOT a Zaptec native-wiring candidate, and no native stepped
// capability — the stepped axis is purely flow-backed via the stored profile.
const buildEaseeDevice = (freshIso: string, charging = false): HomeyDeviceLike => {
  const capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> = {
    measure_power: { value: charging ? 1_380 : 0, lastUpdated: freshIso },
    evcharger_charging: { value: charging, setable: true, lastUpdated: freshIso },
    // Prod state while PELS holds the charger paused: car connected, waiting.
    evcharger_charging_state: {
      value: charging ? 'plugged_in_charging' : 'plugged_in_paused',
      lastUpdated: freshIso,
    },
  };
  return {
    id: DEVICE_ID,
    name: DEVICE_NAME,
    class: 'evcharger',
    driverId: 'homey:app:no.easee:charger',
    ownerUri: 'homey:app:no.easee',
    capabilities: ['measure_power', 'evcharger_charging', 'evcharger_charging_state'],
    capabilitiesObj,
    available: true,
    ready: true,
  };
};

const parseEaseeSnapshot = (params: {
  freshIso: string;
  nowMs: number;
  logger: Logger;
  charging?: boolean;
}): TransportDeviceSnapshot => {
  const parsed = parseDevice({
    device: buildEaseeDevice(params.freshIso, params.charging),
    now: params.nowMs,
    deps: buildParseDeps(params.logger),
  });
  if (!parsed) throw new Error('parseDevice returned null for the Easee mock device');
  return parsed;
};

// Plan device mirroring what the real plan carries after decoration: the
// planner wants the charger kept ON at the lowest step ('6a') from off, and the
// pending step-command cluster rides in from the decorated snapshot.
const buildRestoreTo6aPlan = (
  decorated: DecoratedDeviceSnapshot,
  profile: SteppedLoadProfile = EV_PROFILE,
): DevicePlan => ({
  meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
  devices: [
    withBinaryDiscriminant({
      ...steppedPlanDevice({
        id: DEVICE_ID,
        name: DEVICE_NAME,
        deviceClass: 'evcharger',
        currentState: 'off',
        plannedState: 'keep',
        controllable: true,
        steppedLoadProfile: profile,
        binaryCapabilityId: 'evcharger_charging',
        selectedStepId: decorated.selectedStepId ?? '6a',
        desiredStepId: '6a',
        lastDesiredStepId: '6a',
        lastStepCommandIssuedAt: decorated.lastStepCommandIssuedAt,
        stepCommandRetryCount: decorated.stepCommandRetryCount,
        nextStepCommandRetryAtMs: decorated.nextStepCommandRetryAtMs,
        stepCommandPending: decorated.stepCommandPending,
        stepCommandStatus: decorated.stepCommandStatus,
        reason: KEEP_REASON,
      }),
      binaryControl: { on: false },
    }),
  ],
});

const buildRunningTo8aPlan = (decorated: DecoratedDeviceSnapshot): DevicePlan => ({
  meta: buildPlanMeta({ totalKw: 1.38, softLimitKw: 5, headroomKw: 3.62}),
  devices: [
    withBinaryDiscriminant({
      ...steppedPlanDevice({
        id: DEVICE_ID,
        name: DEVICE_NAME,
        deviceClass: 'evcharger',
        currentState: 'on',
        plannedState: 'keep',
        controllable: true,
        steppedLoadProfile: EV_PROFILE,
        binaryCapabilityId: 'evcharger_charging',
        reportedStepId: decorated.reportedStepId,
        selectedStepId: decorated.selectedStepId ?? '6a',
        desiredStepId: '8a',
        lastDesiredStepId: decorated.desiredStepId,
        lastStepCommandIssuedAt: decorated.lastStepCommandIssuedAt,
        stepCommandRetryCount: decorated.stepCommandRetryCount,
        nextStepCommandRetryAtMs: decorated.nextStepCommandRetryAtMs,
        stepCommandPending: decorated.stepCommandPending,
        stepCommandStatus: decorated.stepCommandStatus,
        reason: KEEP_REASON,
      }),
      binaryControl: { on: true },
    }),
  ],
});

// ── Executor harness with the REAL control helper in the loop ────────────────
const buildHarness = (
  initialSnapshot: TransportDeviceSnapshot,
  profiles: DeviceControlProfiles = PROFILES,
) => {
  const snapshotHolder: { current: TransportDeviceSnapshot } = { current: initialSnapshot };
  const structuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const helpers = new AppDeviceControlHelpers({
    getProfiles: () => profiles,
    getDeviceSnapshots: () => [snapshotHolder.current],
    getLatestPlanSnapshot: () => null,
    getStructuredLogger: () => structuredLogger as never,
    debugStructured: vi.fn(),
  });

  const decorate = (): DecoratedDeviceSnapshot => {
    const [decorated] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    return decorated;
  };

  const triggerCards = {
    desired_stepped_load_changed: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_on_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_off_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_start_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_stop_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
  } as const;
  const state = createPlanEngineState();
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn(() => [decorate()]),
    setCapability: vi.fn().mockResolvedValue(undefined),
    // Flow-only transport: no native stepped adapter is registered, so every
    // step command goes out as the `desired_stepped_load_changed` trigger —
    // exactly the prod Elbillader path.
    requestSteppedLoadStep: vi.fn(async (params: {
      deviceId: string;
      desiredStepId: string;
      planningPowerW: number;
      planningCurrentA: number;
      previousStepId?: string;
    }) => {
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

  const deps: PlanExecutorDeps = {
    getHomeDisplayName: () => 'Main home',
    homeId: 'main',
    setCapacityInShortfall: vi.fn(),
    persistLastControlledMs: vi.fn(),
    deviceManager: deviceManager as never,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    actuator: createDeviceActuator({
      resolveTemperatureTarget: (_deviceId, desired) => desired,
      requestBinaryControl: async (deviceId, desired) => {
        await deviceManager.setCapability(deviceId, 'evcharger_charging', desired);
        return undefined;
      },
      requestTemperatureTarget: async (_deviceId, desired) => desired,
      requestSteppedLoadStep: (params) => deviceManager.requestSteppedLoadStep(params),
    }),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getPowerTracker: () => ({}),
    getCapacityPaceKw: () => 9.5,
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const }),
    // REAL pending-command bookkeeping: the executor's step command lands in the
    // helper's runtime state, decoration surfaces it as
    // stepCommandPending/stepCommandStatus, and the flow report has to confirm
    // it — the loop under test.
    markSteppedLoadDesiredStepIssued: (params) => helpers.markSteppedLoadDesiredStepIssued(params),
    getSteppedLoadCommandSession: (deviceId) => helpers.getSteppedLoadCommandSession(deviceId),
    logTargetRetryComparison: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  };
  return {
    executor: new PlanExecutor(deps, state),
    deviceManager,
    helpers,
    decorate,
    setSnapshot: (snapshot: TransportDeviceSnapshot) => {
      snapshotHolder.current = snapshot;
    },
    desiredSteppedTrigger: triggerCards.desired_stepped_load_changed,
  };
};

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => {
  logCapture.restore();
  vi.useRealTimers();
});

describe('flow-backed stepped restore-from-off — binary activation before step reassertion', () => {
  it('initializes an unknown running level once, then ramps higher without an echo', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-29T08:00:00.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({
      freshIso: cycle1Iso,
      nowMs: cycle1Ms,
      logger,
      charging: true,
    });
    expect(snapshot.binaryControl?.on).toBe(true);
    expect(snapshot.reportedStepId).toBeUndefined();

    const {
      executor, helpers, decorate, setSnapshot, desiredSteppedTrigger,
    } = buildHarness(snapshot);

    await executor.applyPlanActions(buildRunningTo8aPlan(decorate()));

    expect(desiredSteppedTrigger.trigger).toHaveBeenNthCalledWith(1, {
      step_id: '6a',
      planning_power_w: 1380,
      planning_current_a: 0,
      previous_step_id: '',
    }, { deviceId: DEVICE_ID });
    const afterInitialization = decorate();
    expect(afterInitialization).toMatchObject({
      reportedStepId: undefined,
      selectedStepId: '6a',
      stepCommandPending: false,
      stepCommandStatus: 'idle',
    });
    expect(helpers.getSteppedLoadCommandSession(DEVICE_ID)).toMatchObject({
      initializationAssumedStepId: '6a',
      hasPriorStepCommand: true,
    });

    // No flow report arrives. The accepted initialization is a one-shot
    // command-axis premise, so the next eligible cycle may issue the real ramp.
    vi.setSystemTime(cycle1Ms + 10_000);
    await executor.applyPlanActions(buildRunningTo8aPlan(decorate()));

    expect(desiredSteppedTrigger.trigger).toHaveBeenNthCalledWith(2, {
      step_id: '8a',
      planning_power_w: 1840,
      planning_current_a: 0,
      previous_step_id: '6a',
    }, { deviceId: DEVICE_ID });
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(2);
    expect(decorate()).toMatchObject({
      reportedStepId: undefined,
      selectedStepId: '6a',
      desiredStepId: '8a',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    });

    // The charger then stops without ever reporting a level. The observed off
    // ends the command session; a later unknown-level on-session must begin at
    // the lowest step again instead of retrying the previous 8a command.
    const offMs = cycle1Ms + 20_000;
    setSnapshot(parseEaseeSnapshot({
      freshIso: new Date(offMs).toISOString(),
      nowMs: offMs,
      logger,
      charging: false,
    }));
    vi.setSystemTime(offMs);
    expect(decorate()).toMatchObject({
      reportedStepId: undefined,
      desiredStepId: undefined,
    });

    const turnedOnAgainMs = cycle1Ms + 30_000;
    setSnapshot(parseEaseeSnapshot({
      freshIso: new Date(turnedOnAgainMs).toISOString(),
      nowMs: turnedOnAgainMs,
      logger,
      charging: true,
    }));
    vi.setSystemTime(turnedOnAgainMs);
    await executor.applyPlanActions(buildRunningTo8aPlan(decorate()));

    expect(desiredSteppedTrigger.trigger).toHaveBeenNthCalledWith(3, {
      step_id: '6a',
      planning_power_w: 1380,
      planning_current_a: 0,
      previous_step_id: '',
    }, { deviceId: DEVICE_ID });
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(3);
  });

  it('dispatches evcharger_charging=true before requesting the post-activation 6a step', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });

    // Pin the prod-observed parsed state: trusted-off binary via
    // evcharger_charging, no native stepped wiring, flow-backed profile only.
    expect(snapshot.binaryControl?.on).toBe(false);
    expect(snapshot.binaryCapabilityId).toBe('evcharger_charging');
    expect(snapshot.reportedStepId).toBeUndefined();

    const {
      executor, deviceManager, helpers, decorate, desiredSteppedTrigger,
    } = buildHarness(snapshot);

    // Restore admission activates the binary axis first, then requests the
    // desired current in the same executor cycle.
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()));

    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        step_id: '6a',
        planning_power_w: 1380,
        previous_step_id: '6a',
      }),
      { deviceId: DEVICE_ID },
    );
    expect(deviceManager.setCapability.mock.invocationCallOrder[0])
      .toBeLessThan(desiredSteppedTrigger.trigger.mock.invocationCallOrder[0]!);
    const afterCommand = decorate();
    expect(afterCommand.stepCommandPending).toBe(true);

    // Before either command has echoed back, a rebuild must suppress both a
    // duplicate binary ON and a duplicate step Flow request.
    vi.setSystemTime(cycle1Ms + 10_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()));
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(1);

    // The user's Flow reports the applied post-activation current through the
    // real feedback entry point.
    vi.setSystemTime(cycle1Ms + 26_000);
    helpers.reportSteppedLoadActualStep(DEVICE_ID, '6a');

    // The report is real telemetry and becomes observed evidence even though the
    // charger is off (prod 2026-07-25: blanking it hid an Easee that had reverted
    // to 32 A). The binary axis still owns the on/off fold, so the charger stays off.
    const afterReport = decorate();
    expect(afterReport.reportedStepId).toBe('6a');
    expect(afterReport.binaryControl?.on).toBe(false);
    // The report IS the flow-transport confirmation of the pending command.
    // On the buggy base the report was dropped wholesale: the command stayed
    // pending until it expired stale and the restore looped forever.
    expect(afterReport.stepCommandStatus).toBe('success');
    expect(afterReport.stepCommandPending).toBe(false);

    // While Homey's binary echo still reads OFF, the recent binary-restore
    // dampener prevents another toggle-style ON. Confirmed 6a also prevents a
    // duplicate post-activation Flow request.
    vi.setSystemTime(cycle1Ms + 35_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()));

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'recent_binary_restore_attempt',
      deviceId: DEVICE_ID,
    }));
  });

  it('reasserts 6a after binary ON even when the charger already reported 6a while off', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });
    const {
      executor, deviceManager, helpers, decorate, desiredSteppedTrigger,
    } = buildHarness(snapshot);

    helpers.reportSteppedLoadActualStep(DEVICE_ID, '6a');
    expect(decorate()).toMatchObject({
      reportedStepId: '6a',
      stepCommandPending: false,
      stepCommandStatus: 'idle',
    });
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()));

    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: '6a' }),
      { deviceId: DEVICE_ID },
    );
    // A same-value post-activation reassertion must not turn an already
    // materialized report into pending/stale when the vendor emits no change.
    expect(decorate()).toMatchObject({
      reportedStepId: '6a',
      stepCommandPending: false,
      stepCommandStatus: 'idle',
    });
  });

  it('reapplies 6a without a second binary ON when activation resets the off report to 32a', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const resetProfile: SteppedLoadProfile = {
      ...EV_PROFILE,
      steps: [...EV_PROFILE.steps, { id: '32a', planningPowerW: 7360 }],
    };
    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });
    const {
      executor, deviceManager, helpers, decorate, desiredSteppedTrigger,
    } = buildHarness(snapshot, { [DEVICE_ID]: resetProfile });

    helpers.reportSteppedLoadActualStep(DEVICE_ID, '6a');
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate(), resetProfile));
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(1);

    // Easee starts a session, resets its current while the delayed binary echo
    // still reads OFF, and reports that real 32a state.
    vi.setSystemTime(cycle1Ms + 5_000);
    helpers.reportSteppedLoadActualStep(DEVICE_ID, '32a');

    const afterReport = decorate();
    expect(afterReport.reportedStepId).toBe('32a');
    expect(afterReport.stepCommandPending).toBe(false);

    vi.setSystemTime(cycle1Ms + 6_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate(), resetProfile));

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(desiredSteppedTrigger.trigger).toHaveBeenNthCalledWith(2, {
      step_id: '6a',
      planning_power_w: 1380,
      planning_current_a: 0,
      previous_step_id: '32a',
    }, { deviceId: DEVICE_ID });

    vi.setSystemTime(cycle1Ms + 30_000);
    helpers.reportSteppedLoadActualStep(DEVICE_ID, '6a');
    expect(decorate()).toMatchObject({
      reportedStepId: '6a',
      stepCommandPending: false,
      stepCommandStatus: 'success',
    });
  });
});
