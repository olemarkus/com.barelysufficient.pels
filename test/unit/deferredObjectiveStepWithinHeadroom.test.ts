import { describe, expect, it } from 'vitest';
import { resolveHighestStepWithinHeadroom } from '../../lib/objectives/deferredObjectives/stepSelection';
import type { DeferredObjectiveStep } from '../../lib/objectives/deferredObjectives/types';

// A 1-phase EV charger's ladder, the shape that exposed the defect: the top rung's
// admission power alone exceeds a 5 kW hard cap, so no hour's forecast headroom can
// ever admit it, while the middle rungs fit comfortably.
const ladder: [DeferredObjectiveStep, ...DeferredObjectiveStep[]] = [
  { id: '6a', usefulPowerKw: 1.38, admissionPowerKw: 1.38 },
  { id: '10a', usefulPowerKw: 2.3, admissionPowerKw: 2.3 },
  { id: '16a', usefulPowerKw: 3.68, admissionPowerKw: 3.68 },
  { id: '32a', usefulPowerKw: 7.36, admissionPowerKw: 7.36 },
];

describe('resolveHighestStepWithinHeadroom', () => {
  it('picks the highest rung the headroom admits', () => {
    expect(resolveHighestStepWithinHeadroom(ladder, 3.7)?.id).toBe('16a');
    expect(resolveHighestStepWithinHeadroom(ladder, 2.3)?.id).toBe('10a');
  });

  it('takes the top rung only when the headroom actually reaches it', () => {
    expect(resolveHighestStepWithinHeadroom(ladder, 7.36)?.id).toBe('32a');
    // Just under: the rung whose admission power exceeds the forecast is not a rung
    // the hour can hold, and probing it would zero the bucket instead of clamping.
    expect(resolveHighestStepWithinHeadroom(ladder, 7.35)?.id).toBe('16a');
  });

  it('returns null when there is no usable headroom forecast', () => {
    // Null rather than a default, because the two callers want OPPOSITE defaults:
    // the probes climb to the top rung (nothing physical is known), while a
    // commitment falls back to the floor (it may not promise more than the producer
    // has verified). Picking one here would silently give the other the wrong step.
    expect(resolveHighestStepWithinHeadroom(ladder, undefined)).toBeNull();
    expect(resolveHighestStepWithinHeadroom(ladder, Number.NaN)).toBeNull();
  });

  it('returns the lowest rung when even that exceeds the headroom', () => {
    // The caller's capacity gate then zeroes the bucket, which is the right answer:
    // the hour genuinely cannot hold this device at any level.
    // Not null: it does not fit, and the caller's capacity gate zeroes the bucket.
    expect(resolveHighestStepWithinHeadroom(ladder, 0.5)?.id).toBe('6a');
    expect(resolveHighestStepWithinHeadroom(ladder, 0)?.id).toBe('6a');
  });

  it('handles a single-rung ladder', () => {
    const single: [DeferredObjectiveStep, ...DeferredObjectiveStep[]] = [
      { id: 'charge', usefulPowerKw: 1.38, admissionPowerKw: 1.38 },
    ];
    expect(resolveHighestStepWithinHeadroom(single, 10)?.id).toBe('charge');
    expect(resolveHighestStepWithinHeadroom(single, 0.1)?.id).toBe('charge');
  });
});
