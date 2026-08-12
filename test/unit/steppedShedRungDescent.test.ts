import { resolveSteppedShedRung } from '../../lib/plan/shedding/steppedCandidates';
import { getSteppedLoadShedTargetStep } from '../../lib/plan/planSteppedLoad';
import { steppedInputDevice } from '../utils/planTestUtils';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

// The production profile from incident `inc_26449fb9` (Høiax "Connected 300").
const waterHeaterProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

// Calibration as it stood at 20:02:04Z: `low` had just been calibrated from the
// 1.193 kW reading, and `medium` sits above it. That ordering is what collapses
// the `max -> medium` delta to zero while the measurement lags.
const waterHeaterCalibration = {
  low: { admissionPowerKw: 1.193, deliveryPowerKw: 1.193 },
  medium: { admissionPowerKw: 1.671, deliveryPowerKw: 1.671 },
  max: { admissionPowerKw: 3, deliveryPowerKw: 3 },
};

const heater = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => steppedInputDevice({
  steppedLoadProfile: waterHeaterProfile,
  stepPowerCalibration: waterHeaterCalibration,
  selectedStepId: 'max',
  currentDrawKw: 1.193,
  ...overrides,
});

const initialTargetFor = (
  device: PlanInputDevice,
  shedAction: 'turn_off' | 'set_step',
) => getSteppedLoadShedTargetStep({
  device,
  shedAction,
  currentDesiredStepId: device.selectedStepId,
});

describe('stepped shed rung descent', () => {
  it('descends to the off step when every active rung prices at zero relief', () => {
    // The 2026-08-05 hard-cap breach: `measure_power` is stale at the `low`-step
    // value while the device runs at `max`. Both `max -> medium` (1.193 - 1.193)
    // and `max -> low` (1.193 - 1.193) price at exactly zero, which is what made
    // the heater vanish from candidacy for 4.5 minutes.
    const device = heater();
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'turn_off'),
      shedAction: 'turn_off',
    });

    expect(result.kind).toBe('rung');
    if (result.kind !== 'rung') return;
    expect(result.rung.clampedTargetStep.id).toBe('off');
    // Meter-grounded: turning it off frees exactly what the meter reports, which
    // is more than double the 526 W the breach needed.
    expect(result.rung.effectivePower).toBeCloseTo(1.193, 6);
    expect(result.rung.selectedStep.id).toBe('max');
  });

  it('does not descend at all for a set_step device', () => {
    // Materialization recomputes a `set_step` target as the ADJACENT rung
    // (`resolveSteppedLoadDirectShedStepId`) and never sees the candidate's
    // `toStepId`, so only `medium` may be priced here. Turning it off is also not
    // the shed behaviour its owner configured.
    const device = heater();
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'set_step'),
      shedAction: 'set_step',
    });

    expect(result.kind).toBe('no_relief');
    if (result.kind !== 'no_relief') return;
    expect(result.rungsTried).toEqual(['medium']);
  });

  it('never credits a set_step device more relief than the executor will deliver', () => {
    // Measured 1.5 kW sits between `low`'s admission (1.193) and `medium`'s
    // (1.671): `max -> medium` prices at zero, `max -> low` at 0.307. Crediting
    // the deeper rung would decrement the deficit by a step-down the executor
    // never commands, so selection would treat the breach as covered and skip the
    // device that could actually have helped — strictly worse than no candidate.
    const device = heater({ currentDrawKw: 1.5 });
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'set_step'),
      shedAction: 'set_step',
    });

    expect(result.kind).toBe('no_relief');

    // The same device on `turn_off` may descend: there the executor commands the
    // off step, so delivered relief is the whole draw and the credit under-states.
    const turnOff = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'turn_off'),
      shedAction: 'turn_off',
    });
    expect(turnOff.kind).toBe('rung');
    if (turnOff.kind !== 'rung') return;
    expect(turnOff.rung.clampedTargetStep.id).toBe('low');
    expect(turnOff.rung.effectivePower).toBeCloseTo(0.307, 6);
  });

  it('still takes the gentlest rung when the measurement has caught up', () => {
    // No-regression guard: once `measure_power` reports the real 2.865 kW,
    // `max -> medium` releases 1.194 kW, so the descent must stop there rather
    // than continuing to `off`. This reproduces the reliefKw logged at 20:06:33.
    const device = heater({ currentDrawKw: 2.865 });
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'turn_off'),
      shedAction: 'turn_off',
    });

    expect(result.kind).toBe('rung');
    if (result.kind !== 'rung') return;
    expect(result.rung.clampedTargetStep.id).toBe('medium');
    expect(result.rung.effectivePower).toBeCloseTo(1.194, 6);
  });

  it('reports no reachable step when the device is already at its lowest active step', () => {
    const device = heater({ selectedStepId: 'low', currentDrawKw: 1.193 });
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'set_step'),
      shedAction: 'set_step',
    });

    expect(result.kind).toBe('no_reachable_step');
  });

  it('turns a lowest-active-step device off when its shed behaviour allows it', () => {
    // The mirror of the case above: same position, but `turn_off` puts the off
    // step on the ladder, and the meter says 1.193 kW is there to release.
    const device = heater({ selectedStepId: 'low', currentDrawKw: 1.193 });
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'turn_off'),
      shedAction: 'turn_off',
    });

    expect(result.kind).toBe('rung');
    if (result.kind !== 'rung') return;
    expect(result.rung.clampedTargetStep.id).toBe('off');
    expect(result.rung.effectivePower).toBeCloseTo(1.193, 6);
  });

  it('clamps each rung to a pending lower desired step without stalling on it', () => {
    // A pending step-down to `low` clamps both the `medium` and `low` rungs to
    // the same target. That target is priced once, and the descent still walks
    // past it to the off step rather than reporting the duplicate as a dead end.
    const device = heater({
      desiredStepId: 'low',
      stepCommandPending: true,
      currentDrawKw: 1.193,
    });
    const result = resolveSteppedShedRung({
      device,
      profile: waterHeaterProfile,
      initialTargetStep: initialTargetFor(device, 'turn_off'),
      shedAction: 'turn_off',
    });

    expect(result.kind).toBe('rung');
    if (result.kind !== 'rung') return;
    expect(result.rung.clampedTargetStep.id).toBe('off');
    expect(result.rung.effectivePower).toBeCloseTo(1.193, 6);
    // The pending command is unconfirmed, so the relief is not yet banked.
    expect(result.rung.hasUnconfirmedLowerDesiredStep).toBe(true);
  });
});
