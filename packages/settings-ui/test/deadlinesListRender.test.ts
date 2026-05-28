import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  renderDeadlinesList,
  type DeadlinesListCard,
} from '../src/ui/views/DeadlinesList.tsx';
import {
  renderDeadlinesHistoryList,
} from '../src/ui/views/DeadlinesHistoryList.tsx';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 4, 16, 6, 50, 0);

const buildCard = (overrides: Partial<DeadlinesListCard> = {}): DeadlinesListCard => ({
  deviceId: 'dev_water_heater',
  deviceName: 'Connected 300',
  kind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  firstActionAtMs: T0,
  deadlineAtMs: T0 + 6 * HOUR_MS,
  href: './?page=deadline-plan&deviceId=dev_water_heater',
  statusId: 'on_track',
  confidence: null,
  learning: false,
  extraPermissionsValue: null,
  currentValueLine: null,
  ...overrides,
});

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

// Each test appends a fresh mount to `document.body`; clean up between runs
// so the subline-affordance scroll handler (which uses
// `document.querySelectorAll('.deadline-list-card')`) can't pick up cards
// rendered by an earlier test in the same file.
afterEach(() => {
  document.body.replaceChildren();
});

describe('DeadlinesList', () => {
  it('maps medium confidence to the live-hero chip vocabulary while learning on a recoverable card', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'medium', statusId: 'at_risk', learning: true })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).toContain('Refining');
    expect(chips).not.toContain('Confidence medium');
  });

  it('maps low confidence to the live-hero chip vocabulary while learning on a recoverable card', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'low', statusId: 'at_risk', learning: true })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).toContain('Estimating');
  });

  it('stays silent on on_track cards even while learning', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'low', statusId: 'on_track', learning: true })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).not.toContain('Estimating');
  });

  it('suppresses the chip once the rate is learned (not cold-start)', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'low', statusId: 'at_risk', learning: false })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).not.toContain('Estimating');
  });

  it('omits the confidence chip when no band is available', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: null, statusId: 'at_risk', learning: true })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).not.toContain('Estimating');
    expect(chips).not.toContain('Refining');
  });

  it('omits the confidence chip for high confidence', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'high' })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).not.toContain('Estimating');
    expect(chips).not.toContain('Refining');
    expect(chips.some((text) => text.startsWith('Confidence'))).toBe(false);
  });

  it('suppresses the confidence chip on cannot_meet cards', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'cannot_meet', confidence: 'low' })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).toContain('Cannot finish');
    expect(chips).not.toContain('Estimating');
  });

  it('renders the currently-X line when the producer supplies one', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ currentValueLine: 'currently 18.4 °C' })],
    });
    expect(mount.querySelector('.deadline-list-card__current')?.textContent).toBe('currently 18.4 °C');
  });

  it('omits the currently-X line when the device value is unknown', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ currentValueLine: null })],
    });
    expect(mount.querySelector('.deadline-list-card__current')).toBeNull();
  });

  // Active-card timestamp rows: the list card surfaces "Starts" and "Ready by".
  // The "Created" row used to render above Starts and showed the same timestamp
  // in nearly every case (a task starts on creation), so it added a noisy
  // duplicate. Detail-page audit-trail kept this signal; the list card drops it.
  it('omits the Created row from the active-card timestamp list', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'on_track' })],
    });
    const whenLabels = Array.from(
      mount.querySelectorAll<HTMLElement>('.deadline-list-card__when dt'),
    ).map((el) => (el.textContent ?? '').trim());
    expect(whenLabels).not.toContain('Created');
    expect(whenLabels).toEqual(expect.arrayContaining(['Starts', 'Ready by']));
  });

  it('renders extra permissions when the producer supplies them', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ extraPermissionsValue: 'May go over daily budget' })],
    });
    expect(mount.textContent).toContain('Extra permissions');
    expect(mount.textContent).toContain('May go over daily budget');
  });

  // Status-tone parity on the "Ready by" row: an active card with a
  // `cannot_meet` chip used to render the deadline in success-green, which
  // contradicted the alert pill. The row now mirrors the chip tone — demoted
  // to `warn` so the hero gradient + status chip carry the red weight without
  // a third red surface stacking on the timestamp.
  it('renders the "Ready by" row with the warn variant on cannot_meet cards', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'cannot_meet' })],
    });
    expect(mount.querySelector('.deadline-list-card__when-row--accent')).toBeNull();
    expect(mount.querySelector('.deadline-list-card__when-row--warn')).not.toBeNull();
  });

  it('renders the "Ready by" row with the warn variant on at_risk cards', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'at_risk' })],
    });
    expect(mount.querySelector('.deadline-list-card__when-row--warn')).not.toBeNull();
  });

  it('keeps the accent variant on healthy on_track cards', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'on_track' })],
    });
    expect(mount.querySelector('.deadline-list-card__when-row--accent')).not.toBeNull();
  });

  // Populated-state hero (v2.7.3 loveable batch). The renderer asks the shared
  // resolver for a hero copy and mounts it above the card list. The hero is
  // suppressed for empty `cards` arrays (the empty-state paragraph already
  // owns that voice) and present otherwise — the four assertions below pin
  // both branches plus the headline / subline mounting points so regressions
  // surface on this view rather than on the resolver alone.
  it('renders the populated-state hero above the card list', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ statusId: 'on_track' })],
    });
    const hero = mount.querySelector('.deadlines-list-hero');
    expect(hero).not.toBeNull();
    expect(hero?.querySelector('.plan-hero__headline')?.textContent).toBe('1 deadline on track.');
    expect(hero?.querySelector('.plan-hero__subline')?.textContent).toContain('Connected 300');
  });

  it('escalates the populated-state hero tone when any card is at risk', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [
        buildCard({ statusId: 'on_track' }),
        buildCard({ deviceId: 'dev_boiler', deviceName: 'Boiler', statusId: 'at_risk' }),
      ],
    });
    const hero = mount.querySelector('.deadlines-list-hero');
    expect(hero?.getAttribute('data-tone')).toBe('warn');
    expect(hero?.querySelector('.plan-hero__headline')?.textContent).toBe('1 of 2 deadlines at risk.');
  });

  it('does not render the populated-state hero on the empty state', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, { status: 'ready', cards: [] });
    // The populated hero (with a status-derived headline and the navigation
    // subline button) must not mount on the empty state — only the baseline
    // header variant is allowed there. Per TODO #1041 the panel still keeps
    // a visible "Smart tasks" header in every state, so we assert specifically
    // that the populated-hero affordance is absent rather than the entire
    // `.deadlines-list-hero` shell.
    expect(mount.querySelector('.deadlines-list-hero__nav-target')).toBeNull();
    // No tone escalation — the baseline header stays neutral.
    expect(mount.querySelector('.deadlines-list-hero[data-tone="warn"]')).toBeNull();
    expect(mount.querySelector('.deadlines-list-hero[data-tone="alert"]')).toBeNull();
    expect(mount.querySelector('.deadlines-list-hero[data-tone="good"]')).toBeNull();
  });

  // Subline affordance: when the resolver emits a sublineTarget, the subline
  // wraps in a button that scrolls the named card into view. Verifies the
  // button mounts with the correct data attribute and that clicking it
  // dispatches `scrollIntoView` on the matching card row.
  it('renders the subline as a button keyed to the named card', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [
        buildCard({ deviceId: 'dev_water_heater', statusId: 'on_track' }),
        buildCard({ deviceId: 'dev_boiler', deviceName: 'Boiler', statusId: 'on_track' }),
      ],
    });
    const button = mount.querySelector<HTMLButtonElement>('.deadlines-list-hero__nav-target');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-deadline-card-id')).toBe('dev_water_heater');
  });

  // Header-persistence parity: the panel must keep a visible title/header in
  // every state (loading / error / empty / ready) so the Smart tasks tab
  // matches the Overview / Budget / Usage / Settings rhythm. Regression guard
  // for TODO #1041 — the v2.7.2 hero PR dropped the static `<h2>Smart tasks</h2>`
  // and left the panel headerless in non-populated states.
  describe('header persistence across states', () => {
    const expectHeaderVisible = (mount: HTMLElement): void => {
      // A persistent header has both the eyebrow ("Smart tasks") and a
      // non-empty headline (`<h2>`), mounted inside a `.pels-hero` / `.plan-hero`
      // shell — matches the populated hero shape so the panel keeps its
      // section label and title in every state.
      const headlines = Array.from(
        mount.querySelectorAll<HTMLElement>('.plan-hero__headline'),
      );
      expect(headlines.length).toBeGreaterThan(0);
      expect(headlines.some((el) => (el.textContent ?? '').trim().length > 0)).toBe(true);
      const eyebrows = Array.from(
        mount.querySelectorAll<HTMLElement>('.eyebrow'),
      ).map((el) => el.textContent ?? '');
      expect(eyebrows).toContain('Smart tasks');
    };

    it('renders the header in the loading state', () => {
      const mount = mountIntoBody();
      renderDeadlinesList(mount, { status: 'loading' });
      expectHeaderVisible(mount);
    });

    it('renders the header in the error state', () => {
      const mount = mountIntoBody();
      renderDeadlinesList(mount, { status: 'error', message: 'Network error.' });
      expectHeaderVisible(mount);
      expect(mount.textContent).toContain('Network error.');
    });

    it('renders the header in the empty state', () => {
      const mount = mountIntoBody();
      renderDeadlinesList(mount, { status: 'ready', cards: [] });
      expectHeaderVisible(mount);
      // Empty-state copy still mounts below the header.
      expect(mount.textContent).toContain('No smart tasks yet');
    });

    it('renders the header in the ready (populated) state', () => {
      const mount = mountIntoBody();
      renderDeadlinesList(mount, {
        status: 'ready',
        cards: [buildCard({ statusId: 'on_track' })],
      });
      expectHeaderVisible(mount);
    });
  });

  // Liveness pulse on the "Building plan…" status chip. The planner can sit
  // in this state for tens of seconds while waiting on price publishes /
  // device samples, and a static pill reads identically whether planning just
  // started or has been stuck. The chip opts into the canonical
  // `.plan-chip[data-pulse="true"]` animation (CSS in `public/style.css`)
  // routed through `--pels-motion-pulse-duration`. Every other list status
  // is a settled state and must stay still.
  describe('building-plan status chip pulse signal', () => {
    const findChipByLabel = (mount: HTMLElement, label: string): HTMLElement | null => (
      Array.from(mount.querySelectorAll<HTMLElement>('.plan-chip'))
        .find((el) => (el.textContent ?? '').trim() === label) ?? null
    );

    it('marks the status chip with data-pulse="true" on building_plan cards', () => {
      const mount = mountIntoBody();
      renderDeadlinesList(mount, {
        status: 'ready',
        cards: [buildCard({ statusId: 'building_plan' })],
      });
      const chip = findChipByLabel(mount, 'Building plan…');
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute('data-pulse')).toBe('true');
    });

    it('omits data-pulse on settled status cards (on_track / at_risk / cannot_meet / satisfied / queued / paused)', () => {
      const settledStatuses = [
        'on_track',
        'at_risk',
        'cannot_meet',
        'satisfied',
        'queued',
        'paused_unplugged',
      ] as const;
      settledStatuses.forEach((statusId) => {
        document.body.replaceChildren();
        const mount = mountIntoBody();
        renderDeadlinesList(mount, {
          status: 'ready',
          cards: [buildCard({ statusId })],
        });
        const chips = Array.from(mount.querySelectorAll<HTMLElement>('.plan-chip'));
        chips.forEach((chip) => {
          expect(chip.getAttribute('data-pulse')).toBeNull();
        });
      });
    });
  });

  it('scrolls the named card into view when the subline affordance is clicked', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [
        buildCard({ deviceId: 'dev_water_heater', statusId: 'on_track' }),
        buildCard({ deviceId: 'dev_boiler', deviceName: 'Boiler', statusId: 'on_track' }),
      ],
    });
    const card = mount.querySelector<HTMLElement>('.deadline-list-card[data-device-id="dev_water_heater"]');
    expect(card).not.toBeNull();
    const scrollSpy = vi.fn();
    if (card) card.scrollIntoView = scrollSpy;
    const button = mount.querySelector<HTMLButtonElement>('.deadlines-list-hero__nav-target');
    button?.click();
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});

describe('DeadlinesHistoryList', () => {
  it('renders the empty-state stanza when no past tasks exist', () => {
    const mount = mountIntoBody();
    renderDeadlinesHistoryList(mount, { status: 'empty' });
    expect(mount.querySelector('.deadlines-history')).not.toBeNull();
    expect(mount.textContent).toContain('Past tasks');
    expect(mount.textContent).toContain('No completed tasks yet');
  });

  it('still suppresses the entire section when state is hidden', () => {
    // The `hidden` state remains for callers that want to genuinely suppress
    // the section (e.g. before the history endpoint resolves). It must not
    // render any text — the new empty stanza is opt-in via `empty`.
    const mount = mountIntoBody();
    renderDeadlinesHistoryList(mount, { status: 'hidden' });
    expect(mount.querySelector('.deadlines-history')).toBeNull();
  });

  it('renders the M3 skeleton primitive in the loading state', () => {
    // Past tasks loading shares the canonical `pels-skeleton-stack` shape with
    // the other panels — no bespoke spinner / text-only fallback. The SR text
    // carries the panel-specific copy so assistive tech announces which list
    // is loading instead of a generic "loading" string.
    const mount = mountIntoBody();
    renderDeadlinesHistoryList(mount, { status: 'loading' });
    const section = mount.querySelector('.deadlines-history');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('aria-busy')).toBe('true');
    expect(section?.querySelector('.pels-skeleton-stack')).not.toBeNull();
    expect(section?.querySelectorAll('.pels-skeleton').length).toBeGreaterThan(0);
    const srText = section?.querySelector('.visually-hidden');
    expect(srText?.textContent).toBe('Loading past tasks…');
  });
});

// v2.7.4 — past-tasks device-filter chip row (PR-19). Lets the user collapse
// the archive to a single device with persistent state.
describe('DeadlinesHistoryList device-filter chip row', () => {
  const DEADLINE_BASE = Date.UTC(2026, 4, 16, 16, 0, 0);

  const buildHistoryEntry = (
    deviceId: string,
    deviceName: string,
    offsetHours: number,
  ): DeferredObjectivePlanHistoryEntry => ({
    id: `${deviceId}-${offsetHours}`,
    deviceId,
    deviceName,
    objectiveKind: 'temperature',
    targetTemperatureC: 65,
    targetPercent: null,
    deadlineAtMs: DEADLINE_BASE - offsetHours * HOUR_MS,
    startedAtMs: DEADLINE_BASE - (offsetHours + 6) * HOUR_MS,
    finalizedAtMs: DEADLINE_BASE - offsetHours * HOUR_MS,
    startProgressC: 50,
    startProgressPercent: null,
    finalProgressC: 65,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 4,
    outcome: 'met',
    metAtMs: DEADLINE_BASE - offsetHours * HOUR_MS,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation',
    originalPlan: null,
    finalPlan: null,
  });

  const renderReady = (mount: HTMLElement, params: {
    entries: DeferredObjectivePlanHistoryEntry[];
    selectedDeviceId?: string | null;
    onSelectDevice?: (deviceId: string | null) => void;
  }): void => {
    renderDeadlinesHistoryList(mount, {
      status: 'ready',
      entries: params.entries,
      timeZone: 'UTC',
      selectedDeviceId: params.selectedDeviceId ?? null,
      onSelectDevice: params.onSelectDevice ?? (() => {}),
    });
  };

  const findChip = (mount: HTMLElement, label: string): HTMLButtonElement | null => (
    Array.from(mount.querySelectorAll<HTMLButtonElement>('.deadlines-history__filter-row .plan-chip'))
      .find((el) => (el.textContent ?? '').trim() === label) ?? null
  );

  it('renders the chip row with an "All" chip and one chip per unique device', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
        buildHistoryEntry('dev_a', 'Boiler', 4),
      ],
    });
    const chips = Array.from(
      mount.querySelectorAll<HTMLElement>('.deadlines-history__filter-row .plan-chip'),
    ).map((el) => (el.textContent ?? '').trim());
    expect(chips).toEqual(['All', 'Boiler', 'Connected 300']);
  });

  it('marks "All" with aria-pressed=true when no filter is active', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
      selectedDeviceId: null,
    });
    expect(findChip(mount, 'All')?.getAttribute('aria-pressed')).toBe('true');
    expect(findChip(mount, 'Boiler')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks the selected device chip with aria-pressed=true', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
      selectedDeviceId: 'dev_b',
    });
    expect(findChip(mount, 'Connected 300')?.getAttribute('aria-pressed')).toBe('true');
    expect(findChip(mount, 'All')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('filters the archive to the selected device', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
        buildHistoryEntry('dev_a', 'Boiler', 4),
      ],
      selectedDeviceId: 'dev_a',
    });
    const devices = Array.from(mount.querySelectorAll<HTMLElement>('.plan-history-card__device'))
      .map((el) => (el.textContent ?? '').trim());
    expect(devices.every((name) => name === 'Boiler')).toBe(true);
    expect(devices).toHaveLength(2);
  });

  it('hides the chip row when only one device has history', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_a', 'Boiler', 4),
      ],
    });
    expect(mount.querySelector('.deadlines-history__filter-row')).toBeNull();
  });

  it('calls onSelectDevice with the device id when a device chip is clicked', () => {
    const onSelectDevice = vi.fn();
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
      onSelectDevice,
    });
    findChip(mount, 'Connected 300')?.click();
    expect(onSelectDevice).toHaveBeenCalledWith('dev_b');
  });

  it('calls onSelectDevice with null when the active device chip is clicked again', () => {
    const onSelectDevice = vi.fn();
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
      selectedDeviceId: 'dev_b',
      onSelectDevice,
    });
    findChip(mount, 'Connected 300')?.click();
    expect(onSelectDevice).toHaveBeenCalledWith(null);
  });

  it('calls onSelectDevice with null when the "All" chip is clicked', () => {
    const onSelectDevice = vi.fn();
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
      selectedDeviceId: 'dev_b',
      onSelectDevice,
    });
    findChip(mount, 'All')?.click();
    expect(onSelectDevice).toHaveBeenCalledWith(null);
  });

  it('exposes the chip row as a labelled group for assistive tech', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
    });
    const row = mount.querySelector('.deadlines-history__filter-row');
    expect(row?.getAttribute('role')).toBe('group');
    expect(row?.getAttribute('aria-label')).toBe('Filter past tasks by device');
  });

  it('renders chips as buttons (keyboard-reachable, no anchor semantics)', () => {
    const mount = mountIntoBody();
    renderReady(mount, {
      entries: [
        buildHistoryEntry('dev_a', 'Boiler', 0),
        buildHistoryEntry('dev_b', 'Connected 300', 2),
      ],
    });
    const chips = Array.from(
      mount.querySelectorAll('.deadlines-history__filter-row .plan-chip'),
    );
    expect(chips.length).toBeGreaterThan(0);
    chips.forEach((chip) => {
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.getAttribute('type')).toBe('button');
    });
  });
});

// PR-10 — 7-day hit-rate strip rendered above the past-tasks list. The view
// only paints what the producer composes; these tests pin presence/absence
// and that `nowMs` threads through so the strip is snapshot-stable like the
// week dividers above the same list.
describe('DeadlinesHistoryList 7-day hit-rate strip', () => {
  const DEADLINE_BASE = Date.UTC(2026, 4, 16, 16, 0, 0);

  const buildHistoryEntry = (
    overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
  ): DeferredObjectivePlanHistoryEntry => ({
    id: 'entry-1',
    deviceId: 'dev_a',
    deviceName: 'Boiler',
    objectiveKind: 'temperature',
    targetTemperatureC: 65,
    targetPercent: null,
    deadlineAtMs: DEADLINE_BASE,
    startedAtMs: DEADLINE_BASE - 6 * HOUR_MS,
    finalizedAtMs: DEADLINE_BASE,
    startProgressC: 50,
    startProgressPercent: null,
    finalProgressC: 65,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 4,
    outcome: 'met',
    metAtMs: DEADLINE_BASE,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation',
    originalPlan: null,
    finalPlan: null,
    ...overrides,
  });

  it('renders the strip with the producer-composed text when entries land in the window', () => {
    const mount = mountIntoBody();
    renderDeadlinesHistoryList(mount, {
      status: 'ready',
      entries: [
        buildHistoryEntry({ id: 'a', outcome: 'met' }),
        buildHistoryEntry({ id: 'b', outcome: 'met' }),
        buildHistoryEntry({ id: 'c', outcome: 'missed' }),
      ],
      timeZone: 'UTC',
      nowMs: DEADLINE_BASE + HOUR_MS,
    });
    const strip = mount.querySelector('.deadlines-history__summary-strip');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toBe('Last 7 days · 2 succeeded · 1 missed · 67% hit rate');
  });

  it('hides the strip when no entries fall in the 7-day window', () => {
    // Entries dated two weeks before `nowMs` — outside the window. The strip
    // must not render at all so a quiet-week landing surface stays quiet
    // rather than displaying an empty pill.
    const mount = mountIntoBody();
    const nowMs = DEADLINE_BASE + 14 * 24 * HOUR_MS;
    renderDeadlinesHistoryList(mount, {
      status: 'ready',
      entries: [buildHistoryEntry({ outcome: 'met' })],
      timeZone: 'UTC',
      nowMs,
    });
    expect(mount.querySelector('.deadlines-history__summary-strip')).toBeNull();
  });
});
