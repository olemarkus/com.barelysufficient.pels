import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectiveActivePlansV1 } from '../../contracts/src/deferredObjectiveActivePlans.ts';

// The active-plans recorder pushes every replan/session change as a
// `deferred_objective_active_plans_updated` realtime event carrying the
// resolved view. The handler must apply that payload to
// `state.deferredObjectiveActivePlans` (read by the Overview EV state line) and
// repaint, or revised schedules stay frozen at their bootstrap value until the
// WebView reloads.

const bumpPlanSurfaceMock = vi.fn();

vi.mock('../src/ui/planRedesign.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/planRedesign.ts')>(
    '../src/ui/planRedesign.ts',
  );
  return {
    ...actual,
    bumpPlanSurface: (...args: unknown[]) => bumpPlanSurfaceMock(...args),
  };
});

import {
  coerceDeferredObjectiveActivePlans,
  applyDeferredObjectiveActivePlansPush,
} from '../src/ui/deferredObjectiveActivePlans.ts';
import { state } from '../src/ui/state.ts';

const planFor = (deviceId: string, revision: number): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: {
    [deviceId]: {
      liveCompletion: { kind: 'unavailable' as const },
      deviceId,
      deviceName: 'Test EV',
      objectiveKind: 'ev_soc',
      targetValue: 80,
      deadlineAtMs: 0,
      startedAtMs: 0,
      pending: false,
      objectiveSignature: '',
      original: null,
      latest: {
        revision,
        revisedAtMs: 0,
        computedFromPricesUpTo: null,
        reason: 'flow_card',
        hours: [{ startsAtMs: revision * 1000, plannedKWh: 3 }],
        energyNeededKWh: 5,
        planStatus: 'on_track',
      },
    },
  },
});

beforeEach(() => {
  bumpPlanSurfaceMock.mockReset();
  state.deferredObjectiveActivePlans = null;
});

afterEach(() => {
  state.deferredObjectiveActivePlans = null;
});

describe('coerceDeferredObjectiveActivePlans', () => {
  it('returns null for non-object / missing-shape raw values', () => {
    expect(coerceDeferredObjectiveActivePlans(undefined)).toBeNull();
    expect(coerceDeferredObjectiveActivePlans(null)).toBeNull();
    expect(coerceDeferredObjectiveActivePlans('nope')).toBeNull();
    expect(coerceDeferredObjectiveActivePlans({})).toBeNull();
    expect(coerceDeferredObjectiveActivePlans({ plansByDeviceId: 7 })).toBeNull();
  });

  it('returns null when the version literal does not match the recognised schema', () => {
    const stale = { ...planFor('ev-1', 1), version: 2 };
    expect(coerceDeferredObjectiveActivePlans(stale)).toBeNull();
  });

  it('passes through a well-formed payload, preserving nested fields', () => {
    const raw = planFor('ev-1', 2);
    const result = coerceDeferredObjectiveActivePlans(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.plansByDeviceId['ev-1']).toStrictEqual(raw.plansByDeviceId['ev-1']);
    expect(result?.plansByDeviceId['ev-1']?.latest?.revision).toBe(2);
  });

  it('filters out non-object per-device entries', () => {
    const raw = planFor('ev-1', 2);
    const tampered = {
      version: 1 as const,
      plansByDeviceId: { ...raw.plansByDeviceId, 'ev-bad': 7 as unknown },
    };
    const result = coerceDeferredObjectiveActivePlans(tampered);
    expect(result).not.toBeNull();
    expect(Object.keys(result?.plansByDeviceId ?? {})).toEqual(['ev-1']);
  });

  it.each([
    ['hours that are not an array', { planStatus: 'on_track', hours: {} }],
    ['an hour with no start', { planStatus: 'on_track', hours: [null] }],
    ['an hour with a non-finite start', { planStatus: 'on_track', hours: [{ startsAtMs: Number.NaN }] }],
    // Not `null` (not yet planned): the smart-task row reads `latest.planStatus`.
    ['no revision at all', undefined],
    // The smart-task row would otherwise count it "on track".
    ['a revision with no verdict', { hours: [] }],
    ['a revision with an unknown verdict', { planStatus: 'toString', hours: [] }],
  ])('drops a plan with %s, which the Overview EV line would walk', (_case, latest) => {
    const raw = planFor('ev-1', 2);
    const tampered = {
      version: 1 as const,
      plansByDeviceId: { ...raw.plansByDeviceId, 'ev-bad': { ...raw.plansByDeviceId['ev-1'], latest } as unknown },
    };
    expect(Object.keys(coerceDeferredObjectiveActivePlans(tampered)?.plansByDeviceId ?? {})).toEqual(['ev-1']);
  });

  it('drops a plan with a non-finite deadline, which the Overview smart-task row shows', () => {
    const raw = planFor('ev-1', 2);
    const tampered = {
      version: 1 as const,
      plansByDeviceId: {
        ...raw.plansByDeviceId,
        'ev-bad': { ...raw.plansByDeviceId['ev-1'], deadlineAtMs: Number.NaN } as unknown,
      },
    };
    expect(Object.keys(coerceDeferredObjectiveActivePlans(tampered)?.plansByDeviceId ?? {})).toEqual(['ev-1']);
  });
});

describe('applyDeferredObjectiveActivePlansPush', () => {
  it('applies the pushed plans to state and repaints the plan surface, without a read', () => {
    applyDeferredObjectiveActivePlansPush(planFor('ev-1', 3));
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(3);
    expect(bumpPlanSurfaceMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale bootstrap value with the freshly revised plan', () => {
    state.deferredObjectiveActivePlans = planFor('ev-1', 1);
    applyDeferredObjectiveActivePlansPush(planFor('ev-1', 4));
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(4);
  });

  it('drops the plan of a task that ended when the push no longer carries it', () => {
    state.deferredObjectiveActivePlans = planFor('ev-1', 1);
    applyDeferredObjectiveActivePlansPush({ version: 1, plansByDeviceId: {} });
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId).toEqual({});
  });

  it('validates the payload as it validates the bootstrap: a malformed push clears state', () => {
    state.deferredObjectiveActivePlans = planFor('ev-1', 1);
    applyDeferredObjectiveActivePlansPush({ version: 2, plansByDeviceId: {} });
    expect(state.deferredObjectiveActivePlans).toBeNull();
    expect(bumpPlanSurfaceMock).toHaveBeenCalledTimes(1);
  });
});
