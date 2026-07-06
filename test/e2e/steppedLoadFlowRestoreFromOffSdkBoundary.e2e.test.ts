/**
 * SDK/flow-boundary e2e for the flow-backed stepped-load restore-from-off
 * confirmation deadlock (prod incident 2026-07-05, "Elbillader" Easee EV
 * charger, 1-phase target-power stepping).
 *
 * The verified-from-logs prod sequence:
 *   1. The planner admits a restore off -> '6a'; the executor issues the step
 *      command over the FLOW transport (`desired_stepped_load_changed`,
 *      purpose `prepare_for_on`) and records the pending desired step.
 *   2. The user's flow complies: it sets the charger current and reports the
 *      commanded step back via the `report_stepped_load_power` card (~26 s).
 *   3. `SteppedLoadControlHelper.reportSteppedLoadActualStep` suppressed the
 *      report (`non_off_step_while_off`) BEFORE anything confirmed the pending
 *      command, so the command expired stale, the restore looped
 *      `waiting_confirmation -> stale -> retry_backoff` forever, and the binary
 *      `evcharger_charging=true` write NEVER reached the SDK boundary.
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
 * Deliverable assertion: after the flow confirms the prepared step, the binary
 * `evcharger_charging=true` write reaches the SDK boundary. On the buggy base
 * it never does — that failure IS the reproduction.
 *
 * Invariant guard: the suppressed report must NOT become observed evidence —
 * `reportedStepId` stays unset while the charger is off (a fabricated observed
 * step would revive a dead shed-release path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Homey from 'homey';
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
import { legacyDeviceReason } from '../utils/deviceReasonTestUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { steppedPlanDevice } from '../utils/planTestUtils';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { CapabilityValue, HomeyDeviceLike, Logger } from '../../lib/utils/types';

const KEEP_REASON = legacyDeviceReason('keep')!;
const DEVICE_ID = 'easee-1';
const DEVICE_NAME = 'Elbillader';

// The prod 1-phase target-power step ladder (230 V × amps), lowest step 6 A.
const EV_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
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
    minSignificantPowerW: 5,
  }),
  getCapabilityObj: (device) => (device.capabilitiesObj ?? {}) as never,
  isPowerCapable: (device, capsStatus, powerEstimate) =>
    isDevicePowerCapable({ device, capsStatus, powerEstimate }),
  resolveLatestLocalWriteMs: () => undefined,
});

// An Easee-style charger: official `evcharger_charging` control capability
// (trusted off), NOT a Zaptec native-wiring candidate, and no native stepped
// capability — the stepped axis is purely flow-backed via the stored profile.
const buildEaseeDevice = (freshIso: string): HomeyDeviceLike => {
  const capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> = {
    measure_power: { value: 0, lastUpdated: freshIso },
    evcharger_charging: { value: false, setable: true, lastUpdated: freshIso },
    // Prod state while PELS holds the charger paused: car connected, waiting.
    evcharger_charging_state: { value: 'plugged_in_paused', lastUpdated: freshIso },
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
}): TransportDeviceSnapshot => {
  const parsed = parseDevice({
    device: buildEaseeDevice(params.freshIso),
    now: params.nowMs,
    deps: buildParseDeps(params.logger),
  });
  if (!parsed) throw new Error('parseDevice returned null for the Easee mock device');
  return parsed;
};

// Plan device mirroring what the real plan carries after decoration: the
// planner wants the charger kept ON at the lowest step ('6a') from off, and the
// pending step-command cluster rides in from the decorated snapshot.
const buildRestoreTo6aPlan = (decorated: DecoratedDeviceSnapshot): DevicePlan => ({
  meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
  devices: [
    withBinaryDiscriminant({
      ...steppedPlanDevice({
        id: DEVICE_ID,
        name: DEVICE_NAME,
        deviceClass: 'evcharger',
        currentState: 'off',
        plannedState: 'keep',
        controllable: true,
        steppedLoadProfile: EV_PROFILE,
        controlCapabilityId: 'evcharger_charging',
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

// ── Executor harness with the REAL control helper in the loop ────────────────
const buildHarness = (initialSnapshot: TransportDeviceSnapshot) => {
  const snapshotHolder: { current: TransportDeviceSnapshot } = { current: initialSnapshot };
  const structuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const helpers = new AppDeviceControlHelpers({
    getProfiles: () => PROFILES,
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
    setCapacityInShortfall: vi.fn(),
    persistLastControlledMs: vi.fn(),
    homey: {
      settings: { set: vi.fn() },
      flow: {
        getTriggerCard: vi.fn((cardId: keyof typeof triggerCards) => triggerCards[cardId]),
      },
    } as unknown as Homey.App['homey'],
    deviceManager: deviceManager as never,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
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
    // REAL pending-command bookkeeping: the executor's step command lands in the
    // helper's runtime state, decoration surfaces it as
    // stepCommandPending/stepCommandStatus, and the flow report has to confirm
    // it — the loop under test.
    markSteppedLoadDesiredStepIssued: (params) => helpers.markSteppedLoadDesiredStepIssued(params),
    logTargetRetryComparison: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  };
  return {
    executor: new PlanExecutor(deps, state),
    deviceManager,
    helpers,
    decorate,
    desiredSteppedTrigger: triggerCards.desired_stepped_load_changed,
  };
};

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => {
  logCapture.restore();
  vi.useRealTimers();
});

describe('flow-backed stepped restore-from-off — step confirmation via flow report (prod deadlock repro)', () => {
  it('dispatches evcharger_charging=true after the flow confirms the prepared step', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });

    // Pin the prod-observed parsed state: trusted-off binary via
    // evcharger_charging, no native stepped wiring, flow-backed profile only.
    expect(snapshot.binaryControl?.on).toBe(false);
    expect(snapshot.controlCapabilityId).toBe('evcharger_charging');
    expect(snapshot.reportedStepId).toBeUndefined();

    const {
      executor, deviceManager, helpers, decorate, desiredSteppedTrigger,
    } = buildHarness(snapshot);

    // ── CYCLE 1 (prod 21:09:58Z): restore admitted; the executor issues the
    // step-preparation command over the flow transport and records it pending.
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: '6a', planning_power_w: 1380 }),
      { deviceId: DEVICE_ID },
    );
    const afterCommand = decorate();
    expect(afterCommand.stepCommandPending).toBe(true);
    // The binary turn-on is correctly deferred behind the unconfirmed step.
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);

    // ── The user's flow answers (prod 21:10:24Z, ~26 s): it set the charger
    // current and reports the commanded step back through the REAL entry point.
    vi.setSystemTime(cycle1Ms + 26_000);
    helpers.reportSteppedLoadActualStep(DEVICE_ID, '6a');

    // Invariant: the report is NOT observed running-state evidence while the
    // charger is off — reportedStepId stays unset (real-evidence-only).
    const afterReport = decorate();
    expect(afterReport.reportedStepId).toBeUndefined();
    // The report IS the flow-transport confirmation of the pending command.
    // On the buggy base the report was dropped wholesale: the command stayed
    // pending until it expired stale and the restore looped forever.
    expect(afterReport.stepCommandStatus).toBe('success');
    expect(afterReport.stepCommandPending).toBe(false);

    // ── CYCLE 2 (next plan cycle): with the step confirmed, the executor must
    // proceed to phase two and dispatch the binary turn-on.
    vi.setSystemTime(cycle1Ms + 35_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');

    // Deliverable assertion — the prod deadlock: this write NEVER happened
    // (the charger stayed "Charging paused" indefinitely). The fix makes the
    // confirmed command satisfy the restore-step gate while the device is off.
    expect(deviceManager.setCapability).toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);

    // Exactly ONE step trigger for the whole restore: the go-cycle must not
    // re-fire the already-confirmed preparation (a duplicate would reset the
    // confirmation to pending and — for flows that report only on change —
    // decay it to a phantom 'stale', polluting the flow-health signal).
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('keeps deferring the binary turn-on when the flow never confirms the step', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });
    const { executor, deviceManager, decorate } = buildHarness(snapshot);

    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');
    // No flow report arrives. The next cycle must NOT blind-fire the binary
    // turn-on — the prepared-step gate stays closed without confirmation.
    vi.setSystemTime(cycle1Ms + 35_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);
  });

  it('does not let a non-matching flow report confirm the pending step', async () => {
    const logger = createLogger();
    const cycle1Iso = '2026-07-05T21:09:57.000Z';
    const cycle1Ms = Date.parse(cycle1Iso);
    vi.useFakeTimers();
    vi.setSystemTime(cycle1Ms);

    const snapshot = parseEaseeSnapshot({ freshIso: cycle1Iso, nowMs: cycle1Ms, logger });
    const {
      executor, deviceManager, helpers, decorate,
    } = buildHarness(snapshot);

    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');

    // A contradictory non-off report (wrong step) while off stays fully
    // suppressed: no observed evidence, no confirmation.
    vi.setSystemTime(cycle1Ms + 26_000);
    helpers.reportSteppedLoadActualStep(DEVICE_ID, '8a');

    const afterReport = decorate();
    expect(afterReport.reportedStepId).toBeUndefined();
    expect(afterReport.stepCommandStatus).not.toBe('success');

    vi.setSystemTime(cycle1Ms + 35_000);
    await executor.applyPlanActions(buildRestoreTo6aPlan(decorate()), 'plan');
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith(DEVICE_ID, 'evcharger_charging', true);
  });
});
