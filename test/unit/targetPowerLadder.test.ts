import { describe, expect, it } from 'vitest';
import {
  assessTargetPowerLadderOptions,
  buildTargetPowerLadderSteps,
  resolveTargetPowerLadderIssue,
  TARGET_POWER_MAX_GENERATED_STEPS,
} from '../../packages/shared-domain/src/targetPowerLadder';

describe('assessTargetPowerLadderOptions', () => {
  it('accepts a range that includes zero', () => {
    expect(assessTargetPowerLadderOptions({ min: 0, max: 3680, step: 460 }))
      .toEqual({ valid: true });
    expect(assessTargetPowerLadderOptions({ max: 3680, step: 460 }))
      .toEqual({ valid: true });
  });

  it('rejects a range that excludes zero by raising min', () => {
    expect(assessTargetPowerLadderOptions({ min: 1380, max: 3680, step: 460 }))
      .toEqual({ valid: false, issue: 'min_excludes_zero' });
  });

  it('rejects a range missing max or step', () => {
    expect(assessTargetPowerLadderOptions({ min: 0, step: 460 }))
      .toEqual({ valid: false, issue: 'missing_max' });
    expect(assessTargetPowerLadderOptions({ min: 0, max: 3680 }))
      .toEqual({ valid: false, issue: 'missing_step' });
    expect(assessTargetPowerLadderOptions(undefined))
      .toEqual({ valid: false, issue: 'missing_max' });
  });

  it('rejects a non-positive max or step', () => {
    expect(assessTargetPowerLadderOptions({ min: 0, max: 0, step: 460 }))
      .toEqual({ valid: false, issue: 'negative_max' });
    expect(assessTargetPowerLadderOptions({ min: 0, max: 3680, step: 0 }))
      .toEqual({ valid: false, issue: 'negative_step' });
  });

  it('rejects a step larger than the range it has to cover', () => {
    expect(assessTargetPowerLadderOptions({ max: 100, step: 500 }))
      .toEqual({ valid: false, issue: 'step_exceeds_range' });
  });

  it('rejects a range that would generate too many steps', () => {
    expect(assessTargetPowerLadderOptions({ min: 0, max: 100_000, step: 1 }))
      .toEqual({ valid: false, issue: 'too_many_generated_steps' });
  });
});

describe('buildTargetPowerLadderSteps', () => {
  it('builds an off step plus every reachable rung', () => {
    expect(buildTargetPowerLadderSteps({ min: 0, max: 1500, step: 500 })).toEqual([
      { id: 'off', planningPowerW: 0 },
      { id: '500w', planningPowerW: 500 },
      { id: '1000w', planningPowerW: 1000 },
      { id: '1500w', planningPowerW: 1500 },
    ]);
  });

  it('starts the rungs at the excluded maximum when the device has one', () => {
    expect(buildTargetPowerLadderSteps({ min: 0, max: 3000, step: 1000, excludeMax: 2000 })).toEqual([
      { id: 'off', planningPowerW: 0 },
      { id: '2000w', planningPowerW: 2000 },
      { id: '3000w', planningPowerW: 3000 },
    ]);
  });

  it('returns nothing for a range that yields no rung — never an off-only ladder', () => {
    expect(buildTargetPowerLadderSteps({ max: 100, step: 500 })).toBeUndefined();
    expect(buildTargetPowerLadderSteps({ max: 0, step: 500 })).toBeUndefined();
    expect(buildTargetPowerLadderSteps(undefined)).toBeUndefined();
  });

  it('always puts at least one rung above zero on a ladder it does return', () => {
    const steps = buildTargetPowerLadderSteps({ min: 0, max: 460, step: 460 });
    expect(steps?.some((step) => step.planningPowerW > 0)).toBe(true);
  });

  it('never mints two rungs with the same id when the step rounds to one watt', () => {
    // A sub-watt step rounds several rungs onto the same watt, and the id is
    // how the whole ladder is addressed — a duplicate makes step lookup
    // ambiguous, so the collisions collapse to one rung.
    const steps = buildTargetPowerLadderSteps({ min: 0, max: 20, step: 0.5 }) ?? [];

    expect(steps.length).toBeGreaterThan(1);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    expect(steps.every((step) => step.id === `${step.planningPowerW}w` || step.id === 'off')).toBe(true);
  });

  it('builds exactly the rungs the assessment approved, without accumulated drift', () => {
    // Walking with `value += step` drifts at watt scale, so the last rung could
    // appear or vanish and the ladder could outrun the count that was accepted.
    const stepW = 0.1;
    const maxW = 12;
    const steps = buildTargetPowerLadderSteps({ min: 0, max: maxW, step: stepW }) ?? [];

    expect(resolveTargetPowerLadderIssue({ min: 0, max: maxW, step: stepW })).toBeUndefined();
    // off + one rung per distinct rounded watt from 0.1 W to 12 W.
    expect(steps[0]).toEqual({ id: 'off', planningPowerW: 0 });
    expect(steps.at(-1)).toEqual({ id: '12w', planningPowerW: 12 });
    expect(steps.length).toBeLessThanOrEqual(TARGET_POWER_MAX_GENERATED_STEPS + 1);
  });
});
