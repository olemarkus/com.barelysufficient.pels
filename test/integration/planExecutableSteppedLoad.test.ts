import { describe, expect, it } from 'vitest';
import {
  buildExecutableObservedDeviceState,
} from '../../lib/executor/executablePlanProjection';
import {
  buildExecutableSteppedLoadDevice,
  buildExecutableSteppedLoadIntent,
  resolveSteppedLoadCurrentFallback,
} from '../../lib/executor/executableSteppedLoadProjection';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { steppedPlanDevice } from '../utils/planTestUtils';

const buildObservedState = (
  device: DevicePlanDevice,
  overrides: Partial<TargetDeviceSnapshot> = {},
) => buildExecutableObservedDeviceState({
  id: device.id,
  name: device.name,
  binaryControl: { on: device.binaryControl?.on ?? device.currentState === 'on' },
  targets: [],
  // `controlModel` is a producer setting that legitimately stays on the executor's
  // snapshot input (`TargetDeviceSnapshot`); the plan device no longer carries it,
  // so derive it from profile presence to mirror what the transport producer emits.
  controlModel: device.steppedLoadProfile?.model === 'stepped_load' ? 'stepped_load' : undefined,
  steppedLoadProfile: device.steppedLoadProfile,
  selectedStepId: device.selectedStepId,
  reportedStepId: device.reportedStepId,
  measuredPowerKw: device.measuredPowerKw,
  ...overrides,
});

const buildAction = (
  device: DevicePlanDevice,
  observedOverrides: Partial<TargetDeviceSnapshot> = {},
) => buildExecutableSteppedLoadDevice(
  buildExecutableSteppedLoadIntent(device),
  buildObservedState(device, observedOverrides),
);

describe('planExecutableSteppedLoad', () => {
  it('projects legacy step evidence into executor requested-step materialization', () => {
    const action = buildAction(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reportedStepId: 'low',
    }));

    expect(action).toMatchObject({
      current: {
        on: false,
        stepId: 'low',
      },
      desired: {
        on: true,
        stepId: 'low',
        plannedStepId: 'low',
      },
      previousStepId: 'low',
      transition: {
        effectiveTransition: 'restore_from_off_at_low',
        transitionPhase: 'binary_transition',
      },
      stepActuation: {
        kind: 'requested',
        requestedStepId: 'low',
        materialization: { kind: 'materialized', stepId: 'low', source: 'observed' },
      },
    });
  });

  it('keeps fallback-only step evidence out of executor materialization', () => {
    const action = buildAction(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      // Fallback-only: selectedStepId is the planning fallback, no reported step.
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));

    expect(action?.stepActuation).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'not_materialized', reason: 'fallback_only' },
    });
    expect(action?.commandStepActuation).toEqual(action?.stepActuation);
  });

  it('uses measured power as shed baseline when current stepped position is unknown', () => {
    const action = buildAction(steppedPlanDevice({
      plannedState: 'shed',
      shedAction: 'set_step',
      selectedStepId: undefined,
      desiredStepId: 'low',
      measuredPowerKw: 3,
    }));

    expect(action?.current.stepForShed).toEqual({
      stepId: 'unknown',
      planningPowerW: 3000,
    });
    expect(action?.desired.stepId).toBe('low');
  });

  it('does not project underspecified set_step shed intent without a requested step', () => {
    const intent = buildExecutableSteppedLoadIntent(steppedPlanDevice({
      plannedState: 'shed',
      shedAction: 'set_step',
      selectedStepId: undefined,
      desiredStepId: undefined,
    }));

    expect(intent).toBeNull();
  });

  it('projects planner restore holds as no desired executor state change', () => {
    const intent = buildExecutableSteppedLoadIntent(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reason: { code: 'meterSettling', remainingSec: 30 },
    }));

    expect(intent).toBeNull();
  });

  it('returns null for non stepped-load devices', () => {
    expect(buildExecutableSteppedLoadIntent(steppedPlanDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
    }))).toBeNull();
  });

  it('resolves the current step on the raw dispatch path (no selectedStepId decoration) from the producer fallback', () => {
    // Regression: the raw dispatch path builds observed state from `getSnapshot()`
    // snapshots, which carry NO `selectedStepId` decoration — so the observed step
    // stays undefined there (it is real-evidence-only, never the planning fallback).
    // The effective current step is supplied by the producer-resolved fallback
    // (`resolveSteppedLoadCurrentFallback`), not the intent and not an observed join.
    // Keeping the observed step undefined on dispatch is what keeps the stepped
    // shed-release trusted-evidence gate a no-op until a real report arrives.
    const planDevice = steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
      reportedStepId: 'medium',
    });

    // Raw snapshot WITHOUT the selectedStepId decoration, as `getSnapshot()` produces.
    const rawSnapshot = {
      id: planDevice.id,
      name: planDevice.name,
      binaryControl: { on: true },
      targets: [],
      controlModel: planDevice.controlModel,
      steppedLoadProfile: planDevice.steppedLoadProfile,
    } as unknown as TargetDeviceSnapshot;

    const observed = buildExecutableObservedDeviceState(rawSnapshot);
    const action = buildExecutableSteppedLoadDevice(
      buildExecutableSteppedLoadIntent(planDevice),
      observed,
      resolveSteppedLoadCurrentFallback(planDevice),
    );

    // Observed step is undefined on the raw dispatch path (no decoration) ...
    expect(observed?.steppedLoad?.stepId).toBeUndefined();
    // ... yet the executable device's current step is authoritative via the producer fallback.
    expect(action?.current.stepId).toBe('medium');
    expect(action?.current.on).toBe(true);
  });

  it('resolves current state from the plan-device fallback when the device is absent from the snapshot', () => {
    // A planned device that disappeared from `getSnapshot()` between planning and
    // dispatch has no observation; the producer-resolved fallback (plan device's
    // effective on/step) supplies the current state, not a removed intent field.
    const planDevice = steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'low',
    });

    const action = buildExecutableSteppedLoadDevice(
      buildExecutableSteppedLoadIntent(planDevice),
      undefined,
      resolveSteppedLoadCurrentFallback(planDevice),
    );

    expect(action?.current.stepId).toBe('low');
    expect(action?.current.on).toBe(true);
  });
});
