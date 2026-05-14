import { afterEach, describe, expect, it } from 'vitest';
import { renderDeadlinesList, type DeadlinesListCard } from '../src/ui/views/DeadlinesList.tsx';

const buildCard = (overrides: Partial<DeadlinesListCard> = {}): DeadlinesListCard => ({
  deviceId: 'dev_test',
  deviceName: 'Test Device',
  kind: 'temperature',
  targetTemperatureC: 21,
  targetPercent: null,
  createdAtMs: Date.UTC(2026, 4, 11, 0, 0, 0),
  firstActionAtMs: null,
  deadlineAtMs: Date.UTC(2026, 4, 11, 6, 0, 0),
  href: './deadline-plan.html?deviceId=dev_test',
  pending: false,
  ...overrides,
});

// jsdom's `window.location.assign` is not configurable via Object.defineProperty,
// so swap the whole `location` object out for a stub for the duration of each test.
const stubLocation = (): { assignCalls: string[]; restore: () => void } => {
  const original = window.location;
  const calls: string[] = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...original, assign: (url: string) => { calls.push(url); } },
  });
  return {
    assignCalls: calls,
    restore: () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
};

describe('renderDeadlinesList', () => {
  let restoreLocation: (() => void) | null = null;
  afterEach(() => {
    restoreLocation?.();
    restoreLocation = null;
    document.body.innerHTML = '';
  });

  it('navigates programmatically on tap so anchor clicks always open the detail page', () => {
    // Regression: some Homey WebView builds did not act on the browser's
    // default anchor navigation, leaving smart-task cards visually tappable
    // but inert. A JS click handler that calls `window.location.assign` makes
    // taps reliable while keeping `href` for right-click and accessibility.
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    renderDeadlinesList(surface, { status: 'ready', cards: [buildCard()] });
    const link = surface.querySelector<HTMLAnchorElement>('a.deadline-list-card');
    expect(link?.getAttribute('href')).toBe('./deadline-plan.html?deviceId=dev_test');
    const stub = stubLocation();
    restoreLocation = stub.restore;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(stub.assignCalls).toEqual(['./deadline-plan.html?deviceId=dev_test']);
  });

  it('leaves middle-click and modifier-click to the browser for open-in-new-tab', () => {
    // Right-click, middle-click, and modifier-clicks must keep their default
    // behavior so users can still open the detail page in a new tab when the
    // host environment supports it. The handler only redirects primary plain
    // clicks; everything else falls through to the anchor's native navigation.
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    renderDeadlinesList(surface, { status: 'ready', cards: [buildCard()] });
    const link = surface.querySelector<HTMLAnchorElement>('a.deadline-list-card');
    expect(link).not.toBeNull();
    const stub = stubLocation();
    restoreLocation = stub.restore;
    const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    link?.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);

    const meta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link?.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(false);

    expect(stub.assignCalls).toEqual([]);
  });
});
