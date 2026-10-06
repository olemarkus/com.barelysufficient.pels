import { h, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanGenericCard } from '../src/ui/views/PlanDeviceCards.tsx';
import { resolveEvCardStateLines } from '../src/ui/evCardStateLine.ts';
import { state } from '../src/ui/state.ts';
import { createEmptyDeferredObjectiveSettings } from '../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import type { OverviewDeferredObjectiveActivePlans } from '../../contracts/src/deferredObjectiveActivePlans.ts';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemantics.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 1, 30, 0);
const CHARGER_ID = 'zaptec-1';

const seedEvTask = (
  hours: number[],
  options: { diagnosticReasonCode?: string; enabled?: boolean; plannedKWh?: (startsAtMs: number) => number } = {},
): void => {
  state.deferredObjectiveSettings = {
    version: 1,
    objectivesByDeviceId: {
      [CHARGER_ID]: { enabled: options.enabled ?? true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80,
        deadlineAtMs: NOW_MS + 6 * HOUR_MS },
    },
  };
  state.deferredObjectiveActivePlans = {
    version: 1,
    plansByDeviceId: {
      [CHARGER_ID]: {
        latest: { hours: hours.map((startsAtMs) => ({ startsAtMs, plannedKWh: options.plannedKWh?.(startsAtMs) ?? 1 })) },
        ...(options.diagnosticReasonCode ? { diagnosticReasonCode: options.diagnosticReasonCode } : {}),
      },
    },
  } as unknown as OverviewDeferredObjectiveActivePlans;
};

const formatTime = (ms: number): string => (
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

afterEach(() => {
  state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
  state.deferredObjectiveActivePlans = null;
});

describe('resolveEvCardStateLines', () => {
  it('gives the planned finish while a planned hour runs', () => {
    const currentHour = Date.UTC(2026, 0, 1, 1, 0, 0);
    seedEvTask([currentHour, currentHour + HOUR_MS]);
    expect(resolveEvCardStateLines(NOW_MS).get(CHARGER_ID))
      .toBe(`Charging · planned finish ${formatTime(currentHour + 2 * HOUR_MS)}`);
  });

  it('names the next planned start between planned hours', () => {
    const nextHour = Date.UTC(2026, 0, 1, 3, 0, 0);
    seedEvTask([nextHour]);
    expect(resolveEvCardStateLines(NOW_MS).get(CHARGER_ID)).toBe(`Waiting · charging starts ${formatTime(nextHour)}`);
  });

  it('does not call a hour booked at 0 kWh charging', () => {
    // Booked on price with no forecast room: the task may run there, but nothing is
    // promised, so the card names the next hour that does promise energy.
    const currentHour = Date.UTC(2026, 0, 1, 1, 0, 0);
    const nextHour = currentHour + 2 * HOUR_MS;
    seedEvTask([currentHour, nextHour], { plannedKWh: (startsAtMs) => (startsAtMs === currentHour ? 0 : 1) });
    expect(resolveEvCardStateLines(NOW_MS).get(CHARGER_ID)).toBe(`Waiting · charging starts ${formatTime(nextHour)}`);
  });

  it('omits a charger whose task is disabled', () => {
    seedEvTask([Date.UTC(2026, 0, 1, 1, 0, 0)], { enabled: false });
    expect(resolveEvCardStateLines(NOW_MS).has(CHARGER_ID)).toBe(false);
  });
});

describe('on/off charger card EV smart-task line', () => {
  const renderReason = (device: Record<string, unknown>, evStateLine: string | null): string | undefined => {
    const mount = document.createElement('div');
    render(h(PlanGenericCard, { dev: uiDeviceFixture({ id: CHARGER_ID, name: 'Charger', isEvCharger: true,
      ...device }, false, NOW_MS), dryRun: false, nowMs: NOW_MS, evStateLine }), mount);
    return mount.querySelector('.plan-card__reason')?.textContent?.trim();
  };

  it('fills the reason slot when the device status carries no reason', () => {
    expect(renderReason({ currentState: 'on', plannedState: 'keep' }, 'Charging · planned finish 03:00'))
      .toBe('Charging · planned finish 03:00');
  });

  it('leaves the slot to the device reason when one renders', () => {
    expect(renderReason({ currentState: 'off', plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.dailyBudget } }, 'Charging · planned finish 03:00'))
      .not.toMatch(/planned finish/);
  });
});
