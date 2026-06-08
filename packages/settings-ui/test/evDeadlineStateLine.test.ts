import { h, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { EvDeadlineStateLine } from '../src/ui/views/PlanDeviceCards.tsx';
import { state } from '../src/ui/state.ts';
import { createEmptyDeferredObjectiveSettings } from '../../contracts/src/deferredObjectiveSettings.ts';
import type { OverviewDeferredObjectiveActivePlan } from '../../contracts/src/deferredObjectiveActivePlans.ts';

// Fixed reference point: 2026-01-01 12:00:00 UTC
const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const ONE_HOUR_MS = 60 * 60 * 1000;
const FUTURE_DEADLINE_MS = NOW_MS + 8 * ONE_HOUR_MS;

const renderStateLine = (deviceId: string, nowMs: number = NOW_MS): HTMLDivElement => {
  const mount = document.createElement('div');
  render(h(EvDeadlineStateLine, { deviceId, nowMs }), mount);
  return mount;
};

const seedEvObjective = (deviceId: string, overrides: { enabled?: boolean; deadlineAtMs?: number } = {}): void => {
  state.deferredObjectiveSettings = {
    version: 1,
    objectivesByDeviceId: {
      [deviceId]: {
        enabled: overrides.enabled ?? true,
        kind: 'ev_soc',
        enforcement: 'soft',
        targetPercent: 80,
        deadlineAtMs: overrides.deadlineAtMs ?? FUTURE_DEADLINE_MS,
      },
    },
  };
};

// The Overview EV-state line reads only the narrow `OverviewDeferredObjectiveActivePlan`
// (`latest` + `diagnosticReasonCode`) off `state.deferredObjectiveActivePlans`, so seed
// exactly that shape — value columns are deliberately unreachable here.
const seedActivePlan = (deviceId: string, plan: OverviewDeferredObjectiveActivePlan): void => {
  state.deferredObjectiveActivePlans = {
    version: 1,
    // Merge rather than replace so a multi-device test can seed plans incrementally.
    plansByDeviceId: { ...state.deferredObjectiveActivePlans?.plansByDeviceId, [deviceId]: plan },
  };
};

const latestWithHours = (
  hours: { startsAtMs: number; plannedKWh: number }[],
  revisedAtMs: number = NOW_MS,
): OverviewDeferredObjectiveActivePlan['latest'] => ({
  revision: 1,
  revisedAtMs,
  computedFromPricesUpTo: null,
  reason: 'flow_card',
  hours,
  energyNeededKWh: 5,
  planStatus: 'on_track',
});

afterEach(() => {
  state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
  state.deferredObjectiveActivePlans = null;
});

describe('EvDeadlineStateLine', () => {
  it('renders nothing when the device has no ev_soc objective', () => {
    const mount = renderStateLine('ev-charger');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('renders nothing when the objective is disabled', () => {
    seedEvObjective('ev-charger', { enabled: false });
    const mount = renderStateLine('ev-charger');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('renders nothing when the deadline has already passed', () => {
    seedEvObjective('ev-charger', { deadlineAtMs: NOW_MS - ONE_HOUR_MS });
    const mount = renderStateLine('ev-charger');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('renders nothing for a temperature objective', () => {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        heater: {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: FUTURE_DEADLINE_MS,
        },
      },
    };
    const mount = renderStateLine('heater');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('renders nothing when there are no active plan hours and plug-out is not set', () => {
    seedEvObjective('ev-charger');
    seedActivePlan('ev-charger', { latest: latestWithHours([]) });
    const mount = renderStateLine('ev-charger');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('shows next-start line when the first planned hour is in the future', () => {
    seedEvObjective('ev-charger');
    const futureStart = NOW_MS + 2 * ONE_HOUR_MS; // 14:00
    seedActivePlan('ev-charger', {
      latest: latestWithHours([{ startsAtMs: futureStart, plannedKWh: 3 }]),
    });
    const el = renderStateLine('ev-charger').querySelector('.plan-card__ev-state');
    expect(el).not.toBeNull();
    expect(el?.textContent).toMatch(/^Waiting · charging starts /);
    // Next-start text starts with "Waiting"
    expect(el?.textContent).toContain('Waiting');
  });

  it('shows active-charging finish line when the current bucket is active', () => {
    seedEvObjective('ev-charger');
    // Started 30 minutes ago, ends in 30 minutes
    const activeStart = NOW_MS - 30 * 60 * 1000;
    seedActivePlan('ev-charger', {
      latest: latestWithHours([{ startsAtMs: activeStart, plannedKWh: 3 }], NOW_MS - ONE_HOUR_MS),
    });
    const el = renderStateLine('ev-charger').querySelector('.plan-card__ev-state');
    expect(el).not.toBeNull();
    expect(el?.textContent).toMatch(/^Charging · planned finish /);
    // Active-charging text starts with "Charging"
    expect(el?.textContent).toContain('Charging');
  });

  it('shows plug-out paused line when diagnosticReasonCode is objective_invalid_session', () => {
    seedEvObjective('ev-charger');
    seedActivePlan('ev-charger', { latest: null, diagnosticReasonCode: 'objective_invalid_session' });
    const el = renderStateLine('ev-charger').querySelector('.plan-card__ev-state');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('Charging paused — car unplugged');
  });

  it('does not show plug-out paused when device_data_missing but no specific diagnostic reason', () => {
    seedEvObjective('ev-charger');
    // No diagnosticReasonCode — generic missing data
    seedActivePlan('ev-charger', { latest: null });
    const mount = renderStateLine('ev-charger');
    expect(mount.querySelector('.plan-card__ev-state')).toBeNull();
  });

  it('prefers active-charging over plug-out when hours are active and session is invalid', () => {
    // Edge case: session went invalid mid-hour but hours array is still populated.
    // Active-charging is more actionable than plug-out paused.
    seedEvObjective('ev-charger');
    const activeStart = NOW_MS - 30 * 60 * 1000;
    seedActivePlan('ev-charger', {
      latest: latestWithHours([{ startsAtMs: activeStart, plannedKWh: 3 }], NOW_MS - ONE_HOUR_MS),
      diagnosticReasonCode: 'objective_invalid_session',
    });
    const el = renderStateLine('ev-charger').querySelector('.plan-card__ev-state');
    // Active charging takes priority over plug-out
    expect(el?.textContent).toMatch(/^Charging · planned finish /);
  });
});
