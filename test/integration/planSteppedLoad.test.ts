import {
  getSteppedLoadNextRestoreStep,
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
  resolveStepChangeKw,
  resolveSteppedLoadInitialDesiredStepId,
  resolveSteppedLoadSheddingTarget,
} from '../../lib/plan/planSteppedLoad';
import { resolveObservedSteppedLoadCurrentState } from '../../lib/observer/observedState';
import { steppedInputDevice, steppedPlanDevice, steppedProfile } from '../utils/planTestUtils';

// This fixture feeds the OBSERVER resolver `resolveObservedSteppedLoadCurrentState`,
// which reads the raw observed `binaryControl` + stepped step (NOT the plan-side
// `currentOn`). So keep `binaryControl` on the fixture — do NOT strip it through
// `withBinaryDiscriminant` (which would drop it, leaving the resolver to read
// `undefined`).
describe('planSteppedLoad', () => {
  it('resolves initial desired step and next restore step', () => {
    expect(resolveSteppedLoadInitialDesiredStepId(steppedInputDevice({ selectedStepId: 'low' }))).toBe('low');
    expect(resolveSteppedLoadInitialDesiredStepId(steppedInputDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
      selectedStepId: 'low',
    }))).toBeUndefined();

    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'off' }))?.id).toBe('low');
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'medium' }))?.id).toBe('max');
    expect(getSteppedLoadNextRestoreStep(steppedPlanDevice({
      selectedStepId: 'medium',
      currentState: 'off',
    }))?.id).toBe('low');
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'max' }))).toBeNull();
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
      selectedStepId: 'off',
    }))).toBeNull();

    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'max',
    }))).toBe('low');
    // Behaviour change (resolved-control refactor): a binary/stepped device has
    // no 'unknown' on/off state. The four-valued 'unknown' is only a label now;
    // the device's `currentOn` resolves from the active step ('medium' -> on), so
    // the on-branch applies and returns the desired step rather than holding the
    // current step.
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'unknown',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'max',
    }))).toBe('max');

    const normalizedKeepDesiredStepId = resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'off',
    }));
    expect(normalizedKeepDesiredStepId).toBe('low');
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: normalizedKeepDesiredStepId,
      desiredStepId: normalizedKeepDesiredStepId,
    }))).toBe(normalizedKeepDesiredStepId);
  });

  it('classifies restore_from_off_at_low with the lowest active command step even when desired step is higher', () => {
    const transition = resolveSteppedLoadTransition(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'max',
      binaryCapabilityId: 'onoff',
    }));

    expect(transition?.effectiveTransition).toBe('restore_from_off_at_low');
    expect(transition?.commandStepId).toBe('low');
    expect(transition?.stepPreparationPurpose).toBe('prepare_for_on');
  });

  it('does not treat selected step alone as restore preparation', () => {
    const transition = resolveSteppedLoadTransition(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      binaryCapabilityId: 'onoff',
    }));

    expect(transition?.effectiveTransition).toBe('restore_from_off_at_low');
    expect(transition?.commandStepId).toBe('low');
    expect(transition?.transitionPhase).toBe('step_preparation');
  });

  it('is idempotent when re-run on its own normalized keep-step output', () => {
    const device = steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'off',
    });

    const first = resolveSteppedKeepDesiredStepId(device);
    const second = resolveSteppedKeepDesiredStepId({
      ...device,
      desiredStepId: first,
    });

    expect(first).toBe('low');
    expect(second).toBe(first);
  });

  it('keeps keep-intent desired-step normalization idempotent across planner and executor paths', () => {
    const plannerNormalized = resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(plannerNormalized).toBe('low');

    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: plannerNormalized,
    }))).toBe(plannerNormalized);
  });

  // docs/technical.md:222 — stepped device on keep is capped at lowest non-zero step
  // while any other device is being limited this cycle.
  it('clamps observed-on keep desired step to lowest non-zero when any other device is limited', () => {
    const baseDevice = steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
    });

    expect(resolveSteppedKeepDesiredStepId(baseDevice)).toBe('medium');
    expect(resolveSteppedKeepDesiredStepId(baseDevice, { anyOtherDeviceLimited: false })).toBe('medium');
    expect(resolveSteppedKeepDesiredStepId(baseDevice, { anyOtherDeviceLimited: true })).toBe('low');

    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'max',
      desiredStepId: 'max',
    }), { anyOtherDeviceLimited: true })).toBe('low');
  });

  it('holds an admitted boosted step across rebuilds and releases it when boost ends', () => {
    const boostedAtMedium = steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'low',
    });
    expect(resolveSteppedKeepDesiredStepId(
      boostedAtMedium,
      { anyOtherDeviceLimited: true, boostActive: true },
    )).toBe('medium');

    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'max',
      desiredStepId: 'low',
    }), { anyOtherDeviceLimited: true, boostActive: true })).toBe('max');

    expect(resolveSteppedKeepDesiredStepId(
      boostedAtMedium,
      { anyOtherDeviceLimited: true },
    )).toBe('low');
  });

  it('leaves keep desired step unchanged when device is already at lowest non-zero step', () => {
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'low',
    }), { anyOtherDeviceLimited: true })).toBe('low');
  });

  it('preserves off→low normalization when other devices are limited', () => {
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'off',
    }), { anyOtherDeviceLimited: true })).toBe('low');
  });

  it('does not apply the shed-invariant clamp for shed-intent devices', () => {
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'on',
      plannedState: 'shed',
      selectedStepId: 'medium',
      desiredStepId: 'medium',
    }), { anyOtherDeviceLimited: true })).toBe('medium');
  });

  it('resolves shed targets conservatively for turn-off and set-step behavior', () => {
    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'set_step',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'medium' }),
      shedAction: 'set_step',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'set_step',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'turn_off',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedPlanDevice({ selectedStepId: 'max', currentState: 'off' }),
      shedAction: 'turn_off',
    })?.id).toBe('off');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'turn_off',
    })?.id).toBe('off');

    const noOffProfile = {
      steps: [
        { id: 'low', planningPowerW: 1000 },
        { id: 'max', planningPowerW: 2000 },
      ],
    };
    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ steppedLoadProfile: noOffProfile, selectedStepId: 'max' }),
      shedAction: 'turn_off',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'set_step',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'set_step',
    })?.id).toBe('low');
  });

  it('resolves keep desired step idempotently', () => {
    const firstPass = resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    const secondPass = resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'off',
      desiredStepId: firstPass,
    }));

    expect(firstPass).toBe('low');
    expect(secondPass).toBe(firstPass);
  });

  it('resolves shedding target including profile and relief flags', () => {
    const targetStep = { id: 'low', planningPowerW: 1250 };
    const target = resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      targetStep,
    });

    expect(target?.steppedProfile).toBe(steppedProfile);
    expect(target?.selectedStep.id).toBe('max');
    expect(target?.clampedTargetStep.id).toBe('low');
    expect(target?.hasUnconfirmedLowerDesiredStep).toBe(false);

    const targetWithPending = resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({
        selectedStepId: 'max',
        stepCommandPending: true,
        desiredStepId: 'low',
      }),
      targetStep,
    });
    expect(targetWithPending?.hasUnconfirmedLowerDesiredStep).toBe(true);

    const targetWithStaleDesired = resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({
        selectedStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        desiredStepId: 'low',
      }),
      targetStep: { id: 'medium', planningPowerW: 2000 },
    });
    expect(targetWithStaleDesired?.clampedTargetStep.id).toBe('medium');
    expect(targetWithStaleDesired?.hasUnconfirmedLowerDesiredStep).toBe(true);

    expect(resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined }),
      targetStep,
    })).toBeNull();

    const zeroOnlyProfile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'idle', planningPowerW: 0 },
      ],
    };
    expect(getSteppedLoadShedTargetStep({
      device: {
        steppedLoadProfile: zeroOnlyProfile,
        selectedStepId: 'idle',
      },
      shedAction: 'set_step',
    })).toBeNull();
  });

  it('resolves current state from binary onoff or stepped profile', () => {
    // Observer-side resolution vocabulary: a snapshot with no known step is the
    // observer's own 'unknown' — it never crosses into a plan device.
    expect(resolveObservedSteppedLoadCurrentState({ steppedLoadProfile: steppedProfile, selectedStepId: undefined })).toBe('unknown');
    expect(resolveObservedSteppedLoadCurrentState({ steppedLoadProfile: steppedProfile, binaryControl: { on: true }, selectedStepId: 'low' })).toBe('on');
    expect(resolveObservedSteppedLoadCurrentState({ steppedLoadProfile: steppedProfile, binaryControl: { on: false }, selectedStepId: 'low' })).toBe('off');
    expect(resolveObservedSteppedLoadCurrentState({ steppedLoadProfile: steppedProfile, binaryControl: { on: true }, selectedStepId: 'off' })).toBe('off');
    expect(resolveObservedSteppedLoadCurrentState({ binaryControl: { on: true } })).toBe('on');
    expect(resolveObservedSteppedLoadCurrentState({ binaryControl: { on: false } })).toBe('off');
  });

  it('prices a climb up the ladder as the draw it commits', () => {
    // `low` -> `max` on the shared 0/1.25/2.0/3.0 profile.
    expect(resolveStepChangeKw(steppedInputDevice(), 'low', 'max'))
      .toEqual({ direction: 'up', deltaKw: expect.closeTo(1.75, 6) });

    // An OFF device is at its off step, whatever step it reports. `medium` ->
    // `low` runs DOWN the profile, but from off it is a climb that commits the
    // whole 1.25 kW — pricing it by the reported step would answer zero for a
    // device about to start drawing.
    expect(resolveStepChangeKw(steppedPlanDevice({ currentState: 'off' }), 'medium', 'low'))
      .toEqual({ direction: 'up', deltaKw: expect.closeTo(1.25, 6) });
  });

  it('prices a descent as the relief it releases, and names the direction', () => {
    // Measured 2.5 kW is in `max`'s band (above `medium`, at or below
    // nameplate), so the meter and the reported step agree and the meter is
    // the answer: 2.5 now, 1.25 after.
    expect(resolveStepChangeKw(steppedInputDevice({ currentDrawKw: 2.5 }), undefined, 'low'))
      .toEqual({ direction: 'down', deltaKw: expect.closeTo(1.25, 6) });

    // Turning a device off releases exactly what it is drawing.
    expect(resolveStepChangeKw(
      steppedInputDevice({ selectedStepId: 'low', currentDrawKw: 0.5, binaryCapabilityId: undefined }),
      undefined,
      'off',
    )).toEqual({ direction: 'down', deltaKw: expect.closeTo(0.5, 6) });

    // The direction is reported, not folded into a zero: `max` -> `low` is a
    // descent even when the caller asking is the restore lane, which reads
    // anything but `up` as nothing to do.
    expect(resolveStepChangeKw(steppedInputDevice(), 'max', 'low').direction).toBe('down');
  });

  it('answers no change for a device with no ladder, and for a step that goes nowhere', () => {
    expect(resolveStepChangeKw(
      steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined }),
      'low',
      'max',
    )).toEqual({ direction: 'none', deltaKw: 0 });
    expect(resolveStepChangeKw(steppedInputDevice(), 'low', 'low'))
      .toEqual({ direction: 'none', deltaKw: 0 });
  });

  it('treats two rungs configured at the same watts as different rungs', () => {
    // `normalizeSteppedLoadProfile` dedupes step IDs but NOT wattages, so a
    // hand-configured ladder can carry two rungs at the same `planningPowerW`.
    // `sortSteppedLoadSteps` breaks the tie by id, so `a` -> `b` is a real climb
    // that the restore lane must be able to command. Deriving direction from
    // watts called it "no change", and the device then stalled below `b` and
    // every rung above it forever.
    const tiedRungs = steppedInputDevice({
      selectedStepId: 'a',
      currentDrawKw: 2,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'a', planningPowerW: 2000 },
          { id: 'b', planningPowerW: 2000 },
          { id: 'c', planningPowerW: 3000 },
        ],
      },
      stepPowerCalibration: { b: { admissionPowerKw: 2.4, deliveryPowerKw: 2.4 } },
    });

    // Same watts on the profile, a higher learned draw on `b`: a climb worth
    // 0.4 kW, not nothing.
    expect(resolveStepChangeKw(tiedRungs, 'a', 'b'))
      .toEqual({ direction: 'up', deltaKw: expect.closeTo(0.4, 6) });
    // And the reverse is a descent, not a no-op.
    expect(resolveStepChangeKw(tiedRungs, 'b', 'a').direction).toBe('down');
    // A rung against itself is still no change.
    expect(resolveStepChangeKw(tiedRungs, 'a', 'a'))
      .toEqual({ direction: 'none', deltaKw: 0 });
  });

  it('prices an observed-off device from zero even when its ladder has no off step', () => {
    // A hand-configured profile with no zero-power rung and none named `off`.
    // The device is off, so it is at position ZERO and `medium` -> `low` is a
    // CLIMB that commits the whole 1.25 kW — reading the reported step as the
    // from-position would call it a descent and admit the device on nothing.
    const noOffStep = steppedPlanDevice({
      currentState: 'off',
      steppedLoadProfile: {
        steps: [
          { id: 'low', planningPowerW: 1250 },
          { id: 'medium', planningPowerW: 2000 },
        ],
      },
    });

    expect(resolveStepChangeKw(noOffStep, 'medium', 'low'))
      .toEqual({ direction: 'up', deltaKw: expect.closeTo(1.25, 6) });
  });

  it('bounds a descent by the meter, not by what the reported step should draw', () => {
    // The 11-17 Aug shape: a charger reporting a 1.25 kW rung while the meter
    // reads 3.645 kW — the STEP REPORT is the stale half. A full turn-off
    // releases the 3.645 kW that is actually flowing. Clamping the from-side to
    // the step model priced it at 1.25 kW, and the selection loop then went on
    // shedding devices the owner ranked higher against relief it had already won.
    const laggingStepReport = steppedInputDevice({ selectedStepId: 'low', currentDrawKw: 3.645 });
    expect(resolveStepChangeKw(laggingStepReport, undefined, 'off'))
      .toEqual({ direction: 'down', deltaKw: expect.closeTo(3.645, 6) });

    // Same device, opposite direction: a climb takes the SMALLER of the two, so
    // the commitment it books is the full step up from the modelled 1.25 kW
    // rather than a sliver measured from a reading that may be a spike.
    expect(resolveStepChangeKw(laggingStepReport, undefined, 'max'))
      .toEqual({ direction: 'up', deltaKw: expect.closeTo(1.75, 6) });

    // And the meter is a BOUND, not merely a preference: a device measured
    // below what its rung should draw — idle at setpoint, or a stale reading —
    // is credited what is flowing and no more.
    expect(resolveStepChangeKw(steppedInputDevice({ selectedStepId: 'max', currentDrawKw: 1.193 }), undefined, 'off'))
      .toEqual({ direction: 'down', deltaKw: expect.closeTo(1.193, 6) });
  });

  it('isSteppedLoadDevice identifies stepped devices', () => {
    expect(isSteppedLoadDevice(steppedInputDevice())).toBe(true);
    expect(isSteppedLoadDevice(steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined }))).toBe(false);
  });
});
