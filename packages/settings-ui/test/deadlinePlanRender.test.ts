import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderDeadlinePlan,
  type DeadlinePlanPayload,
  type DeadlinePlanPendingPayload,
} from '../src/ui/views/DeadlinePlan.tsx';
import type { DeadlinePlanHistoryView } from '../src/ui/deadlinePlanHistoryFetch.ts';
import type {
  DeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  deadlineLabels,
  SMART_TASK_EDIT_COPY,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
} from '../../shared-domain/src/deadlineLabels.ts';
import type { SmartTaskEditSnapshot } from '../src/ui/smartTaskEdit.ts';
import { toResolvedLegacyPlanHistoryEntry } from '../../shared-domain/src/deferredPlanHistoryResolvedView.ts';

const buildPendingPayload = (): DeadlinePlanPendingPayload => ({
  kind: 'temperature',
  actionMode: 'edit_and_clear',
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

const buildHistoryEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedLegacyPlanHistoryEntry({
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

  it('offers only Clear task when a separate-meter task cannot be edited', () => {
    const mount = mountIntoBody();
    const onOpen = vi.fn();
    const onClear = vi.fn();
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: {
        ...buildPendingPayload(),
        actionMode: 'clear_only',
      },
      edit: {
        mode: 'clear_only',
        snapshot: null,
        onOpen,
        onClose: vi.fn(),
        onReadyByInput: vi.fn(),
        onTargetInput: vi.fn(),
        onPermissionToggle: vi.fn(),
        onSave: vi.fn(),
        onClear,
      },
    });

    expect(mount.textContent).not.toContain(SMART_TASK_EDIT_COPY.editHint);
    expect(mount.textContent).not.toContain('Edit task');
    expect(mount.textContent).not.toContain('Save changes');
    expect(mount.querySelector('.smart-task-edit__time-input')).toBeNull();

    const clearButton = mount.querySelector<HTMLButtonElement>('.smart-task-edit__clear');
    expect(clearButton?.textContent).toContain('Clear task');
    clearButton?.click();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalledOnce();
  });

  // ─── Extra permissions disclosure in the open editor ──────────────────────

  const buildEditSnapshot = (
    permissions: Partial<SmartTaskEditSnapshot['draft']['permissions']> = {},
    contextOverrides: Partial<SmartTaskEditSnapshot['context']> = {},
  ): SmartTaskEditSnapshot => {
    const resolved = {
      exemptFromBudget: false,
      limitLowerPriorityDevices: false,
      pauseLowerPriorityDevices: false,
      ...permissions,
    };
    return {
      context: {
        deviceId: 'dev_water_heater',
        kind: 'temperature',
        unit: '°C',
        min: 30,
        max: 75,
        step: 0.5,
        baselineReadyBy: '07:00',
        baselineTarget: 65,
        baselineDeadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
        baselinePermissions: resolved,
        supportsLimitLowerPriority: true,
        ...contextOverrides,
      },
      draft: { readyBy: '07:00', target: '65', permissions: resolved },
      dirty: false,
      valid: true,
      busy: 'idle',
      preview: null,
      errorLine: null,
      clearArmed: false,
    };
  };

  const renderEditor = (snapshot: SmartTaskEditSnapshot, onPermissionToggle = vi.fn()) => {
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, {
      status: 'pending',
      pending: buildPendingPayload(),
      edit: {
        mode: 'edit_and_clear',
        snapshot,
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onReadyByInput: vi.fn(),
        onTargetInput: vi.fn(),
        onPermissionToggle,
        onSave: vi.fn(),
        onClear: vi.fn(),
      },
    });
    return mount;
  };

  it('offers every permission toggle in the open editor and reports a toggle by key', () => {
    const onPermissionToggle = vi.fn();
    const mount = renderEditor(buildEditSnapshot(), onPermissionToggle);
    const rows = Array.from(mount.querySelectorAll('.smart-task-edit__permissions .md-switch-row'));
    expect(rows.map((row) => row.querySelector('.md-switch-row__label')?.textContent)).toEqual([
      SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget,
      SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices,
      SMART_TASK_EXTRA_PERMISSION_LABELS.pauseLowerPriorityDevices,
    ]);
    const pauseSwitch = rows[2]!.querySelector('md-switch') as HTMLElement & { selected: boolean };
    pauseSwitch.selected = true;
    pauseSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onPermissionToggle).toHaveBeenCalledWith('pauseLowerPriorityDevices', true);
  });

  it('opens the disclosure when the task already holds a permission', () => {
    const closed = renderEditor(buildEditSnapshot());
    expect(closed.querySelector<HTMLDetailsElement>('.smart-task-edit__permissions')?.open).toBe(false);
    const open = renderEditor(buildEditSnapshot({ exemptFromBudget: true }));
    expect(open.querySelector<HTMLDetailsElement>('.smart-task-edit__permissions')?.open).toBe(true);
  });

  it('gates the limit toggle on the budget exemption and hides it on an ineligible device', () => {
    // The server drops the limit grant unless it is paired with the budget
    // exemption AND the device is stepped-load eligible, so the editor must
    // never render it as a state the save would silently discard.
    const gated = renderEditor(buildEditSnapshot());
    const limitRow = Array.from(gated.querySelectorAll('.smart-task-edit__permissions .md-switch-row'))[1]!;
    expect(limitRow.querySelector('md-switch')?.hasAttribute('disabled')).toBe(true);
    expect(limitRow.textContent).toContain('May go over daily budget');

    const enabled = renderEditor(buildEditSnapshot({ exemptFromBudget: true }));
    const enabledRow = Array.from(enabled.querySelectorAll('.smart-task-edit__permissions .md-switch-row'))[1]!;
    expect(enabledRow.querySelector('md-switch')?.hasAttribute('disabled')).toBe(false);

    const ineligible = renderEditor(buildEditSnapshot({}, { supportsLimitLowerPriority: false }));
    expect(ineligible.textContent).not.toContain(
      SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices,
    );
  });

  it('GUARDRAIL: keeps a STANDING limit grant visible and revocable on an ineligible device', () => {
    // A stepped device can read as non-stepped for the whole post-restart window
    // (`controlModel` is re-derived from live reads). Hiding the toggle then
    // would strand a permission the user still holds: the read-only row is
    // suppressed while the editor is open, so this is its only surface.
    // Eligibility must block turning a NEW grant on, never seeing or clearing an
    // existing one.
    const onPermissionToggle = vi.fn();
    const mount = renderEditor(
      buildEditSnapshot(
        { exemptFromBudget: true, limitLowerPriorityDevices: true },
        { supportsLimitLowerPriority: false },
      ),
      onPermissionToggle,
    );
    const limitRow = Array.from(mount.querySelectorAll('.smart-task-edit__permissions .md-switch-row'))[1]!;
    expect(limitRow.textContent).toContain(
      SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices,
    );
    const limitSwitch = limitRow.querySelector('md-switch') as HTMLElement & { selected: boolean };
    expect(limitSwitch.hasAttribute('disabled')).toBe(false);
    limitSwitch.selected = false;
    limitSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onPermissionToggle).toHaveBeenCalledWith('limitLowerPriorityDevices', false);
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
    headline: 'Heating from 16:00',
    headlineReason: null,
    subline: 'Connected 300 • Target 22.0 °C by 18:00',
    stats: [{ label: 'Needs', value: '4.0 kWh' }],
    metaLine: 'Not enough time for this target. Lower the target or move the deadline.',
    deliveredSoFarLine: null,
    recourse: { label: 'Adjust device', targetTab: 'overview', deviceId },
  },
  timeline: {
    ariaLabel: 'Heating smart task',
    hours: [],
    nowIndex: 0,
    nowAxisX: -0.5,
    deadlineAxisX: 0.5,
    deadlineMarkLabel: 'deadline Mon 18:00',
    cheapestHoursCaption: null,
    planningPriceNote: null,
  },
  trajectory: {
    cardTitle: 'Will it reach 22.0 °C in time?',
    ariaLabel: 'Smart task progress trajectory for Connected 300',
    measuredPoints: [[0, 18]],
    nowPoint: [0, 18],
    plannedPoints: [[0, 18], [3_600_000, 22]],
    runBands: [],
    targetValue: 22,
    targetLabel: 'Target 22.0 °C',
    deadlineAtMs: 7_200_000,
    deadlineMarkLabel: 'deadline',
    deadlineDanger: false,
    xMinMs: 0,
    xMaxMs: 9_000_000,
    yMin: 16,
    yMax: 24,
    yFloorLabel: '16.0 °C',
    stateline: {
      emphasis: '18.0 °C now',
      rest: 'on track — projected ready ≈ Mon 17:00, 1 hour before the deadline',
      tone: 'ok',
      verdict: { label: 'On track', supporting: 'projected ready ≈ Mon 17:00, 1 hour before the deadline' },
    },
    shortfall: null,
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

describe('DeadlinePlan on-track hero status row', () => {
  it('renders the trajectory verdict as a hero status row on the healthy branch', () => {
    // "Am I on track?" must be answerable from the hero without scrolling to
    // the trajectory card's stateline. The row surfaces the check glyph +
    // "On track" label + the projected-ready supporting phrase.
    const payload = buildReadyPayloadWithDeviceRecourse('dev_x');
    payload.hero.tone = 'good';
    payload.hero.recourse = null;
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    const statusRow = mount.querySelector<HTMLElement>('.deadline-hero-status');
    expect(statusRow).not.toBeNull();
    expect(statusRow?.querySelector('.deadline-hero-status__label')?.textContent).toBe('On track');
    expect(statusRow?.querySelector('.deadline-hero-status__supporting')?.textContent)
      .toContain('projected ready ≈');
    expect(statusRow?.querySelector('svg')).not.toBeNull();
  });

  it('suppresses the status row on the at-risk (warn) branch so it never contradicts the chip', () => {
    // The default helper builds a warn/at-risk hero; the status row is
    // healthy-branch only, so the At-risk chip stays the single verdict.
    const payload = buildReadyPayloadWithDeviceRecourse('dev_x');
    expect(payload.hero.tone).toBe('warn');
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    expect(mount.querySelector('.deadline-hero-status')).toBeNull();
  });
});

describe('DeadlinePlan cheapest-hours caption', () => {
  it('renders the producer-resolved caption above the chart-key caption', () => {
    const payload = buildReadyPayloadWithDeviceRecourse('dev_heater_42');
    payload.timeline.cheapestHoursCaption =
      'Picked 2 of the 4 hours it can use · avg 0.15 kr/kWh';
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    const captions = [...mount.querySelectorAll('.deadline-horizon-caption')];
    expect(captions.map((node) => node.textContent)).toEqual([
      'Picked 2 of the 4 hours it can use · avg 0.15 kr/kWh',
      'Filled bars are the picked hours · dimmed bars were not picked',
    ]);
  });

  it('suppresses the trust caption when the producer returns null, keeping the chart key', () => {
    const payload = buildReadyPayloadWithDeviceRecourse('dev_heater_42');
    payload.timeline.cheapestHoursCaption = null;
    const mount = mountIntoBody();
    renderDeadlinePlan(mount, { status: 'ready', payload });
    const captions = [...mount.querySelectorAll('.deadline-horizon-caption')];
    // The one-line key decodes the filled/dimmed bar encoding and renders
    // unconditionally — the chart never ships an unexplained encoding.
    expect(captions.map((node) => node.textContent)).toEqual([
      'Filled bars are the picked hours · dimmed bars were not picked',
    ]);
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
