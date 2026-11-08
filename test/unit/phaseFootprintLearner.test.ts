import {
  classifyStep,
  parsePhaseLearning,
  PhaseFootprintLearner,
  type PhaseLearningDeviceSample,
} from '../../lib/phaseFootprint/phaseFootprintLearner';
import { resolvePhaseFootprintWithSource } from '../../lib/phaseFootprint/resolvePhaseFootprint';

type Phases = readonly [number, number, number];
const BASE: Phases = [2, 2, 2];

const heater = (drawKw: number, lastCommandAtMs?: number): PhaseLearningDeviceSample => ({
  deviceId: 'heater', drawKw, isEvCharger: false, evSessionActive: false, lastCommandAtMs,
});

type Others = (index: number) => readonly PhaseLearningDeviceSample[];

type Scenario = {
  learner: PhaseFootprintLearner;
  readonly atMs: number;
  /** One command toggling the device by the given phase changes, with stable windows either side. */
  step(phases: Phases, options?: { others?: Others; device?: Partial<PhaseLearningDeviceSample> }): void;
};

const scenario = (learner = new PhaseFootprintLearner()): Scenario => {
  let atMs = 1_000_000;
  let on = false;
  let draw = 0;
  let phases: Phases = BASE;
  let last: number | undefined;
  const sample = (others: Others, index: number, device: Partial<PhaseLearningDeviceSample>) => {
    learner.observe({ atMs, phasesKw: phases, devices: [{ ...heater(draw, last), ...device }, ...others(index)] });
    atMs += 10_000;
  };
  return {
    learner,
    get atMs() { return atMs; },
    step(delta, options = {}) {
      const others: Others = options.others ?? (() => []);
      const device = options.device ?? {};
      for (let index = 0; index < 5; index += 1) sample(others, index, device);
      last = atMs;
      const sign = on ? -1 : 1;
      on = !on;
      draw += sign * delta.reduce((sum, kw) => sum + kw, 0);
      phases = phases.map((kw, index) => kw + sign * (delta[index] ?? 0)) as unknown as Phases;
      for (let index = 5; index < 12; index += 1) sample(others, index, device);
    },
  };
};

describe('classifyStep', () => {
  it('reads one phase carrying the step', () => {
    expect(classifyStep(2, [1.9, 0.1, 0])).toBe('L1');
    expect(classifyStep(-2, [0, -1.9, -0.1])).toBe('L2');
  });

  it('reads three phases sharing the step', () => {
    expect(classifyStep(3, [1, 1.1, 0.9])).toBe('all_three');
  });

  it('gives no vote for anything else', () => {
    expect(classifyStep(2, [1.2, 0.8, 0])).toBeNull();
    expect(classifyStep(2, [1.5, 0.5, 0.1])).toBeNull();
  });
});

describe('PhaseFootprintLearner', () => {
  it('settles after five agreeing steps and stores it', () => {
    const stored: unknown[] = [];
    const learner = new PhaseFootprintLearner();
    learner.bindStore({ get: () => null, set: (value) => stored.push(value) });
    const run = scenario(learner);
    for (let index = 0; index < 4; index += 1) run.step([2, 0, 0]);
    expect(learner.learnedFootprint('heater')).toBeUndefined();
    run.step([2, 0, 0]);
    expect(learner.learnedFootprint('heater')).toEqual({ kind: 'single', phase: 'L1' });
    expect(stored.length).toBeGreaterThan(0);
  });

  it('does not vote on a rung step, which may move only one element of a three-element device', () => {
    const learner = new PhaseFootprintLearner();
    let atMs = 1_000_000;
    let draw = 3;
    let phases: Phases = [3, 3, 3];
    let last: number | undefined;
    const sample = () => {
      learner.observe({ atMs, phasesKw: phases, devices: [heater(draw, last)] });
      atMs += 10_000;
    };
    for (let round = 0; round < 6; round += 1) {
      for (let index = 0; index < 5; index += 1) sample();
      last = atMs;
      const lowering = draw === 3;
      draw = lowering ? 1.5 : 3;
      phases = lowering ? [1.5, 3, 3] : [3, 3, 3];
      for (let index = 0; index < 7; index += 1) sample();
    }
    expect(learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('ignores steps under 500 W', () => {
    const run = scenario();
    for (let index = 0; index < 6; index += 1) run.step([0.3, 0, 0]);
    expect(run.learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('rejects a step another managed device moved during', () => {
    const run = scenario();
    const others: Others = (index) => [{
      deviceId: 'other', drawKw: index < 5 ? 0 : 1, isEvCharger: false, evSessionActive: false, lastCommandAtMs: undefined,
    }];
    for (let index = 0; index < 6; index += 1) run.step([2, 0, 0], { others });
    expect(run.learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('rejects a step another PELS command overlaps', () => {
    const run = scenario();
    for (let index = 0; index < 6; index += 1) {
      const commandAt = run.atMs + 50_000;
      run.step([2, 0, 0], { others: (sampleIndex) => [{
        deviceId: 'other', drawKw: 1, isEvCharger: false, evSessionActive: false,
        lastCommandAtMs: sampleIndex < 5 ? undefined : commandAt,
      }] });
    }
    expect(run.learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('needs an 80 % majority', () => {
    const run = scenario();
    for (const delta of [[2, 0, 0], [0, 2, 0], [2, 0, 0], [0, 2, 0], [2, 0, 0], [0, 2, 0]] as const) run.step(delta);
    expect(run.learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('goes back to unknown on three dissenting votes', () => {
    const run = scenario();
    for (let index = 0; index < 5; index += 1) run.step([2, 0, 0]);
    for (let index = 0; index < 3; index += 1) run.step([0, 2, 0]);
    expect(run.learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('keeps a one-phase EV session as a session fact, never stored', () => {
    const stored: unknown[] = [];
    const learner = new PhaseFootprintLearner();
    learner.bindStore({ get: () => null, set: (value) => stored.push(value) });
    const run = scenario(learner);
    const device = { isEvCharger: true, evSessionActive: true };
    for (let index = 0; index < 5; index += 1) run.step([3, 0, 0], { device });
    expect(learner.learnedFootprint('heater')).toEqual({ kind: 'single', phase: 'L1' });
    expect(stored).toHaveLength(0);
    run.step([3, 0, 0], { device: { isEvCharger: true, evSessionActive: false } });
    expect(learner.learnedFootprint('heater')).toBeUndefined();
  });

  it('validates what it reads back entry by entry', () => {
    expect(parsePhaseLearning({
      good: { votes: ['L1'], settled: 'L1' },
      bad: { votes: ['L9'], settled: null },
      worse: 3,
    })).toEqual({ good: { votes: ['L1'], settled: 'L1' } });
    expect(parsePhaseLearning('nope')).toEqual({});
  });
});

describe('where learning sits', () => {
  const base = {
    ownerConnection: undefined, isEvCharger: false, chargerPhaseCurrentsA: undefined,
    evPreset: undefined, learned: { kind: 'single', phase: 'L2' },
  } as const;

  it('is below the owner', () => {
    expect(resolvePhaseFootprintWithSource({ ...base, ownerConnection: 'L3' })).toMatchObject({
      footprint: { kind: 'single', phase: 'L3' }, source: 'set',
    });
  });

  it('is below a charger measuring three phases', () => {
    expect(resolvePhaseFootprintWithSource({ ...base, isEvCharger: true, chargerPhaseCurrentsA: [10, 10, 10] }))
      .toMatchObject({ footprint: { kind: 'all_three' }, source: 'reported' });
  });

  it('names the phase for a charger drawing on one, and gives way when three are measured', () => {
    expect(resolvePhaseFootprintWithSource({ ...base, isEvCharger: true, chargerPhaseCurrentsA: [10, 0, 0] }))
      .toMatchObject({ footprint: { kind: 'single', phase: 'L2' }, source: 'learned' });
    expect(resolvePhaseFootprintWithSource({
      ...base, isEvCharger: true, chargerPhaseCurrentsA: [10, 0, 0], learned: { kind: 'all_three' },
    })).toMatchObject({ footprint: { kind: 'unknown' }, source: 'reported' });
  });

  it('answers for a plain device', () => {
    expect(resolvePhaseFootprintWithSource(base)).toMatchObject({
      footprint: { kind: 'single', phase: 'L2' }, source: 'learned',
    });
  });
});
