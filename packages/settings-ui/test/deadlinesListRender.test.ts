import { describe, expect, it } from 'vitest';
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
  createdAtMs: T0 - HOUR_MS,
  firstActionAtMs: T0,
  deadlineAtMs: T0 + 6 * HOUR_MS,
  href: './?page=deadline-plan&deviceId=dev_water_heater',
  statusId: 'on_track',
  confidence: null,
  currentValueLine: null,
  ...overrides,
});

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

describe('DeadlinesList', () => {
  it('renders a confidence chip when the card carries a confidence band', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: 'medium' })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips).toContain('Confidence medium');
  });

  it('omits the confidence chip when no band is available', () => {
    const mount = mountIntoBody();
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [buildCard({ confidence: null })],
    });
    const chips = Array.from(mount.querySelectorAll('.plan-chip')).map((el) => el.textContent ?? '');
    expect(chips.filter((text) => text.startsWith('Confidence'))).toEqual([]);
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
});
