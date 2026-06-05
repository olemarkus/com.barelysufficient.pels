import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectiveActivePlansV1 } from '../../contracts/src/deferredObjectiveActivePlans.ts';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING } from '../../contracts/src/settingsKeys.ts';

// The active-plans recorder persists every replan/session change via
// `settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING)`. The realtime handler
// must drain that key back into `state.deferredObjectiveActivePlans` (read by
// the Overview EV state line) and repaint, or revised schedules stay frozen at
// their bootstrap value until the WebView reloads.

const getSettingMock = vi.fn();
const bumpPlanSurfaceMock = vi.fn();

vi.mock('../src/ui/homey.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts');
  return {
    ...actual,
    getSetting: (...args: unknown[]) => getSettingMock(...args),
  };
});

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
  reloadDeferredObjectiveActivePlans,
} from '../src/ui/deferredObjectiveActivePlans.ts';
import { state } from '../src/ui/state.ts';

const planFor = (deviceId: string, revision: number): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: {
    [deviceId]: {
      deviceId,
      deviceName: 'Test EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
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
  getSettingMock.mockReset();
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

  it('passes through a well-formed payload by reference, preserving nested fields', () => {
    const raw = planFor('ev-1', 2);
    const result = coerceDeferredObjectiveActivePlans(raw);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.plansByDeviceId).toBe(raw.plansByDeviceId);
    expect(result?.plansByDeviceId['ev-1']?.latest?.revision).toBe(2);
  });
});

describe('reloadDeferredObjectiveActivePlans', () => {
  it('re-reads the persisted setting into state and repaints the plan surface', async () => {
    getSettingMock.mockResolvedValue(planFor('ev-1', 3));
    await reloadDeferredObjectiveActivePlans();
    expect(getSettingMock).toHaveBeenCalledWith(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING);
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(3);
    expect(bumpPlanSurfaceMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale bootstrap value with the freshly revised plan', async () => {
    state.deferredObjectiveActivePlans = planFor('ev-1', 1);
    getSettingMock.mockResolvedValue(planFor('ev-1', 4));
    await reloadDeferredObjectiveActivePlans();
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(4);
  });

  it('clears state when the setting was unset / cleared', async () => {
    state.deferredObjectiveActivePlans = planFor('ev-1', 1);
    getSettingMock.mockResolvedValue(undefined);
    await reloadDeferredObjectiveActivePlans();
    expect(state.deferredObjectiveActivePlans).toBeNull();
    expect(bumpPlanSurfaceMock).toHaveBeenCalledTimes(1);
  });

  it('last write wins when a stale read resolves after a newer one (no clobber)', async () => {
    // Event A launches first and its read resolves LAST; event B launches second
    // and resolves first. The sequence guard must keep B's (newer) value.
    let resolveA: (value: DeferredObjectiveActivePlansV1) => void = () => {};
    const readA = new Promise<DeferredObjectiveActivePlansV1>((resolve) => {
      resolveA = resolve;
    });
    getSettingMock.mockReturnValueOnce(readA);
    getSettingMock.mockResolvedValueOnce(planFor('ev-1', 9));

    const pendingA = reloadDeferredObjectiveActivePlans(); // launched first (stale)
    await reloadDeferredObjectiveActivePlans(); // launched second, resolves first (fresh)
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(9);

    resolveA(planFor('ev-1', 1)); // older read resolves late — must be ignored
    await pendingA;
    expect(state.deferredObjectiveActivePlans?.plansByDeviceId['ev-1']?.latest?.revision).toBe(9);
    expect(bumpPlanSurfaceMock).toHaveBeenCalledTimes(1);
  });
});
