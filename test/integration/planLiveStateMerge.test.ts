import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { buildLiveStatePlan } from '../../lib/plan/planLiveStateMerge';
import {
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDrift,
} from '../../lib/executor/executorConvergence';
import {
  buildBinaryDevice,
  buildPlan,
  buildSteppedDevice,
  inputDevice,
  steppedProfile,
} from '../utils/planConvergenceFixtures';

describe('planLiveStateMerge', () => {
  describe('buildLiveStatePlan', () => {
    // A merge must not treat missing data as a reset. The producer resolves
    // `available` / `controllable` to a boolean, so an absent value on the LIVE
    // input means "the live snapshot says nothing about this" — not "true".
    // Collapsing it here (`live.available !== false`) silently made an
    // explicitly-unavailable device available, and an unmanaged device managed,
    // on any cycle whose live snapshot omitted the field.
    it('keeps a prior false availability when the live snapshot omits it', () => {
      const plan = buildPlan([buildBinaryDevice({ available: false, controllable: false })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: true },
        controlCapabilityId: 'onoff',
        targets: [],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].available).toBe(false);
      expect(result.devices[0].controllable).toBe(false);
    });

    it('takes an explicitly reported live availability over the prior value', () => {
      const plan = buildPlan([buildBinaryDevice({ available: false })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: true },
        controlCapabilityId: 'onoff',
        targets: [],
        available: true,
      })];

      expect(buildLiveStatePlan(plan, liveDevices).devices[0].available).toBe(true);
    });

    it('merges live binary state into stepped device plan', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('clears stale reported step evidence when live stepped state only has fallback evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        // Fallback-only live state: no reported step, selectedStepId is the
        // planning fallback.
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'low',
        reportedStepId: undefined,
      }));
    });

    it('treats cleared step evidence as refresh-worthy even when selected step and binary state match', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
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

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(hasPlanExecutionDrift(plan, result)).toBe(true);
      expect(canRefreshPlanSnapshotFromLiveState(plan, result)).toBe(true);
    });

    it('preserves effective step while clearing stale evidence when live lacks step evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // No live step evidence at all → reported cleared, but the previous
      // effective step is preserved as the fallback.
      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'low',
        reportedStepId: undefined,
      }));
    });

    it('keeps fresh reported live step evidence when it replaces older plan evidence', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        selectedStepId: 'low',
        reportedStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        reportedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0]).toEqual(expect.objectContaining({
        selectedStepId: 'max',
        reportedStepId: 'max',
      }));
    });

    it('keeps stepped off-step classification consistent with initial planning even when currentOn is true', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'off' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('recomputes currentOn from the merged stepped profile when live binary state lacks the profile', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        currentOn: false,
        selectedStepId: 'off',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        currentOn: true,
        controlCapabilityId: 'onoff',
        selectedStepId: 'off',
        targets: [],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // `binaryControl` no longer rides on the reconciled plan device; `currentOn`
      // is recombined from the binary signal + the preserved (merged) stepped
      // profile, so the 'off' step folds in even though the live snapshot lacked
      // the profile and reported `currentOn: true`.
      expect(result.devices[0]).toEqual(expect.objectContaining({
        currentOn: false,
        currentState: 'off',
        selectedStepId: 'off',
      }));
    });

    it('merges a stale live binary observation to its latched off label (trusts currentOn, not unknown)', () => {
      // The reconcile merge recomputes the label from the producer-resolved
      // `currentOn` (the latched on/off truth) and no longer re-applies staleness:
      // a confirmed-off live binary device merges to 'off', not 'unknown'. Homey
      // reports capabilities on change, so the latched off IS the trusted state.
      const plan = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('refreshes binaryCommandPending from live state so cleared pending does not stick', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        binaryCommandPending: true,
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-2',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryCommandPending: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].binaryCommandPending).toBe(false);
    });

    it('clamps desiredStepId to the live selectedStepId when a shed device has jumped past its planned target', () => {
      // Previous plan: stepping the device from max down to low (set_step shed, mid-cascade)
      // desiredStepId='low' was the next intermediate target, selectedStepId='max' was the confirmed position
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step' as const,
        currentState: 'on',
        selectedStepId: 'max',
        desiredStepId: 'low',
      })]);
      // Live: device jumped directly to 'off' (past the 'low' target — hardware overshoot or external control)
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // The stale desiredStepId='low' must be clamped to 'off'.
      // Without the fix: desiredStepId stays 'low' while selectedStepId='off',
      // which causes the executor to fire a step-UP restore command for a shed device.
      expect(result.devices[0].desiredStepId).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('off');
      expect(result.devices[0].plannedState).toBe('shed');
    });

    it('does not clamp desiredStepId when the device has not yet reached the planned target', () => {
      // Plan: stepping down from max to low — device is still at max (normal in-progress step-down)
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'shed',
        shedAction: 'set_step' as const,
        currentState: 'on',
        selectedStepId: 'max',
        desiredStepId: 'low',
      })]);
      // Live: device is still at max (has not moved yet)
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: true },
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      // desiredStepId must stay 'low' — the step-DOWN command should still be issued
      expect(result.devices[0].desiredStepId).toBe('low');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('does not clamp desiredStepId for keep devices', () => {
      // A keep device can legitimately have desiredStepId pointing somewhere different from selectedStepId
      const plan = buildPlan([buildSteppedDevice({
        plannedState: 'keep',
        currentState: 'off',
        selectedStepId: 'off',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [inputDevice({
        id: 'dev-1',
        name: 'Tank',
        binaryControl: { on: false },
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].desiredStepId).toBe('low');
    });
  });
});
