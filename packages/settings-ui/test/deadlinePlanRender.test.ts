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

  it('renders the pending-hero metaLine on the un-muted action tone', () => {
    // The metaLine on the pending hero carries the "why is this still
    // building?" copy — the most actionable string on the surface. It must
    // render via `plan-hero__subline--action` (primary text colour) instead
    // of the secondary `--muted` tone the ready hero uses for its recap
    // meta/cost lines. Regression for the P2 contrast issue called out in
    // TODO ~2301: muted secondary on a dark surface demoted the most
    // important call-to-action on the panel.
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: buildPendingPayload(),
    });
    const sublines = Array.from(mount.querySelectorAll('.plan-hero__subline'));
    const metaLine = sublines.find((node) =>
      node.textContent?.includes('Will start when the next-day price drop publishes.'),
    );
    expect(metaLine).not.toBeUndefined();
    expect(metaLine?.classList.contains('plan-hero__subline--action')).toBe(true);
    expect(metaLine?.classList.contains('plan-hero__subline--muted')).toBe(false);
  });

  // Liveness pulse on the pending hero's "Building plan…" chip. The pending
  // hero can sit in this state for tens of seconds while waiting on price
  // publishes / device samples; a static pill reads identically whether
  // planning just started or has been stuck. The chip opts into the canonical
  // `.plan-chip[data-pulse="true"]` animation (CSS in `public/style.css`)
  // routed through `--pels-motion-pulse-duration`. Every other chip on the
  // pending hero (kind, paused — unplugged) stays still.
  it('marks the chip whose payload carries pulse=true with data-pulse on the pending hero', () => {
    const mount = mountIntoBody();
    const payload = buildPendingPayload();
    payload.hero = {
      ...payload.hero,
      chips: [
        { text: 'Temperature', tone: 'info' },
        { text: 'Building plan…', tone: 'info', pulse: true },
      ],
    };
    renderDeadlinePlan(mount, { status: 'pending', pending: payload });
    const chips = Array.from(mount.querySelectorAll<HTMLElement>('.plan-chip'));
    const building = chips.find((el) => (el.textContent ?? '').trim() === 'Building plan…');
    const kind = chips.find((el) => (el.textContent ?? '').trim() === 'Temperature');
    expect(building?.getAttribute('data-pulse')).toBe('true');
    expect(kind?.getAttribute('data-pulse')).toBeNull();
  });

  it('omits data-pulse when no chip carries pulse (e.g. paused — unplugged)', () => {
    const mount = mountIntoBody();
    const payload = buildPendingPayload();
    payload.hero = {
      ...payload.hero,
      chips: [
        { text: 'EV charging', tone: 'info' },
        { text: 'Paused — unplugged', tone: 'warn' },
      ],
    };
    renderDeadlinePlan(mount, { status: 'pending', pending: payload });
    const chips = Array.from(mount.querySelectorAll<HTMLElement>('.plan-chip'));
    chips.forEach((chip) => {
      expect(chip.getAttribute('data-pulse')).toBeNull();
    });
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
    cheapestHoursCaption: null,
  },
  planInputs: {
    perUnitRateLabel: null,
    perUnitRateNote: null,
    maxPowerLabel: null,
    maxPowerNote: null,
    extraPermissionsValue: null,
    provenanceRows: [],
  },
  revisionLog: [], revisionSummary: { text: null, count: 0, shouldShowPanel: false },
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

describe('DeadlinePlan cheapest-hours caption', () => {
  it('renders the producer-resolved caption under the horizon chart', () => {
    const payload = buildReadyPayloadWithDeviceRecourse('dev_heater_42');
    payload.timeline.cheapestHoursCaption =
      'Picked 2 of 4 hours · avg 0.15 vs window avg 0.50 kr/kWh';
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    const caption = mount.querySelector('.deadline-horizon-caption');
    expect(caption).not.toBeNull();
    expect(caption?.textContent).toBe(
      'Picked 2 of 4 hours · avg 0.15 vs window avg 0.50 kr/kWh',
    );
  });

  it('suppresses the caption slot when the producer returns null', () => {
    const payload = buildReadyPayloadWithDeviceRecourse('dev_heater_42');
    payload.timeline.cheapestHoursCaption = null;
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    expect(mount.querySelector('.deadline-horizon-caption')).toBeNull();
  });
});

describe('DeadlinePlan revision history panel', () => {
  it('suppresses the panel when every revision was a user-fired Flow card (no system narrative)', () => {
    // The gate is reason-based, not count-based: a brand-new task whose only
    // revisions are user-fired Flow cards has nothing the user doesn't
    // already know, so the panel is suppressed regardless of count.
    const mount = mountIntoBody();
    const payload = buildReadyPayloadWithDeviceRecourse('dev_x');
    payload.revisionLog = [
      { revision: 1, timeLabel: '14:00', reason: 'Updated by a Flow card', isFallback: false, hourDiff: null, hourDiffAriaLabel: null },
    ];
    payload.revisionSummary = { text: null, count: 1, shouldShowPanel: false };
    renderDeadlinePlan(mount, { status: 'ready', payload });
    expect(mount.querySelector('.plan-revision-panel')).toBeNull();
  });

  it('renders a collapsed `<details>` panel with most-recent-first rows when at least one revision is system-initiated', () => {
    const mount = mountIntoBody();
    const payload = buildReadyPayloadWithDeviceRecourse('dev_x');
    payload.revisionLog = [
      { revision: 3, timeLabel: '15:42', reason: 'Schedule revised', isFallback: false, hourDiff: '+1h', hourDiffAriaLabel: '1 hour added' },
      { revision: 2, timeLabel: '15:00', reason: 'Prices arrived', isFallback: false, hourDiff: '−1h', hourDiffAriaLabel: '1 hour dropped' },
      { revision: 1, timeLabel: '14:00', reason: 'Updated by a Flow card', isFallback: false, hourDiff: null, hourDiffAriaLabel: null },
    ];
    payload.revisionSummary = {
      text: 'Schedule revised · 15:42 · +1h',
      count: 3,
      shouldShowPanel: true,
    };
    renderDeadlinePlan(mount, { status: 'ready', payload });

    const panel = mount.querySelector<HTMLDetailsElement>('.plan-revision-panel');
    expect(panel).not.toBeNull();
    // Default-collapsed per the m3 design call.
    expect(panel?.open).toBe(false);
    // Summary line surfaces the latest system revision's reason/time/diff so
    // users can decide whether to expand without committing to a tap. The
    // pre-formatted string comes from `revisionSummary.text` (producer
    // resolved). Interpunct U+00B7 separates the clauses so reason labels
    // whose last words form verb phrases don't parse into the time clause.
    //
    // Lives OUTSIDE the `<details>` so it's visible while the panel is
    // collapsed (HTML hides every child of `<details>` except `<summary>`
    // when closed) — the at-rest "why?" answer is the discoverability
    // gain for users who don't bother expanding the panel.
    const subline = mount.querySelector('.plan-revision-panel__summary-subline');
    expect(subline?.textContent).toBe('Schedule revised · 15:42 · +1h');
    expect(panel?.contains(subline)).toBe(false);
    // Eyebrow distinguishes this live-task panel from the post-finalization
    // history-detail card (which uses "After this task ran"). Scope the
    // query to the panel's containing section — the page hero also renders
    // an `.eyebrow` (`section label`) so a `mount`-wide query would pick
    // that one up instead of the revision-panel's "Live" tag.
    const eyebrow = panel?.parentElement?.querySelector('.eyebrow');
    expect(eyebrow?.textContent).toBe('Live');
    // The `<summary>` row carries only the heading + chevron now; the
    // subline was lifted out so it stays visible at-rest.
    expect(panel?.querySelector('summary .section-hint')).toBeNull();
    // Most-recent first; head row carries the latest reason and its hour-diff.
    const rows = Array.from(mount.querySelectorAll<HTMLElement>('.plan-revision-row'));
    expect(rows.map((r) => r.querySelector('.plan-revision-reason')?.textContent)).toEqual([
      'Schedule revised',
      'Prices arrived',
      'Updated by a Flow card',
    ]);
    expect(rows[0]?.querySelector('.plan-revision-diff')?.textContent).toBe('+1h');
    // The diff chip carries an aria-label / title so screen readers don't
    // pronounce `+1h` as "plus one h".
    expect(rows[0]?.querySelector('.plan-revision-diff')?.getAttribute('aria-label')).toBe('1 hour added');
    expect(rows[0]?.querySelector('.plan-revision-diff')?.getAttribute('title')).toBe('1 hour added');
    // The oldest row (no prior to diff against) suppresses the diff chip.
    expect(rows[2]?.querySelector('.plan-revision-diff')).toBeNull();
  });

  it('renders the longer fallback reason copy and suppresses the diff chip when isFallback === true', () => {
    // Regression for the "Plan refreshed" row reading as an empty-handed
    // narration: when the resolver fell back (unknown recorder code), the
    // row template now reads `Plan refreshed (details unavailable)` so the
    // absent `+/−Nh` chip is self-explanatory. Producer summary copy stays
    // on the bare `Plan refreshed` (see activePlanRevisionLog summary test).
    const mount = mountIntoBody();
    const payload = buildReadyPayloadWithDeviceRecourse('dev_x');
    payload.revisionLog = [
      {
        revision: 2,
        timeLabel: '15:42',
        reason: 'Plan refreshed',
        isFallback: true,
        // Producer would happily compute a diff; the view suppresses it on
        // fallback rows because the longer reason copy alone explains the
        // gap and the chip would mis-attribute to a vague label.
        hourDiff: '+1h',
        hourDiffAriaLabel: '1 hour added',
      },
      {
        revision: 1,
        timeLabel: '14:00',
        reason: 'Prices arrived',
        isFallback: false,
        hourDiff: null,
        hourDiffAriaLabel: null,
      },
    ];
    payload.revisionSummary = {
      text: 'Plan refreshed · 15:42',
      count: 2,
      shouldShowPanel: true,
    };
    renderDeadlinePlan(mount, { status: 'ready', payload });

    const rows = Array.from(mount.querySelectorAll<HTMLElement>('.plan-revision-row'));
    expect(rows[0]?.querySelector('.plan-revision-reason')?.textContent).toBe(
      'Plan refreshed (details unavailable)',
    );
    expect(rows[0]?.querySelector('.plan-revision-diff')).toBeNull();
    // Non-fallback row keeps the producer-resolved short label.
    expect(rows[1]?.querySelector('.plan-revision-reason')?.textContent).toBe('Prices arrived');
  });
});
