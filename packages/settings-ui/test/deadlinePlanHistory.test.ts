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

  it('shows the backup-hours pill when the run leaned on avoid buckets', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry({ usedPolicyAvoid: true })],
      timeZone: 'UTC',
    }));
    expect(mount.textContent).toContain('Backup hours');
  });

  it('does not show the backup-hours pill on a clean run', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry({ usedPolicyAvoid: false, usedDeadlineReserve: false })],
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

  it('renders an observation-gap note when intervals only partially cover the window', () => {
    // Only 2h of observation in a 6h window — should surface a "not observed" note.
    const start = Date.UTC(2026, 4, 6, 0, 0, 0);
    const deadline = Date.UTC(2026, 4, 6, 6, 0, 0);
    const entry = buildEntry({
      startedAtMs: start,
      deadlineAtMs: deadline,
      observedIntervals: [{ fromMs: start, toMs: start + 2 * 60 * 60 * 1000 }],
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    expect(mount.textContent).toMatch(/Not observed for 4h/);
  });

  it('floors sub-hour gaps so a 59m 31s gap renders as "59m", not "1h"', () => {
    // Regression: previously used Math.round which made a <1h gap render as "1h" while the
    // caller still classified it as a "Brief gap" — contradictory copy.
    const start = Date.UTC(2026, 4, 6, 0, 0, 0);
    const deadline = start + 60 * 60 * 1000; // 1h window
    // Observe only the first 28s, then nothing — missing window ≈ 59m 31s.
    const entry = buildEntry({
      startedAtMs: start,
      deadlineAtMs: deadline,
      observedIntervals: [{ fromMs: start, toMs: start + 29_000 }],
    });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    expect(mount.textContent).toMatch(/Brief gap \(59m\)/);
    expect(mount.textContent).not.toMatch(/1h/);
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

  it('renders a replaced entry as abandoned', () => {
    const entry = buildEntry({ outcome: 'replaced', metAtMs: null });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--muted');
    expect(chip?.textContent).toBe('Abandoned');
  });

  it('navigates programmatically on tap so anchor clicks always open the detail page', () => {
    // Regression: some Homey WebView builds did not act on the browser's
    // default anchor navigation, leaving past task cards visually tappable
    // but inert. A JS click handler that calls `window.location.assign` makes
    // taps reliable while keeping `href` for right-click and accessibility.
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [buildEntry()], timeZone: 'UTC' }));
    const link = mount.querySelector<HTMLAnchorElement>('a.plan-history-card--link');
    expect(link?.getAttribute('href')).toMatch(/deadline-plan\.html\?deviceId=/);
    // jsdom's `window.location.assign` is not configurable via spyOn — swap
    // the whole `location` object out so we can observe the call.
    const original = window.location;
    const calls: string[] = [];
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...original, assign: (url: string) => { calls.push(url); } },
    });
    try {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      link?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(calls).toEqual([link!.getAttribute('href')]);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
