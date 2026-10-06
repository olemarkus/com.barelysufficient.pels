import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import { hasPlanExecutionDriftAgainstIntent } from '../../lib/executor/executorConvergence';
import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import { DeviceConfigurationStore } from '../../lib/device/deviceConfiguration';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { hasPlanDeviceExecutionDrift } from '../../lib/executor/planExecutionDrift';
import { splitPlanInputDevice } from '../utils/driftObservationTestUtils';
import type { DriftCommandRead } from '../../lib/executor/driftObservedDevice';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';
import { buildPlanMeta, resolveFixtureCurrentOn } from '../utils/planTestUtils';
import {
  asOutputDevice,
  buildBinaryDevice,
  buildEvDevice,
  buildPlan,
  buildSteppedDevice,
  inputDevice,
  steppedProfile,
  type LooseInputDevice,
  type LooseOutputDevice,
} from '../utils/planConvergenceFixtures';
import { noStorageTransport } from '../helpers/storageTransportStub';

// The executor's in-flight binary command is passed alongside the observed
// device, not folded into it: it belongs to a different layer and does not ride
// on the plan-input seam. Defaults to "nothing in flight", which is what a spec
// that issues no command means.
const hasPlanExecutionDriftForDevice = (
  plan: DevicePlan,
  liveDevices: PlanInputDevice[],
  deviceId: string,
  binaryCommand: DriftCommandRead['binary'] = { kind: 'none' },
): boolean => {
  const planDevice = plan.devices.find((device) => device.id === deviceId);
  const live = liveDevices.find((device) => device.id === deviceId);
  if (!planDevice || !live) return false;
  return hasPlanDeviceExecutionDrift({ planDevice, ...splitPlanInputDevice(live, binaryCommand) });
};

describe('executorConvergence stepped device drift', () => {
  it('finds release work in an empty plan without requiring a live device', () => {
    const intent = { deviceId: 'battery', reason: 'not_admissible' as const };
    const hasStorageReleaseDrift = vi.fn(() => true);
    expect(hasPlanExecutionDriftAgainstIntent({ ...buildPlan([]), storageReleases: [intent] }, {
      getObservedState: () => undefined,
      getCommandState: () => ({ binary: { kind: 'none' }, step: { kind: 'none' } }),
      isExternalOffHeld: () => false,
      hasStorageDrift: () => false,
      hasStorageReleaseDrift,
    })).toBe(true);
    expect(hasStorageReleaseDrift).toHaveBeenCalledWith(intent);
  });
  describe('hasPlanExecutionDriftForDevice', () => {
    it('treats a keep device that is still observed off as drift even if the stored snapshot is stale', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat target-only keep devices as binary drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        binaryCapabilityId: undefined,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('still detects target drift for target-only keep devices', () => {
      const plan = buildPlan([buildBinaryDevice({
        deviceType: 'temperature',
        currentState: 'not_applicable',
        plannedState: 'keep',
        binaryCapabilityId: undefined,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat target divergence as drift while a matching target command is still pending', () => {
      // Symmetric with the binary dampener: without it a stale observation would
      // re-fire drift every cycle until the circuit breaker tripped. (This used
      // to be load-bearing on its own, because `targetExecutor` reconcile mode
      // bypassed pending-target retry suppression; that bypass died with the
      // mode, so the two now agree rather than one covering for the other.)
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'not_applicable',
        plannedState: 'keep',
        binaryCapabilityId: undefined,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        pendingTargetCommand: {
          desired: 21,
          retryCount: 0,
          nextRetryAtMs: 0,
          status: 'waiting_confirmation',
        },
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('treats a mismatched pending target command as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        deviceType: 'temperature',
        currentState: 'not_applicable',
        plannedState: 'keep',
        binaryCapabilityId: undefined,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        pendingTargetCommand: {
          desired: 18,
          retryCount: 0,
          nextRetryAtMs: 0,
          status: 'waiting_confirmation',
        },
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat a keep device as drift while a matching binary command is still pending', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'dev-2', { kind: 'pending', desired: true },
      )).toBe(false);
    });

    it('treats a mismatched pending binary command as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'dev-2', { kind: 'pending', desired: false },
      )).toBe(true);
    });

    it('treats fresh off binary state as keep-plan drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('treats paused EV state as drift when a deadline resume is expected', () => {
      const plan = buildPlan([buildEvDevice()]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'ev-1',
        name: 'EV Charger',
        // The charger identity device configuration resolves from class
        // `evcharger`: the plug-state gate reads it, never the binary axis.
        isEvCharger: true,
        binaryControl: { on: false },
        binaryCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        targets: [],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(true);
    });

    it('dampens EV deadline resume drift while the matching binary command is pending', () => {
      const plan = buildPlan([buildEvDevice()]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'ev-1',
        name: 'EV Charger',
        // The charger identity device configuration resolves from class
        // `evcharger`: the plug-state gate reads it, never the binary axis.
        isEvCharger: true,
        binaryControl: { on: true },
        binaryCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_paused',
        targets: [],
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'ev-1', { kind: 'pending', desired: true },
      )).toBe(false);
    });

    it('treats charging EV state as drift when a deadline pause is expected', () => {
      const plan = buildPlan([buildEvDevice({
        evChargingState: 'plugged_in_charging',
        deferredReleaseIntent: 'binary_release',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'ev-1',
        name: 'EV Charger',
        // The charger identity device configuration resolves from class
        // `evcharger`: the plug-state gate reads it, never the binary axis.
        isEvCharger: true,
        binaryControl: { on: true },
        binaryCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
        targets: [],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'ev-1')).toBe(true);
    });

    it('dampens EV deadline pause drift while the matching binary command is pending', () => {
      const plan = buildPlan([buildEvDevice({
        evChargingState: 'plugged_in_charging',
        deferredReleaseIntent: 'binary_release',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'ev-1',
        name: 'EV Charger',
        // The charger identity device configuration resolves from class
        // `evcharger`: the plug-state gate reads it, never the binary axis.
        isEvCharger: true,
        binaryControl: { on: true },
        binaryCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
        targets: [],
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'ev-1', { kind: 'pending', desired: false },
      )).toBe(false);
    });

    it('does not treat capacity-control-off keep state as drift without executor restore context', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
        controllable: false,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        controllable: false,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('still detects drift against a stale live binary observation — observer data wins over planner data', () => {
      // Drift compares what we asked for against what observer reports. Even a
      // stale observation is the device's most recently observed (possibly
      // outdated) state; suppressing drift on staleness would hide a real
      // divergence. Re-actuating against the drift is idempotent, so the worst
      // case is a redundant command.
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        // Stale observation still counts as evidence — `binaryControlObservation`
        // is present, just old; the live off-read drives drift against the plan's on.
        binaryControlObservation: buildBinaryObservation('onoff', false),
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('detects binary drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', false),
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('detects step drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('reports no drift when stepped device state matches', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat restore preparation at low with pending confirmation as binary drift', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'low',
        binaryCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', false),
        stepCommandPending: true,
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'dev-1', { kind: 'pending', desired: true },
      )).toBe(false);
    });

    it('does not treat full-shed step preparation as binary drift before low is confirmed', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'max',
        desiredStepId: 'off',
        binaryCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        stepCommandPending: true,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    // Was 'does not let a stale off-step identity mask fresh binary on drift',
    // asserting TRUE. It passed for a fixture-only reason: `inputDevice` stamps
    // `currentOn` only when `binaryCapabilityId` is set, this fixture omits it,
    // so the old drift path fell through to the RAW binary axis and read 'on'.
    // Production cannot produce that shape — `toPlanDevice` stamps `currentOn`
    // whenever `binaryControl` exists and strips `binaryControl` — so the real
    // drift path always folded, always answered 'off', and never reported this
    // as drift. The test pinned an invariant the app did not hold.
    //
    // The fold is also the right answer: a stepped device parked at its off rung
    // IS off, even with its switch still armed (`lib/observer/AGENTS.md`). A
    // device that is genuinely still drawing shows it on the STEP axis, by
    // reporting a non-off rung — which the case below covers.
    it('folds an armed binary axis at the off rung to off, matching the shed intent', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'off',
        desiredStepId: 'off',
        binaryCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', true),
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('reports drift when the device attests a rung above the shed target', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'turn_off',
        selectedStepId: 'off',
        desiredStepId: 'off',
        binaryCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        // The device's OWN report, and the only evidence that separates "shed
        // succeeded" from "still drawing" once the binary axis stays armed.
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', true),
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('treats restore preparation as drift when the pending step jumps to an unexpected value', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'keep',
        selectedStepId: 'off',
        desiredStepId: 'low',
        binaryCapabilityId: 'onoff',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        stepCommandPending: true,
      })];

      expect(hasPlanExecutionDriftForDevice(
        plan, liveDevices, 'dev-1', { kind: 'pending', desired: 'unknown' },
      )).toBe(true);
    });

    it('does not force stepped set_step shedding to look binary-off when the device is correctly on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('ignores target drift for stepped set_step shedding but still checks binary state', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [{ id: 'target_temperature', value: 23, unit: '°C' }],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        binaryControlObservation: buildBinaryObservation('onoff', true),
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
      expect(hasPlanExecutionDriftForDevice(
        plan,
        [inputDevice({ ...liveDevices[0], binaryControl: { on: false }, binaryControlObservation: buildBinaryObservation('onoff', false) })],
        'dev-1',
      )).toBe(true);
    });

    it('does not treat stepped set_step shedding as drift when the stored snapshot is stale off but the live device is on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat fresh off binary state as drift for shed-off intent', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    // These two guard against the predicate OVER-reporting. It now gates whether a
    // rebuild actuates (`maybeApplyPlanChanges`), so a false positive means writing
    // to a device on every power report — the device-command hysteresis failure mode.
    // Both cases used to be pinned at the PlanService level through the reconcile
    // lane; the predicate is their real owner.
    // REGRESSION (Codex review, P0): an already-shed stepped load that raises
    // ITSELF one rung must still be seen as work outstanding.
    //
    // The deleted reconcile lane caught this because it compared the COMMITTED
    // plan's `selectedStepId` ('low') against the live step ('max'). The rebuild
    // lane cannot: the fresh plan copies the live step into `selectedStepId`, so
    // comparing the two is comparing a value against itself. With
    // `plannedState: 'shed'` also disqualifying `hasStableSteppedLoadStepActuation`
    // and the action signature excluding `selectedStepId`, every gate reads false
    // and the device stays above its planned shed step — over the cap, which is
    // the failure class this whole train exists to remove.
    it('treats a shed device sitting above its desired step as drift', () => {
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step',
        // What the rebuild produces: current = the live step, desired = the shed target.
        currentState: 'on',
        selectedStepId: 'max',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('does not treat a shed device already at its desired step as drift', () => {
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step',
        currentState: 'on',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat a power-only change as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
        currentTarget: 20,
        currentTemperature: 20,
        plannedTarget: 20,
        expectedPowerKw: 1,
        currentDrawKw: 1,
      })]);
      // Same binary state and same target; only the power readings moved. Power is
      // not a control axis, so there is nothing for the executor to converge.
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: true },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        expectedPowerKw: 2,
        currentDrawKw: 2,
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('does not treat a target-only change as drift while a shed device is already off', () => {
      // A `turn_off` shed settles on the binary axis alone. The setpoint the device
      // reports while off is irrelevant, so a target change must not re-fire the shed.
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'turn_off',
        currentTarget: 20,
        currentTemperature: 20,
        plannedTarget: 20,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        binaryCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 17, unit: '°C' }],
      })];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });
  });

});

// ---------------------------------------------------------------------------
// Group 4: expected binary state for stepped turn_off / turn_on
// Tests probe expected-binary-state logic indirectly through drift detection.
// hasPlanExecutionDriftForDevice returns true when the live state does not
// match the expected binary state derived from the plan.
// ---------------------------------------------------------------------------

describe('expected binary state for stepped turn_off / turn_on (Group 4)', () => {
  const buildSteppedShedDevice = (
    overrides: LooseOutputDevice = {},
  ): DevicePlan['devices'][number] => {
    const merged = {
      id: 'dev-1',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'shed' as const,
      controllable: true,
      binaryCapabilityId: 'onoff' as const,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      desiredStepId: 'low',
      shedAction: 'turn_off' as const,
      ...overrides,
    };
    return asOutputDevice({ ...merged, currentOn: resolveFixtureCurrentOn(merged) });
  };

  const buildKeepDevice = (
    overrides: LooseOutputDevice = {},
  ): DevicePlan['devices'][number] => {
    const merged = {
      id: 'dev-1',
      name: 'Tank',
      currentState: 'off',
      plannedState: 'keep' as const,
      controllable: true,
      binaryCapabilityId: 'onoff' as const,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      desiredStepId: 'low',
      ...overrides,
    };
    return asOutputDevice({ ...merged, currentOn: resolveFixtureCurrentOn(merged) });
  };

  const buildLiveInput = (
    overrides: LooseInputDevice = {},
  ): PlanInputDevice => {
    const merged = {
      id: 'dev-1',
      name: 'Tank',
      targets: [],
      binaryControl: { on: true },
      controlModel: 'stepped_load' as const,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      ...overrides,
    };
    // Group 4 covers the binary-state side of stepped drift detection. Each
    // case toggles `currentOn` to model an observed binary value, so default
    // a matching `binaryControlObservation` unless an override supplies one.
    return inputDevice(
      merged.binaryControlObservation
        ? merged
        : { ...merged, binaryControlObservation: buildBinaryObservation('onoff', merged.binaryControl?.on) },
    );
  };

  const buildPlanWith = (device: DevicePlan['devices'][number]): DevicePlan => ({
    meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
    devices: [device],
    storageReleases: [],
  });

  // Test 4.1: stepped turn_off shed → expected binary state is always 'off'.
  // Detected as drift when live state is 'on'; no drift when live state is 'off'.
  it('expectedBinaryState is off for stepped turn_off shed (detected via drift)', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({ shedAction: 'turn_off', selectedStepId: 'low' }));

    // Live currentOn=true → current state is 'on' → differs from expected 'off' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=false → current state is 'off' → matches expected 'off' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });

  // Test 4.2: stepped keep (turn_on intent) → expected binary state is always 'on'.
  // Detected as drift when live state is 'off'; no drift when live state is 'on'.
  it('expectedBinaryState is on for stepped keep (turn_on intent), detected via drift', () => {
    const plan = buildPlanWith(buildKeepDevice({ currentState: 'off', selectedStepId: 'low' }));

    // Live currentOn=false → current state is 'off' → differs from expected 'on' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=true → current state is 'on' → matches expected 'on' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });

  // Test 4.4 / Regression 5.3: for set_step shed, expected binary state follows the
  // desired step: 'off' when at off-step, 'on' when at non-off step.
  // Critically, turn_off must NOT route through this set_step logic — it must always
  // resolve to 'off' directly.
  it('set_step shed expectedBinaryState is on for non-off step, off for off step', () => {
    // set_step shed at non-off step → expected 'on'
    const setStepAtLow = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));
    // Live currentOn=true (step at 'low', non-off) → liveCurrentState='on' → no drift
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
    // Live currentOn=false (step at 'low', non-off) → liveCurrentState='off' → drift
    // (expected='on' from set_step at non-off, live='off')
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // set_step shed at off-step → expected 'off'.
    // Note: for stepped devices, resolveCurrentOn (lib/observer/observedState.ts) resolves 'off' for
    // the off-step regardless of currentOn, so both currentOn=true and currentOn=false
    // produce liveCurrentState='off' when selectedStepId='off'. Binary drift cannot
    // be triggered by toggling currentOn alone at the off-step.
    // Instead, test that step drift is detected when selectedStepId changes.
    const setStepAtOff = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));
    // Live at off-step with binary off → no drift (expected='off', live='off')
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: 'off' })], 'dev-1'))
      .toBe(false);
    // Live step changed to 'low' → step drift (live selectedStepId ≠ previous selectedStepId)
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);
  });

  it('does not infer set_step shed binary drift when the requested step is missing', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'set_step',
      selectedStepId: undefined,
      desiredStepId: undefined,
    }));

    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: false }, selectedStepId: undefined })], 'dev-1'))
      .toBe(false);
  });

  // Regression 5.3 — ASSERTION INVERTED, deliberately. It used to read "a
  // `turn_off` shed with a non-off `desiredStepId` still expects binary off",
  // because that combination could not be a real decision: the planner named no
  // step, materialization answered the off step for every `turn_off` device, and
  // a non-off desired step on a shed device was therefore incoherent.
  //
  // It is a real production state now. `turn_off` is the FLOOR, and the planner
  // may park the device at a rung above it; when it does, `plannedShedStepId`
  // names that rung and the decided end state is `step`. Demanding binary off
  // for such a device would converge onto a state the plan did not decide — the
  // whole load cut for a shed that chose to leave it running lower.
  //
  // The un-inverted half is test 4.1: the same device with NO rung decision
  // still expects binary off.
  it('a turn_off device parked at a rung expects no binary state, so being on is not drift', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'turn_off',
      selectedStepId: 'low',
      desiredStepId: 'low',
      // The decision that makes the non-off desired step coherent.
      plannedShedStepId: 'low',
    }));

    // Live currentOn=true → the device is running at its decided rung, which is
    // where the plan wants it. No binary axis is demanded, so no drift.
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ binaryControl: { on: true }, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });
});

/**
 * Drift through the executor's OWN reads: `PlanExecutor.driftObservationDeps()`,
 * which joins the device-configuration identity (`isEvCharger`) with the Observer
 * record (`readExecutorDevice`), instead of a fixture-built observation. The
 * devices are raw Homey reads parsed by the real transport, configured by the
 * real `DeviceConfigurationStore`, and observed through the real Observer
 * projection, the way `createPlanEngine` wires the executor.
 *
 * A planned binary restore is drift only while the device is off AND can be
 * commanded. An unplugged charger cannot be, but only a read that knows it is a
 * charger asks its plug state: read off the bare Observer record, every charger
 * was "not a charger", and its restore drifted forever.
 */
describe('executor drift through PlanExecutor.driftObservationDeps', () => {
  const noop = (): void => undefined;
  const loggerMock: Logger = {
    log: noop,
    error: noop,
    structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
  };
  // Homey dates every capability value it reports.
  const lastUpdated = new Date().toISOString();

  // Nothing here says "charger" but the class.
  const unpluggedCharger: HomeyDeviceLike = {
    id: 'ev-1',
    name: 'Driveway charger',
    class: 'evcharger',
    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
    capabilitiesObj: {
      evcharger_charging: { value: false, setable: true, lastUpdated },
      evcharger_charging_state: { value: 'plugged_out', lastUpdated },
      measure_power: { value: 0, lastUpdated },
    },
    available: true,
    ready: true,
  };

  const offSocket: HomeyDeviceLike = {
    id: 'socket-1',
    name: 'Garage socket',
    class: 'socket',
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: {
      onoff: { value: false, setable: true, lastUpdated },
      measure_power: { value: 0, lastUpdated },
    },
    available: true,
    ready: true,
  };

  const buildExecutor = (): PlanExecutor => {
    const parsed = createTestDeviceTransport(
      mockHomeyInstance as unknown as Homey.App,
      loggerMock,
      { getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }) },
    ).parseDeviceListForTests([unpluggedCharger, offSocket]);
    const configuration = new DeviceConfigurationStore();
    configuration.replace(parsed);
    const observedById = new Map(parsed.map((snapshot) => [snapshot.id, projectObservedState(snapshot)]));
    const state = createPlanEngineState();
    const deps: PlanExecutorDeps = {
      getHomeDisplayName: () => 'Main home',
      homeId: 'main',
      setCapacityInShortfall: vi.fn(),
      persistLastControlledMs: vi.fn(),
      getDeviceConfiguration: (deviceId) => configuration.get(deviceId),
      getDeviceConfigurations: () => configuration.getAll(),
      getObservationRevision: () => 0,
      getObservedState: (deviceId) => observedById.get(deviceId),
      actuator: createDeviceActuator({
        canTurnOnDevice: () => true,
        resolveTemperatureTarget: (_deviceId, desired) => desired,
        requestBinaryControl: vi.fn(async () => undefined),
        requestTemperatureTarget: async (_deviceId, desired) => desired,
        requestSteppedLoadStep: vi.fn(async () => ({ requested: true, transport: 'native_capability' as const })),
        ...noStorageTransport,
      }),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 10, marginKw: 0, periodMinutes: 60 }),
      getPowerTracker: () => ({}),
      getCapacityPaceKw: () => 9.5,
      getShortfallThresholdKw: () => 0,
      getCapacityDryRun: () => false,
      getOperatingMode: () => 'Home',
      getShedBehavior: () => ({ action: 'turn_off' as const }),
      markSteppedLoadDesiredStepIssued: vi.fn(),
      getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false, stepCommandPending: false }),
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      storageLane: { kind: 'none' },
    };
    return new PlanExecutor(deps, state);
  };

  // The same planned restore for either device; only the device differs. The
  // plan carries no target, so any drift reported is the binary axis.
  const restorePlanFor = (device: { id: string; name: string; binaryCapabilityId: string; isEvCharger: boolean }) => (
    buildPlan([buildBinaryDevice({
      ...device,
      currentState: 'off',
      plannedState: 'keep',
      plannedTarget: undefined,
      deferredReleaseIntent: 'binary_restore',
    })])
  );

  it('reads the charger identity from configuration and its plug state from the Observer', () => {
    const observed = buildExecutor().driftObservationDeps().getObservedState('ev-1');
    expect(observed).toMatchObject({ id: 'ev-1', isEvCharger: true, evChargingState: 'plugged_out' });
  });

  it('reports no drift for a planned restore of an unplugged charger', () => {
    const plan = restorePlanFor({
      id: 'ev-1', name: 'Driveway charger', binaryCapabilityId: 'evcharger_charging', isEvCharger: true,
    });
    expect(hasPlanExecutionDriftAgainstIntent(plan, buildExecutor().driftObservationDeps())).toBe(false);
  });

  it('reports drift for the same planned restore of a plain on/off device observed off', () => {
    const plan = restorePlanFor({
      id: 'socket-1', name: 'Garage socket', binaryCapabilityId: 'onoff', isEvCharger: false,
    });
    expect(hasPlanExecutionDriftAgainstIntent(plan, buildExecutor().driftObservationDeps())).toBe(true);
  });
});
