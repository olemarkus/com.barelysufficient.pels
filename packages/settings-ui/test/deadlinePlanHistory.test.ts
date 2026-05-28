import { h, render } from 'preact';
import { describe, expect, it } from 'vitest';
import { DeadlinePlanHistory } from '../src/ui/views/DeadlinePlanHistory.tsx';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';

const buildEntry = (overrides: Partial<DeferredObjectivePlanHistoryEntry> = {}): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-test-1',
  originalPlan: null,
  finalPlan: null,
  deviceId: 'dev_water_heater',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  startedAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
  finalizedAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: Date.UTC(2026, 4, 6, 4, 42, 0),
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [{
    fromMs: Date.UTC(2026, 4, 6, 0, 0, 0),
    toMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  }],
  discoveredFrom: 'observation',
  ...overrides,
});

const mountIntoBody = (vnode: ReturnType<typeof h>): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  render(vnode, mount);
  return mount;
};

describe('DeadlinePlanHistory', () => {
  it('shows the empty state when there are no entries', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [], timeZone: 'UTC' }));
    expect(mount.textContent).toContain('No past plans yet for this device.');
  });

  it('renders a succeeded entry with an ok chip and a reached-at line', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [buildEntry()], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--ok');
    expect(chip?.textContent).toBe('Succeeded');
    // Time formatting uses the system default locale via shared dateUtils helpers, so match
    // the leading HH:mm rather than a fully-rendered locale string.
    expect(mount.textContent).toMatch(/reached at 04:42/);
    expect(mount.textContent).toContain('50.0 °C → 65.0 °C');
    expect(mount.textContent).toContain('target 65.0 °C');
  });

  it('renders a missed entry with a warn chip and no reached-at line', () => {
    const entry = buildEntry({ outcome: 'missed', metAtMs: null, finalProgressC: 58 });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--warn');
    expect(chip?.textContent).toBe('Missed');
    expect(mount.textContent).not.toContain('reached at');
    expect(mount.textContent).toContain('50.0 °C → 58.0 °C');
  });

  it('does not show the stale backup-hours pill when the run leaned on avoid buckets', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry({ usedPolicyAvoid: true })],
      timeZone: 'UTC',
    }));
    expect(mount.textContent).not.toContain('Backup hours');
  });

  it('renders a backfilled entry with a "reconstructed from settings" note', () => {
    const entry = buildEntry({
      outcome: 'unknown',
      discoveredFrom: 'backfill',
      observedIntervals: [],
      startProgressC: null,
      finalProgressC: null,
      metAtMs: null,
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    expect(mount.querySelector('.plan-chip--muted')?.textContent).toBe('Unknown');
    expect(mount.textContent).toContain('reconstructed from settings');
  });

  it('surfaces the planned-hour coverage line from the helper on the list card', () => {
    // DOM smoke test only — the helper's branch math (partial coverage, N=0 actionable
    // case, singularization, no-plan suppression) is pinned in
    // `test/deferredPlanHistoryObservedCoverage.test.ts`. This test only confirms the
    // helper's output reaches `.plan-history-card__coverage` in the rendered list card,
    // using a representative N=0/M=5 missed run because that case is the rewrite's
    // headline motivation (planner allocated active hours, device never drew power).
    const start = Date.UTC(2026, 4, 6, 0, 0, 0);
    const deadline = Date.UTC(2026, 4, 6, 6, 0, 0);
    const HOUR_MS = 60 * 60 * 1000;
    const finalPlan = {
      hours: [
        { startsAtMs: start, plannedKWh: 2 },
        { startsAtMs: start + HOUR_MS, plannedKWh: 2 },
        { startsAtMs: start + 2 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: start + 3 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: start + 4 * HOUR_MS, plannedKWh: 2 },
      ],
      energyNeededKWh: 10,
      planStatus: 'on_track' as const,
      revisedAtMs: start,
    };
    const entry = buildEntry({
      startedAtMs: start,
      deadlineAtMs: deadline,
      finalPlan,
      originalPlan: finalPlan,
      observedIntervals: [],
      outcome: 'missed',
      finalProgressC: 50,
      metAtMs: null,
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    expect(mount.querySelector('.plan-history-card__coverage')?.textContent)
      .toBe('Observed 0 of 5 planned hours');
  });

  it('does not crash when observedIntervals is missing from an entry payload', () => {
    // Regression: the API stub in `deadline-plan-history.spec.ts` predated the v2 contract
    // and returned entries without `observedIntervals`. The coverage helper called `.reduce`
    // on undefined and threw, killing the whole list render. The renderer must tolerate
    // missing coverage data.
    const entry = buildEntry();
    const stripped = entry as unknown as Record<string, unknown>;
    delete stripped.observedIntervals;
    delete stripped.discoveredFrom;
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [stripped as DeferredObjectivePlanHistoryEntry],
      timeZone: 'UTC',
    }));
    // The list and the outcome chip still render.
    expect(mount.querySelector('.plan-history-list')).not.toBeNull();
    expect(mount.querySelector('.plan-chip--ok')?.textContent).toBe('Succeeded');
    expect(mount.querySelector('.plan-history-card__coverage')).toBeNull();
  });

  it('renders an abandoned entry with a muted chip', () => {
    const entry = buildEntry({ outcome: 'abandoned', metAtMs: null });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--muted');
    expect(chip?.textContent).toBe('Abandoned');
  });

  // PR-8 — Abandoned (and Replaced) runs never had PELS-driven progress: the
  // persisted final reading is the temperature at the moment the user cleared
  // the smart task (or the diagnostic stream went stale), not a result the
  // planner produced. Suppress the `→ final` segment so the row reads as
  // "start, target" rather than implying we moved the needle.
  it('suppresses the → final progress arrow on Abandoned past-list rows', () => {
    const entry = buildEntry({
      outcome: 'abandoned',
      metAtMs: null,
      startProgressC: 57.6,
      finalProgressC: 26.0,
      targetTemperatureC: 40,
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const progress = mount.querySelector('.plan-history-card__progress');
    expect(progress?.textContent).toContain('57.6 °C');
    expect(progress?.textContent).toContain('target 40.0 °C');
    expect(progress?.textContent).not.toContain('→');
    expect(progress?.textContent).not.toContain('26.0 °C');
  });

  // v2.9.x batch 47 — past-list card variant of the muted Overshoot line.
  // Producer (`formatPlanHistoryOvershootLine`) decides whether to render; the
  // list card mirrors the threshold treatment from the history-detail hero so
  // users scanning past tasks see the same outlier signal at both surfaces.
  // The thresholds (> 5 °C thermal / > 10 % EV) and copy shape ("Overshoot N
  // unit") are pinned in `test/deferredPlanHistoryPostmortem.test.ts`.
  it('renders the muted overshoot line on the past-list card when a Succeeded run overshoots > 5 °C', () => {
    const entry = buildEntry({
      outcome: 'met',
      startProgressC: 29.3,
      finalProgressC: 77.7,
      targetTemperatureC: 65,
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const overshoot = mount.querySelector('.plan-history-card__overshoot');
    expect(overshoot?.textContent).toBe('Overshoot 12.7 °C');
  });

  it('keeps the past-list card overshoot line quiet on within-threshold Succeeded runs', () => {
    // Default buildEntry: finalProgressC = targetTemperatureC = 65 (no overshoot).
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [buildEntry()], timeZone: 'UTC' }));
    expect(mount.querySelector('.plan-history-card__overshoot')).toBeNull();
  });

  it('renders a replaced entry as abandoned', () => {
    const entry = buildEntry({ outcome: 'replaced', metAtMs: null });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--muted');
    expect(chip?.textContent).toBe('Abandoned');
  });
});
