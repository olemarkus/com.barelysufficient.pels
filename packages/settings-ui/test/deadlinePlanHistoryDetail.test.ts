import { h, render } from 'preact';
import { describe, expect, it } from 'vitest';
import { DeadlinePlanHistoryDetail } from '../src/ui/views/DeadlinePlanHistoryDetail.tsx';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 6, 6, 0, 0);

const buildRevision = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [{ startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 2 }],
  energyNeededKWh: 2,
  planStatus: 'on_track',
  revisedAtMs: DEADLINE_MS - 3 * HOUR_MS,
  ...overrides,
});

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-test-1',
  deviceId: 'dev_water_heater',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: DEADLINE_MS - 6 * HOUR_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: DEADLINE_MS - HOUR_MS,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [{ fromMs: DEADLINE_MS - 6 * HOUR_MS, toMs: DEADLINE_MS }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

const mount = (entry: DeferredObjectivePlanHistoryEntry): HTMLElement => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(DeadlinePlanHistoryDetail, { entry, timeZone: 'UTC' }), root);
  return root;
};

describe('DeadlinePlanHistoryDetail', () => {
  it('renders the "no plan detail recorded" fallback when both plan snapshots are null', () => {
    const root = mount(buildEntry({ originalPlan: null, finalPlan: null }));
    expect(root.textContent).toContain('No plan detail was recorded for this run');
    // No revision tables should render in this branch.
    expect(root.querySelector('.plan-history-detail__hours')).toBeNull();
  });

  it('collapses to a single "Plan" section when the two revisions are shape-identical', () => {
    const revision = buildRevision();
    const root = mount(buildEntry({ originalPlan: revision, finalPlan: revision }));
    const headings = Array.from(root.querySelectorAll('.plan-card__title')).map((el) => el.textContent);
    expect(headings).toContain('Plan');
    expect(headings).not.toContain('Original plan');
    expect(headings).not.toContain('Final plan');
    expect(root.querySelectorAll('.plan-history-detail__revision').length).toBe(1);
  });

  it('renders both "Original plan" and "Final plan" sections when the revisions differ', () => {
    const original = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 4 * HOUR_MS, plannedKWh: 1 }],
      energyNeededKWh: 1,
    });
    const final = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 3 }],
      energyNeededKWh: 3,
    });
    const root = mount(buildEntry({ originalPlan: original, finalPlan: final }));
    const headings = Array.from(root.querySelectorAll('.plan-card__title')).map((el) => el.textContent);
    expect(headings).toContain('Original plan');
    expect(headings).toContain('Final plan');
    expect(root.querySelectorAll('.plan-history-detail__revision').length).toBe(2);
  });
});
