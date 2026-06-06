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

  // Smart-tasks polish PR-7 — muted "why" reason line under the progress/target
  // line on Missed cards so the scanning user sees the cause without tap-through.
  // The full branch matrix of `formatPlanHistoryMissedReason` is pinned in
  // `test/unit/deferredPlanHistoryPostmortem.test.ts`; this test only confirms the
  // helper's output reaches `.plan-history-card__reason` in the rendered list
  // card and stays hidden on Succeeded / Abandoned rows.
  it('renders the muted reason line on Missed list cards', () => {
    const entry = buildEntry({ outcome: 'missed', metAtMs: null, finalProgressC: 58 });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const reason = mount.querySelector('.plan-history-card__reason');
    expect(reason?.textContent).toBe("Why: Didn't reach the target before the deadline.");
  });

  it('renders the budget-exhausted reason line on Missed list cards when the snapshot recorded the cap', () => {
    const start = Date.UTC(2026, 4, 6, 0, 0, 0);
    const finalPlan = {
      hours: [{ startsAtMs: start, plannedKWh: 2 }],
      energyNeededKWh: 10,
      planStatus: 'cannot_meet' as const,
      revisedAtMs: start,
      dailyBudgetExhaustedBucketCount: 3,
    };
    const entry = buildEntry({
      outcome: 'missed',
      metAtMs: null,
      finalProgressC: 58,
      finalPlan,
      originalPlan: finalPlan,
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const reason = mount.querySelector('.plan-history-card__reason');
    expect(reason?.textContent)
      .toBe('Why: Daily budget filled before the deadline.');
  });

  it('does not render the reason line on Succeeded list cards', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [buildEntry()], timeZone: 'UTC' }));
    expect(mount.querySelector('.plan-history-card__reason')).toBeNull();
  });

  it('does not render the reason line on Abandoned list cards', () => {
    const entry = buildEntry({ outcome: 'abandoned', metAtMs: null });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    expect(mount.querySelector('.plan-history-card__reason')).toBeNull();
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
    // `test/unit/deferredPlanHistoryObservedCoverage.test.ts`. This test only confirms the
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
      .toBe('Observed 0 of 5 scheduled hours');
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
  // unit") are pinned in `test/unit/deferredPlanHistoryPostmortem.test.ts`.
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

  // Cost-on-list-rows — the persisted `totalCost` / `deliveredKWh` totals reach
  // the past-list card as a muted "Cost ≈ X kr · Y kWh delivered" meta line via
  // the list-specific `formatPlanHistoryListCostAndDelivered` producer, which
  // renders WHOLE kroner to match the ISO-week divider roll-up directly above
  // and the history-detail cost chip. The formatter scales + labels with the
  // entry's RECORDED `costDisplay` (legacy entries fall back to øre/kr), so the
  // row survives a later price-scheme switch — no live unit/divisor is injected
  // into the component. The formatter's full branch matrix is pinned in
  // `test/deferredPlanHistory*`; these tests only confirm the line reaches
  // `.plan-history-card__cost` at whole-kr precision when cost is recorded and
  // stays suppressed when it isn't.
  it('renders the cost meta line in whole kroner on a past-list row when totalCost is recorded', () => {
    // `totalCost` is RAW øre; the entry's recorded øre/kr display (divisor 100)
    // scales 1234 øre → 12 kr. Whole kroner (12, not 12.34) — same rounding AND
    // the same plain-space `≈ N kr` spacing the ISO-week divider applies.
    const entry = buildEntry({
      totalCost: 1234,
      deliveredKWh: 18.2,
      costDisplay: { unit: 'kr', divisor: 100 },
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 12 kr · 18.2 kWh delivered');
  });

  it('applies the recorded divisor — 150 øre @ divisor 100 reads "≈ 2 kr", never raw øre as kr', () => {
    // The P1 money bug: without the divisor the raw øre is labelled kr and reads
    // ~100× too high. 150 øre / 100 = 1.5 → Math.round → 2 kr.
    const entry = buildEntry({
      totalCost: 150,
      deliveredKWh: 1.5,
      costDisplay: { unit: 'kr', divisor: 100 },
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 2 kr · 1.5 kWh delivered');
    expect(cost?.textContent).not.toContain('150 kr');
  });

  it('falls back to the recording-era øre/kr default for a legacy entry without a recorded display', () => {
    // No `costDisplay` on the entry (recorded before the field shipped). The
    // formatter must assume øre/kr (divisor 100): 150 øre → ≈ 2 kr. This is the
    // core fix — a legacy øre entry must NOT render under a live Flow divisor.
    const entry = buildEntry({ totalCost: 150, deliveredKWh: 1.5 });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 2 kr · 1.5 kWh delivered');
  });

  it('renders a recorded Flow display (divisor 1, own unit) verbatim, not scaled as øre', () => {
    // A Flow/Homey run records its own amount-shaped total at divisor 1. 12 EUR
    // must read `≈ 12 EUR`, NOT divided by 100 — proves the row honours the
    // entry's recorded scheme rather than assuming øre.
    const entry = buildEntry({
      totalCost: 12,
      deliveredKWh: 4,
      costDisplay: { unit: 'EUR', divisor: 1 },
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 12 EUR · 4.0 kWh delivered');
  });

  it('rounds the cost meta line to whole kroner (matches the week-divider rounding)', () => {
    // 1262 øre → 12.62 kr → rounds up to 13 — guards against a regression back to
    // 2-decimal or truncation. The divider above the row uses Math.round on the
    // summed (scaled) cost, so a single-entry week heading would read "≈ 13 kr";
    // the row must agree.
    const entry = buildEntry({
      totalCost: 1262,
      deliveredKWh: 18.2,
      costDisplay: { unit: 'kr', divisor: 100 },
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('Cost ≈ 13 kr · 18.2 kWh delivered');
  });

  it('suppresses the cost meta line when neither cost nor delivery was recorded', () => {
    // Default buildEntry carries no `totalCost` / `deliveredKWh` (legacy-shaped
    // entry) — the producer returns null and the line must not render.
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry()],
      timeZone: 'UTC',
    }));
    expect(mount.querySelector('.plan-history-card__cost')).toBeNull();
  });

  it('drops the cost half of the line when the recorded cost unit is empty but delivery is recorded', () => {
    // An empty recorded unit (Flow/Homey scheme without a usable `priceUnit`)
    // must not fabricate a bare "Cost ≈ 13" with no currency — the formatter
    // drops the cost clause and keeps the delivered-kWh clause.
    const entry = buildEntry({
      totalCost: 1234,
      deliveredKWh: 18.2,
      costDisplay: { unit: '', divisor: 1 },
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [entry],
      timeZone: 'UTC',
    }));
    const cost = mount.querySelector('.plan-history-card__cost');
    expect(cost?.textContent).toBe('18.2 kWh delivered');
  });
});
