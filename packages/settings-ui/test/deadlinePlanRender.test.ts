import { afterEach, describe, expect, it } from 'vitest';
import {
  renderDeadlinePlan,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from '../src/ui/views/DeadlinePlan.tsx';
import type { DeadlinePlanHistoryView } from '../src/ui/deadlinePlanHistoryFetch.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import { deadlineLabels } from '../../shared-domain/src/deadlineLabels.ts';

const buildPendingPayload = (): DeadlinePlanPendingPayload => ({
  kind: 'temperature',
  // Minimal shape — the producer normally fills this with rich kind-aware
  // copy, but `PendingHero` only reads the hero block, so this is enough to
  // exercise the render branch.
  labels: {} as DeadlinePlanPendingPayload['labels'],
  hero: {
    chips: [{ text: 'Building plan…', tone: 'info' }],
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

// Builds a minimal ready payload with an at-risk hero whose device-side
// recourse carries a deviceId. Only the hero block matters for the regression;
// the rest is filled with empty defaults so the live-hero render path runs.
const buildReadyPayloadWithDeviceRecourse = (deviceId: string): DeadlinePlanPayload => ({
  kind: 'temperature',
  labels: deadlineLabels('temperature'),
  priceUnitLabel: 'kr/kWh',
  hero: {
    chips: [
      { text: 'Temperature', tone: 'info' },
      { text: 'At risk', tone: 'warn' },
    ],
    tone: 'warn',
    sectionLabel: 'Heating smart task',
    headline: 'Heating from 16:00',
    headlineReason: null,
    subline: 'Connected 300 • Target 22.0 °C by 18:00',
    metaLine: 'Not enough time for this target. Lower the target or move the deadline. Needs 4.0 kWh · 2 hours left · Auto',
    costMetaLine: null,
    deliveredSoFarLine: null,
    recourse: { label: 'Adjust device', targetTab: 'overview', deviceId },
  },
  timeline: {
    ariaLabel: 'Heating smart task',
    progressFloor: 0,
    progressCeilingValue: 22,
    progressCeilingLabel: '22 °C',
    deadlineLabel: 'Mon 18',
    hours: [],
  },
  planInputs: {
    perUnitRateLabel: null,
    perUnitRateNote: null,
    maxPowerLabel: null,
    maxPowerNote: null,
    extraPermissionsValue: null,
    provenanceRows: [],
  },
});

describe('DeadlinePlan loading skeleton', () => {
  it('renders the M3 skeleton primitive instead of a text-only placeholder', () => {
    // The loading branch previously rendered a `<h1>Loading smart task</h1>` +
    // muted text card. Replaced with the canonical `pels-skeleton-stack` so
    // the panel keeps the same shape (hero + card) as the populated state and
    // doesn't flash an oversized title that pushes the rest of the layout
    // around when data arrives. SR text carries the panel copy.
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'loading' });
    const card = mount.querySelector<HTMLElement>('.pels-surface-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('aria-busy')).toBe('true');
    expect(card?.querySelector('.pels-skeleton-stack')).not.toBeNull();
    expect(card?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    expect(card?.querySelector('.visually-hidden')?.textContent).toBe('Loading smart task…');
    // Regression: must NOT regress to the old plain-text loading title.
    expect(card?.querySelector('.plan-card__title')).toBeNull();
  });
});

describe('DeadlinePlan live-hero recourse button', () => {
  it('emits data-deadline-recourse-device-id so the dispatcher can deep-link the device-settings overlay', () => {
    // Regression for the at-risk "Adjust device" recourse dead-ending on the
    // Overview tab without a deviceId. The DeadlineHero JSX must forward the
    // producer-resolved deviceId onto the button's `data-*` attribute so the
    // delegated click handler in `deadlinePlanMount.ts` can dispatch
    // `open-device-detail` after the panel closes — one click instead of
    // "land on Overview, hunt for the device card."
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, {
      status: 'ready',
      payload: buildReadyPayloadWithDeviceRecourse('dev_heater_42'),
    });
    const button = mount.querySelector<HTMLButtonElement>('.plan-hero__recourse .pels-button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-deadline-recourse-tab')).toBe('overview');
    expect(button?.getAttribute('data-deadline-recourse-device-id')).toBe('dev_heater_42');
  });
});
