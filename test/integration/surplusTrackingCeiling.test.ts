// Integration coverage for the surplus-TRACKING ceiling: the rung the allocator
// bought a device becomes a CEILING on its keep step and on its restore climb,
// while capacity shedding, boost and an active smart task all still outrank it.
//
// Driven through the real `resolveSteppedKeepDesiredStepId` / `resolveSurplusHold`
// rather than a mocked planner, so what is pinned is the composition — which
// clamp wins — not a restatement of each helper's own unit contract.
import { describe, expect, it } from 'vitest';
import { resolveSteppedKeepDesiredStepId } from '../../lib/plan/planSteppedLoad';
import { resolveSurplusHold } from '../../lib/plan/shedding/surplusHold';
import { createPlanEngineState } from '../../lib/plan/planState';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanInputDevice, steppedProfile } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const CHARGER = 'charger';

const keepDevice = (overrides: Record<string, unknown> = {}) => ({
  steppedLoadProfile: steppedProfile,
  selectedStepId: 'max',
  reportedStepId: 'max',
  desiredStepId: 'max',
  currentOn: true,
  plannedState: 'keep',
  ...overrides,
});

const buildTracker = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => (
  buildPlanInputDevice({
    id: CHARGER,
    name: CHARGER,
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'max',
    currentOn: true,
    commandableNow: true,
    surplusTracking: true,
    ...overrides,
  } as Parameters<typeof buildPlanInputDevice>[0])
);

describe('surplus tracking ceiling — keep path', () => {
  it('lowers a device sitting above its allocation to the allocated rung', () => {
    expect(resolveSteppedKeepDesiredStepId(keepDevice(), {
      surplusCeilingStepId: 'low',
    })).toBe('low');
  });

  it('leaves a device already below its allocation alone — the ceiling never raises', () => {
    expect(resolveSteppedKeepDesiredStepId(keepDevice({
      selectedStepId: 'low', reportedStepId: 'low', desiredStepId: 'low',
    }), { surplusCeilingStepId: 'max' })).toBe('low');
  });

  it('is a no-op for a device with no allocation', () => {
    expect(resolveSteppedKeepDesiredStepId(keepDevice(), {})).toBe('max');
  });

  it('yields to boost — a live demand outranks "use only your own sun"', () => {
    expect(resolveSteppedKeepDesiredStepId(keepDevice(), {
      surplusCeilingStepId: 'low',
      boostActive: true,
    })).toBe('max');
  });

  it('composes with the fairness clamp, and the LOWER of the two wins', () => {
    // Another device is limited, so the fairness clamp wants `low`; the surplus
    // allocation would have allowed `medium`. The device must end up at `low` —
    // capacity pressure is not something a solar allocation can overrule.
    expect(resolveSteppedKeepDesiredStepId(keepDevice(), {
      surplusCeilingStepId: 'medium',
      anyOtherDeviceLimited: true,
    })).toBe('low');
  });
});

describe('surplus tracking ceiling — the hold', () => {
  const hold = (device: PlanInputDevice, ceilingStepId: string | undefined) => {
    const state = createPlanEngineState();
    if (ceilingStepId !== undefined) state.surplusTrackingStepByDevice[device.id] = ceilingStepId;
    return resolveSurplusHold({ devices: [device], state, excludeIds: new Set() });
  };

  it('holds a device whose allocation clamped it to an off rung, and says why', () => {
    const result = hold(buildTracker(), 'off');
    expect(result.holdIds.has(CHARGER)).toBe(true);
    expect(result.reasonById.get(CHARGER)).toEqual({
      code: PLAN_REASON_CODES.awaitingSolarSurplus,
    });
  });

  it('does NOT hold a device parked on an active rung — it is limited, not waiting', () => {
    // This is the `'minimum'` floor policy's device: still drawing, topped up
    // from the grid. Telling its owner it is "waiting for solar surplus" would
    // be false.
    expect(hold(buildTracker(), 'low').holdIds.has(CHARGER)).toBe(false);
  });

  it('does not hold a device with no allocation at all', () => {
    expect(hold(buildTracker(), undefined).holdIds.has(CHARGER)).toBe(false);
  });

  it('carries the off rung as the DECIDED step target, not just a shed-set entry', () => {
    // The regression: shed materialization falls back to the device's CONFIGURED
    // shed floor when no rung was decided, and for a `set_step` device that
    // floor is its lowest ACTIVE rung — 6 A on a charger. The device would keep
    // drawing from the grid while its card read "Waiting for solar surplus".
    const result = hold(buildTracker(), 'off');
    expect(result.stepTargetById.get(CHARGER)).toBe('off');
  });

  it('does not claim a step target for a device it is not holding', () => {
    expect(hold(buildTracker(), 'low').stepTargetById.has(CHARGER)).toBe(false);
  });

  it('does not hold a boosted device — a boost outranks the surplus posture', () => {
    // The keep and restore ceiling paths both bypass on boost, but they run
    // AFTER materialization has read the shed set: a device held here is already
    // `plannedState: 'shed'` and the restore candidates reject it, so those
    // bypasses never execute. The hold itself has to honour the boost, or a
    // low-battery charger stays off until the sun comes back.
    const boosted = buildTracker({ boostRequested: true } as Partial<PlanInputDevice>);
    const result = hold(boosted, 'off');
    expect(result.holdIds.has(CHARGER)).toBe(false);
  });

  it('never holds a device an active smart task governs', () => {
    const device = buildTracker();
    const state = createPlanEngineState();
    state.surplusTrackingStepByDevice[device.id] = 'off';
    const result = resolveSurplusHold({
      devices: [device],
      state,
      excludeIds: new Set([CHARGER]),
    });
    expect(result.holdIds.has(CHARGER)).toBe(false);
  });
});
