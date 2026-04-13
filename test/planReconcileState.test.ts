import type { DevicePlan } from '../lib/plan/planTypes';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import {
  hasPlanExecutionDrift,
  hasPlanExecutionDriftForDevice,
  buildLiveStatePlan,
} from '../lib/plan/planReconcileState';

const steppedProfile = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const buildSteppedDevice = (
  overrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan['devices'][number] => ({
  id: 'dev-1',
  name: 'Tank',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: null,
  plannedTarget: null,
  controllable: true,
  controlModel: 'stepped_load',
  steppedLoadProfile: steppedProfile,
  selectedStepId: 'low',
  desiredStepId: 'low',
  ...overrides,
});

const buildBinaryDevice = (
  overrides: Partial<DevicePlan['devices'][number]> = {},
): DevicePlan['devices'][number] => ({
  id: 'dev-2',
  name: 'Heater',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: 21,
  plannedTarget: 21,
  controllable: true,
  ...overrides,
});

const buildPlan = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
  devices,
});

describe('planReconcileState stepped device drift', () => {
  describe('hasPlanExecutionDrift', () => {
    it('detects step drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ selectedStepId: 'max' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('detects binary (onoff) drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'low' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('detects combined step and binary drift for a stepped device', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'max' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });

    it('reports no drift when both step and binary state match', () => {
      const previous = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const live = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(false);
    });

    it('still detects binary drift for non-stepped devices', () => {
      const previous = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const live = buildPlan([buildBinaryDevice({ currentState: 'off' })]);

      expect(hasPlanExecutionDrift(previous, live)).toBe(true);
    });
  });

  describe('hasPlanExecutionDriftForDevice', () => {
    it('treats a keep device that is still observed off as drift even if the stored snapshot is stale', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat a keep device as drift while a matching binary command is still pending', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        binaryCommandPending: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('treats fresh off binary state as keep-plan drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(true);
    });

    it('does not treat stale live binary observations as drift', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'keep',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        observationStale: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });

    it('detects binary drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: false,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('detects step drift for a stepped device via live input', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(true);
    });

    it('reports no drift when stepped device state matches', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not force stepped set_step shedding to look binary-off when the device is correctly on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat stepped set_step shedding as drift when the stored snapshot is stale off but the live device is on at the shed step', () => {
      const plan = buildPlan([buildSteppedDevice({
        currentState: 'off',
        plannedState: 'shed',
        shedAction: 'set_step',
        selectedStepId: 'low',
        desiredStepId: 'low',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'low',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-1')).toBe(false);
    });

    it('does not treat fresh off binary state as drift for shed-off intent', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'on',
        plannedState: 'shed',
        shedAction: 'turn_off',
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      expect(hasPlanExecutionDriftForDevice(plan, liveDevices, 'dev-2')).toBe(false);
    });
  });

  describe('buildLiveStatePlan', () => {
    it('merges live binary state into stepped device plan', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'on', selectedStepId: 'low' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: false,
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
      expect(result.devices[0].selectedStepId).toBe('max');
    });

    it('keeps stepped off-step classification consistent with initial planning even when currentOn is true', () => {
      const plan = buildPlan([buildSteppedDevice({ currentState: 'off', selectedStepId: 'off' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('off');
    });

    it('treats stale live binary observations as unknown in the merged plan', () => {
      const plan = buildPlan([buildBinaryDevice({ currentState: 'on' })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        observationStale: true,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].currentState).toBe('unknown');
      expect(result.devices[0].observationStale).toBe(true);
    });

    it('refreshes binaryCommandPending from live state so cleared pending does not stick', () => {
      const plan = buildPlan([buildBinaryDevice({
        currentState: 'off',
        binaryCommandPending: true,
      })]);
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-2',
        name: 'Heater',
        currentOn: false,
        hasBinaryControl: true,
        binaryCommandPending: false,
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: false,
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: true,
        selectedStepId: 'max',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

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
      const liveDevices: PlanInputDevice[] = [{
        id: 'dev-1',
        name: 'Tank',
        currentOn: false,
        selectedStepId: 'off',
        targets: [],
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      }];

      const result = buildLiveStatePlan(plan, liveDevices);

      expect(result.devices[0].desiredStepId).toBe('low');
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
    overrides: Partial<DevicePlan['devices'][number]> = {},
  ): DevicePlan['devices'][number] => ({
    id: 'dev-1',
    name: 'Tank',
    currentState: 'on',
    plannedState: 'shed',
    currentTarget: null,
    plannedTarget: null,
    controllable: true,
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    desiredStepId: 'low',
    shedAction: 'turn_off',
    ...overrides,
  });

  const buildKeepDevice = (
    overrides: Partial<DevicePlan['devices'][number]> = {},
  ): DevicePlan['devices'][number] => ({
    id: 'dev-1',
    name: 'Tank',
    currentState: 'off',
    plannedState: 'keep',
    currentTarget: null,
    plannedTarget: null,
    controllable: true,
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    desiredStepId: 'low',
    ...overrides,
  });

  const buildLiveInput = (
    overrides: Partial<PlanInputDevice> = {},
  ): PlanInputDevice => ({
    id: 'dev-1',
    name: 'Tank',
    targets: [],
    currentOn: true,
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    ...overrides,
  });

  const buildPlanWith = (device: DevicePlan['devices'][number]): DevicePlan => ({
    meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
    devices: [device],
  });

  // Test 4.1: stepped turn_off shed → expected binary state is always 'off'.
  // Detected as drift when live state is 'on'; no drift when live state is 'off'.
  it('expectedBinaryState is off for stepped turn_off shed (detected via drift)', () => {
    const plan = buildPlanWith(buildSteppedShedDevice({ shedAction: 'turn_off', selectedStepId: 'low' }));

    // Live currentOn=true → current state is 'on' → differs from expected 'off' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: true, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=false → current state is 'off' → matches expected 'off' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: false, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });

  // Test 4.2: stepped keep (turn_on intent) → expected binary state is always 'on'.
  // Detected as drift when live state is 'off'; no drift when live state is 'on'.
  it('expectedBinaryState is on for stepped keep (turn_on intent), detected via drift', () => {
    const plan = buildPlanWith(buildKeepDevice({ currentState: 'off', selectedStepId: 'low' }));

    // Live currentOn=false → current state is 'off' → differs from expected 'on' → drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: false, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // Live currentOn=true → current state is 'on' → matches expected 'on' → no binary drift
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: true, selectedStepId: 'low' })], 'dev-1'))
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
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ currentOn: true, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
    // Live currentOn=false (step at 'low', non-off) → liveCurrentState='off' → drift
    // (expected='on' from set_step at non-off, live='off')
    expect(hasPlanExecutionDriftForDevice(setStepAtLow, [buildLiveInput({ currentOn: false, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);

    // set_step shed at off-step → expected 'off'.
    // Note: for stepped devices, resolveSteppedLoadCurrentState returns 'off' for
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
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ currentOn: false, selectedStepId: 'off' })], 'dev-1'))
      .toBe(false);
    // Live step changed to 'low' → step drift (live selectedStepId ≠ previous selectedStepId)
    expect(hasPlanExecutionDriftForDevice(setStepAtOff, [buildLiveInput({ currentOn: true, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);
  });

  // Regression 5.3: turn_off shed with a non-off desiredStepId must still resolve to
  // expected binary state 'off' — it must never be contaminated by the set_step logic
  // that would return 'on' for a non-off desiredStep.
  it('turn_off shed is never treated as set_step for expected binary state: always resolves to off', () => {
    // Device has turn_off but desiredStepId is 'low' (non-off). If the code accidentally
    // routed this through resolveSteppedShedBinaryState, it would return 'on'. It must not.
    const plan = buildPlanWith(buildSteppedShedDevice({
      shedAction: 'turn_off',
      selectedStepId: 'low',
      desiredStepId: 'low', // non-off desiredStep — must not contaminate the 'off' result
    }));

    // Expected binary is 'off' for turn_off regardless of desiredStepId.
    // Live currentOn=true → drift (expected='off', observed='on')
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: true, selectedStepId: 'low' })], 'dev-1'))
      .toBe(true);
    // Live currentOn=false → no drift (expected='off', observed='off')
    expect(hasPlanExecutionDriftForDevice(plan, [buildLiveInput({ currentOn: false, selectedStepId: 'low' })], 'dev-1'))
      .toBe(false);
  });
});
