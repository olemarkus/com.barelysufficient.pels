/**
 * Coverage for the chunk-3 producer addition in `lib/device/deviceResidualKw.ts`:
 *
 *  - `resolveResidualKwShed` collapses the legacy `RemainingSheddableDevice`
 *    kind switch (simple / temperature / stepped / stepped+temperature) into
 *    a single number, computed at the producer seam before the planner's
 *    flat plan-cycle gates run.
 *
 * The behaviour-preservation guarantees live in the integration suite via
 * `planRemainingSheddableLoad.test.ts` and the wider plan-build tests; this
 * file pins the producer's internal decision tree directly so future chunks
 * can refactor the helper safely.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveResidualKwShed,
  type ResidualKwShedSteppedDevice,
} from '../../lib/device/deviceResidualKw';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

// A profile without an explicit off step: shedding turn_off has to ride the
// device's binary control (the "canFinishSteppedTurnOffWithBinary" branch).
const stepOnlyProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

describe('resolveResidualKwShed — simple device (no stepped, no temperature target)', () => {
  it('returns the current draw for a turn_off shed', () => {
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 1.4 },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBeCloseTo(1.4, 6);
  });

  it('returns 0 when the device is not drawing power', () => {
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 0 },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBe(0);
  });

  it('returns 0 for non-finite draws', () => {
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: Number.NaN },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBe(0);
  });
});

describe('resolveResidualKwShed — temperature target', () => {
  it('returns the current draw when the temperature target is unknown', () => {
    const kw = resolveResidualKwShed({
      device: {
        currentDrawKw: 0.9,
        temperatureTarget: { min: 5, max: 30, step: 0.5 },
      },
      shedBehavior: { action: 'set_temperature', temperature: 10 },
    });
    expect(kw).toBeCloseTo(0.9, 6);
  });

  it('returns 0 when the configured shed temperature equals the current setpoint', () => {
    const kw = resolveResidualKwShed({
      device: {
        currentDrawKw: 0.9,
        temperatureTarget: { currentValue: 10, min: 5, max: 30, step: 0.5 },
      },
      shedBehavior: { action: 'set_temperature', temperature: 10 },
    });
    expect(kw).toBe(0);
  });

  it('normalises the shed temperature to the target grid before comparing', () => {
    // Setpoint already at 10; shed temperature 10.2 snaps to step 0.5 -> 10.
    const kw = resolveResidualKwShed({
      device: {
        currentDrawKw: 0.9,
        temperatureTarget: { currentValue: 10, min: 5, max: 30, step: 0.5 },
      },
      shedBehavior: { action: 'set_temperature', temperature: 10.2 },
    });
    expect(kw).toBe(0);
  });

  it('returns the current draw when the shed temperature moves the setpoint', () => {
    const kw = resolveResidualKwShed({
      device: {
        currentDrawKw: 0.9,
        temperatureTarget: { currentValue: 20, min: 5, max: 30, step: 0.5 },
      },
      shedBehavior: { action: 'set_temperature', temperature: 10 },
    });
    expect(kw).toBeCloseTo(0.9, 6);
  });

  it('returns 0 for set_temperature on a device without a temperature target', () => {
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 0.9 },
      shedBehavior: { action: 'set_temperature', temperature: 10 },
    });
    expect(kw).toBe(0);
  });
});

describe('resolveResidualKwShed — stepped load device', () => {
  it('returns the current draw for set_step when the device is above lowest active step', () => {
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      selectedStepId: 'max',
      hasKnownEffectiveStep: true,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 3, steppedLoad },
      shedBehavior: { action: 'set_step' },
    });
    expect(kw).toBeCloseTo(3, 6);
  });

  it('returns 0 for set_step when the device is already at the lowest active step', () => {
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      selectedStepId: 'low',
      hasKnownEffectiveStep: true,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 1.3, steppedLoad },
      shedBehavior: { action: 'set_step' },
    });
    expect(kw).toBe(0);
  });

  it('returns the current draw for turn_off when the device has binary control and is above off', () => {
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      selectedStepId: 'low',
      hasKnownEffectiveStep: true,
      controlCapabilityId: 'onoff',
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 1.2, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBeCloseTo(1.2, 6);
  });

  it('returns the current draw for turn_off via binary when the profile has no off step', () => {
    // No off step in the profile but binary control is available — the
    // `canFinishSteppedTurnOffWithBinary` branch allows shedding via the
    // device's onoff capability.
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: stepOnlyProfile,
      selectedStepId: 'low',
      hasKnownEffectiveStep: true,
      controlCapabilityId: 'onoff',
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 1.2, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBeCloseTo(1.2, 6);
  });

  it('returns 0 for turn_off on a stepped device with no binary control once no further step descent is available', () => {
    // No off step in the profile, device already at lowest active step,
    // no binary control ⇒ shed has nowhere to go.
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: stepOnlyProfile,
      selectedStepId: 'low',
      hasKnownEffectiveStep: true,
      controlCapabilityId: undefined,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 1.2, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBe(0);
  });
});

describe('resolveResidualKwShed — stepped load with unknown current step', () => {
  it('returns the measured draw for turn_off when the step is unknown and the device is drawing', () => {
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      hasKnownEffectiveStep: false,
      measuredPowerKw: 2.1,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 2.1, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBeCloseTo(2.1, 6);
  });

  it('returns 0 when the step is unknown and the device is not drawing measurable power', () => {
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      hasKnownEffectiveStep: false,
      measuredPowerKw: 0,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 0, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBe(0);
  });

  it('returns 0 for set_step when measured draw is below the lowest active step (no relief available)', () => {
    // measured 0.5kW, lowest active step is 1.25kW ⇒ set_step would not reduce load.
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      hasKnownEffectiveStep: false,
      measuredPowerKw: 0.5,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 0.5, steppedLoad },
      shedBehavior: { action: 'set_step' },
    });
    expect(kw).toBe(0);
  });

  it('still returns 0 when the step is unknown but a known effective step exists (e.g. reportedStepId)', () => {
    // Mirrors the `resolveSteppedUnknownCurrentMeasuredShedding` guard: it only
    // fires when no step state is known at all.
    const steppedLoad: ResidualKwShedSteppedDevice = {
      profile: steppedProfile,
      selectedStepId: undefined,
      hasKnownEffectiveStep: true,
      measuredPowerKw: 2.1,
    };
    const kw = resolveResidualKwShed({
      device: { currentDrawKw: 2.1, steppedLoad },
      shedBehavior: { action: 'turn_off' },
    });
    expect(kw).toBe(0);
  });
});
