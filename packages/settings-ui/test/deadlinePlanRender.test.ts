import { afterEach, describe, expect, it } from 'vitest';
import {
  renderDeadlinePlan,
  type DeadlinePlanPendingPayload,
} from '../src/ui/views/DeadlinePlan.tsx';
import type { DeadlinePlanHistoryView } from '../src/ui/deadlinePlanHistoryFetch.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';

const buildPendingPayload = (): DeadlinePlanPendingPayload => ({
  kind: 'temperature',
  // Minimal shape — the producer normally fills this with rich kind-aware
  // copy, but `PendingHero` only reads the hero block, so this is enough to
  // exercise the render branch.
  labels: {} as DeadlinePlanPendingPayload['labels'],
  hero: {
    chips: [{ text: 'Building plan…', tone: 'muted' }],
    sectionLabel: 'Smart task',
    headline: 'Waiting for prices',
    headlineReason: null,
    subline: 'Connected 300',
    metaLine: 'Will start when the next-day price drop publishes.',
    recourse: null,
  },
});

const buildHistoryEntry = (overrides: Partial<DeferredObjectivePlanHistoryEntry> = {}): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-prior-1',
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

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('DeadlinePlan pending branch', () => {
  it('renders only the pending hero when no history has been fetched yet', () => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: buildPendingPayload(),
    });
    expect(mount.querySelector('.pels-hero')).not.toBeNull();
    expect(mount.querySelector('.deadlines-history')).toBeNull();
  });

  it('renders only the pending hero when history fetched empty', () => {
    // Brand-new device with no prior runs — the past-tasks section is
    // intentionally suppressed so the page doesn't show a cosmetic empty
    // stanza directly under "Building plan…".
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: buildPendingPayload(),
      history: { entries: [], timeZone: 'UTC' },
    });
    expect(mount.querySelector('.deadlines-history')).toBeNull();
  });

  it('renders the past-runs list below the pending hero when history is non-empty', () => {
    // Reopens the active task while a new plan is still building — the user
    // gets to see the history evidence (e.g. last week's successful runs)
    // immediately instead of staring at an empty pending hero.
    const mount = mountIntoBody();
    const history: DeadlinePlanHistoryView = {
      entries: [buildHistoryEntry()],
      timeZone: 'UTC',
    };
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: buildPendingPayload(),
      history,
    });
    expect(mount.querySelector('.pels-hero')).not.toBeNull();
    const history$ = mount.querySelector('.deadlines-history');
    expect(history$).not.toBeNull();
    expect(history$?.textContent).toContain('Past tasks');
  });
});
