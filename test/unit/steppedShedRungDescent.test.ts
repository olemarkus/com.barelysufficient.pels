import { chooseShedRung, resolveSteppedShedLadder } from '../../lib/plan/shedding/steppedCandidates';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
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

// The 526 W the house was over the hard cap during `inc_26449fb9`.
const BREACH_KW = 0.526;

// A 1-phase EV charger ladder in amps, the shape behind the 11–17 Aug trim
// decisions: adjacent rungs are worth ~1 kW each, so a multi-kW deficit needs
// the walk to keep going.
const chargerProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '10a', planningPowerW: 2300 },
    { id: '16a', planningPowerW: 3680 },
    { id: '20a', planningPowerW: 4600 },
    { id: '24a', planningPowerW: 5520 },
    { id: '28a', planningPowerW: 6440 },
  ],
};

const charger = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => steppedInputDevice({
  steppedLoadProfile: chargerProfile,
  selectedStepId: '28a',
  currentDrawKw: 6.44,
  ...overrides,
});

// A hand-configured profile where the two off rules disagree: the rung named
// `off` still draws 1.2 kW. `getSteppedLoadLowestActiveStep` (the walk's floor)
// tests `planningPowerW > 0` and answers THIS rung; `isSteppedLoadOffStep` (the
// off rule) counts the name and answers that it is off. Every profile PELS
// generates carries a genuine zero-power `off`, so this needs a hand-written one.
const misnamedOffProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 1200 },
    { id: 'low', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const misnamedOffHeater = (): PlanInputDevice => steppedInputDevice({
  steppedLoadProfile: misnamedOffProfile,
  selectedStepId: 'max',
  currentDrawKw: 3,
});

const initialTargetFor = (
  device: PlanInputDevice,
  shedAction: 'turn_off' | 'set_step',
) => getSteppedLoadShedTargetStep({
  device,
  shedAction,
  currentDesiredStepId: isSteppedLoadDevice(device) ? device.selectedStepId : undefined,
});

const ladderFor = (
  device: PlanInputDevice,
  profile: SteppedLoadProfile,
  shedAction: 'turn_off' | 'set_step',
) => resolveSteppedShedLadder({
  device,
  profile,
  initialTargetStep: initialTargetFor(device, shedAction),
  shedAction,
});

describe('stepped shed ladder pricing', () => {
  it('descends to the off step when every active rung prices at zero relief', () => {
    // The 2026-08-05 hard-cap breach: `measure_power` is stale at the `low`-step
    // value while the device runs at `max`. Both `max -> medium` (1.193 - 1.193)
    // and `max -> low` (1.193 - 1.193) price at exactly zero, which is what made
    // the heater vanish from candidacy for 4.5 minutes.
    const result = ladderFor(heater(), waterHeaterProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.fromStepId).toBe('max');
    // Meter-grounded: turning it off frees exactly what the meter reports, which
    // is more than double the 526 W the breach needed.
    expect(result.rungs).toEqual([{ toStepId: 'off', reliefKw: expect.closeTo(1.193, 6) }]);
    expect(chooseShedRung(result.rungs, BREACH_KW)?.toStepId).toBe('off');
  });

  it('descends a set_step device past a zero-relief adjacent rung', () => {
    // The same stale-meter shape, on `set_step`. `max -> medium` prices at
    // exactly zero (1.193 - 1.193), which used to end the search and drop a
    // device the meter shows drawing. The walk now continues to `low`, which
    // prices at zero here too — so the ladder honestly reports that no ACTIVE
    // rung releases anything, having tried both, rather than only the first.
    const result = ladderFor(heater(), waterHeaterProfile, 'set_step');

    expect(result.kind).toBe('no_relief');
    if (result.kind !== 'no_relief') return;
    expect(result.rungsTried).toEqual(['medium', 'low']);
  });

  it('prices the ladder off the meter when the STEP REPORT is the stale half', () => {
    // The 11-17 Aug trim decisions: the charger reports `6a` (1.38 kW) while the
    // meter reads 3.645 kW — about 16 A single-phase, so the report is what
    // lagged. Clamping the from-side to the step model priced a full turn-off at
    // 1.38 kW, and the selection loop then kept shedding devices the owner
    // ranked higher against 2.27 kW of deficit it had already freed.
    const laggingStepReport = charger({ selectedStepId: '6a', currentDrawKw: 3.645 });
    const result = ladderFor(laggingStepReport, chargerProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    // `6a` is the lowest ACTIVE rung, so the off step is the only way down —
    // and it releases every watt the meter can see.
    expect(result.rungs).toEqual([{ toStepId: 'off', reliefKw: expect.closeTo(3.645, 6) }]);
    // A 3 kW deficit is covered outright, so nothing behind this candidate is
    // asked to shed for watts that have already gone.
    expect(chooseShedRung(result.rungs, 3)?.reliefKw).toBeCloseTo(3.645, 6);
  });

  it('never offers a set_step device the off step, however deep it descends', () => {
    // `set_step` means "as far down the ladder as needed, never off". The 6.44 kW
    // charger has six rungs below `28a` and every one of them prices positive, so
    // there is nothing but the behaviour's own floor stopping the walk at `6a`.
    const result = ladderFor(charger(), chargerProfile, 'set_step');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs.map((rung) => rung.toStepId))
      .toEqual(['24a', '20a', '16a', '10a', '6a']);
    // Even a deficit no rung can cover takes the deepest ACTIVE rung, not `off`.
    expect(chooseShedRung(result.rungs, 99)?.toStepId).toBe('6a');
  });

  it('credits a set_step device exactly the relief the deeper rung releases', () => {
    // Measured 1.5 kW sits between `low`'s admission (1.193) and `medium`'s
    // (1.671): `max -> medium` prices at zero, `max -> low` at 0.307. The
    // executor commands the rung priced here (`plannedShedStepId`), so crediting
    // `low` credits watts that actually arrive — and skipping the device over its
    // zero-relief adjacent rung would have left the breach unanswered.
    const device = heater({ currentDrawKw: 1.5 });
    const setStep = ladderFor(device, waterHeaterProfile, 'set_step');
    expect(setStep.kind).toBe('ladder');
    if (setStep.kind !== 'ladder') return;
    expect(setStep.rungs).toEqual([{ toStepId: 'low', reliefKw: expect.closeTo(0.307, 6) }]);

    // The same device on `turn_off` may descend the whole ladder.
    const turnOff = ladderFor(device, waterHeaterProfile, 'turn_off');
    expect(turnOff.kind).toBe('ladder');
    if (turnOff.kind !== 'ladder') return;
    expect(turnOff.rungs.map((rung) => rung.toStepId)).toEqual(['low', 'off']);
    // A 0.3 kW deficit is covered by `max -> low`, so the choice stops there
    // instead of taking the off rung.
    const chosen = chooseShedRung(turnOff.rungs, 0.3);
    expect(chosen?.toStepId).toBe('low');
    expect(chosen?.reliefKw).toBeCloseTo(0.307, 6);
  });

  it('still takes the gentlest rung when the measurement has caught up', () => {
    // No-regression guard: once `measure_power` reports the real 2.865 kW,
    // `max -> medium` releases 1.194 kW, so the choice must stop there rather
    // than continuing to `off`. This reproduces the reliefKw logged at 20:06:33.
    const result = ladderFor(heater({ currentDrawKw: 2.865 }), waterHeaterProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    const chosen = chooseShedRung(result.rungs, BREACH_KW);
    expect(chosen?.toStepId).toBe('medium');
    expect(chosen?.reliefKw).toBeCloseTo(1.194, 6);
  });

  it('reports no reachable step when the device is already at its lowest active step', () => {
    const device = heater({ selectedStepId: 'low', currentDrawKw: 1.193 });

    expect(ladderFor(device, waterHeaterProfile, 'set_step').kind).toBe('no_reachable_step');
  });

  it('turns a lowest-active-step device off when its shed behaviour allows it', () => {
    // The mirror of the case above: same position, but `turn_off` puts the off
    // step on the ladder, and the meter says 1.193 kW is there to release.
    const device = heater({ selectedStepId: 'low', currentDrawKw: 1.193 });
    const result = ladderFor(device, waterHeaterProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs).toEqual([{ toStepId: 'off', reliefKw: expect.closeTo(1.193, 6) }]);
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
    const result = ladderFor(device, waterHeaterProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs).toEqual([{ toStepId: 'off', reliefKw: expect.closeTo(1.193, 6) }]);
    // The pending command is unconfirmed, so the relief is not yet banked.
    expect(result.unconfirmedRelief).toBe(true);
  });

  it('prices every rung of the ladder, gentlest first', () => {
    // The 11–17 Aug charger shape. Priced from the 6.44 kW the meter reports,
    // every rung down from 28a is offered with what it frees — selection then
    // picks against whatever deficit is still open when this device's turn comes.
    const result = ladderFor(charger(), chargerProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs).toEqual([
      { toStepId: '24a', reliefKw: expect.closeTo(0.92, 6) },
      { toStepId: '20a', reliefKw: expect.closeTo(1.84, 6) },
      { toStepId: '16a', reliefKw: expect.closeTo(2.76, 6) },
      { toStepId: '10a', reliefKw: expect.closeTo(4.14, 6) },
      { toStepId: '6a', reliefKw: expect.closeTo(5.06, 6) },
      { toStepId: 'off', reliefKw: expect.closeTo(6.44, 6) },
    ]);
  });

  it('keeps a set_step descent off an off-NAMED rung that still draws power', () => {
    // The walk floors on `getSteppedLoadLowestActiveStep`, which reads the 1.2 kW
    // `off` rung as active, so without asking `isSteppedLoadOffStep` the rung
    // lands on the `set_step` ladder — and it is the only rung that covers a
    // 1.5 kW deficit, so `chooseShedRung` would command the one step this
    // behaviour promises never to reach.
    const result = ladderFor(misnamedOffHeater(), misnamedOffProfile, 'set_step');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs).toEqual([{ toStepId: 'low', reliefKw: expect.closeTo(1, 6) }]);
    // `low` frees 1.0 kW and does not cover 1.5 — the deepest genuinely-active
    // rung is still the answer, rather than the off-named one that would.
    expect(chooseShedRung(result.rungs, 1.5)?.toStepId).toBe('low');
  });

  it('still lets a turn_off device reach an off-NAMED rung that draws power', () => {
    // The mirror: the two floors must stay different. `turn_off` may end on the
    // off-classified rung, and on this profile that is where its whole 3 kW
    // relief is — capped by the meter, as always.
    const result = ladderFor(misnamedOffHeater(), misnamedOffProfile, 'turn_off');

    expect(result.kind).toBe('ladder');
    if (result.kind !== 'ladder') return;
    expect(result.rungs).toEqual([
      { toStepId: 'low', reliefKw: expect.closeTo(1, 6) },
      { toStepId: 'off', reliefKw: expect.closeTo(1.8, 6) },
    ]);
    expect(chooseShedRung(result.rungs, 1.5)?.toStepId).toBe('off');
  });
});

describe('shed rung choice', () => {
  const chargerRungs = () => {
    const result = ladderFor(charger(), chargerProfile, 'turn_off');
    if (result.kind !== 'ladder') throw new Error('expected a priced ladder');
    return result.rungs;
  };

  it('walks past rungs that do not cover what is needed and stops at the first one that does', () => {
    // The headline case from the 11–17 Aug charger logs: a 3.77 kW deficit was
    // answered with the adjacent 28a -> 24a rung, worth 1.01 kW. 24a frees 0.92,
    // 20a 1.84, 16a 2.76 — none of them close the breach. 10a frees 4.14 and does.
    const chosen = chooseShedRung(chargerRungs(), 3.77);

    expect(chosen?.toStepId).toBe('10a');
    expect(chosen?.reliefKw).toBeCloseTo(4.14, 6);
  });

  it('takes the deepest rung that prices positive when no rung covers what is needed', () => {
    // 8 kW needed from a charger the meter shows carrying 6.44 kW: nothing on
    // the ladder covers it, so the answer is everything the device has. Still
    // meter-bound — the credit is the reported draw, not the nameplate.
    const chosen = chooseShedRung(chargerRungs(), 8);

    expect(chosen?.toStepId).toBe('off');
    expect(chosen?.reliefKw).toBeCloseTo(6.44, 6);
  });

  it('takes only the gentlest rung when a small remainder is left to close', () => {
    // The over-shed this split exists to prevent: the same charger asked for a
    // 0.5 kW remainder gives up one rung, not the 4.14 kW rung it would have been
    // fixed at had the choice been made against the cycle's opening deficit.
    const chosen = chooseShedRung(chargerRungs(), 0.5);

    expect(chosen?.toStepId).toBe('24a');
    expect(chosen?.reliefKw).toBeCloseTo(0.92, 6);
  });

  it('answers nothing for a device with no priced rung', () => {
    expect(chooseShedRung([], 1)).toBeNull();
  });
});
