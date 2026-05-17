// Regression: when `/ui_bootstrap`, `/ui_devices`, or `/ui_prices` failed,
// the deadline-plan page rendered "Smart task data is not available
// for this device." with no clue what actually went wrong, and the client
// did not log the failure either. The error card now embeds the underlying
// transport message and the failure round-trips to the app log via
// `logSettingsError`, so the user and `/tmp/pels` can see the real cause.

const callApiMock = vi.fn();
const logSettingsErrorMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts');
  return {
    ...actual,
    callApi: (...args: unknown[]) => callApiMock(...args),
    getHomeyClient: () => null,
  };
});

vi.mock('../src/ui/logging.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/logging.ts')>('../src/ui/logging.ts');
  return {
    ...actual,
    logSettingsError: (...args: unknown[]) => logSettingsErrorMock(...args),
  };
});

import {
  mountDeadlinePlan,
  setDeadlinePlanCloseHandler,
  type DeadlinePlanCloseOptions,
} from '../src/ui/deadlinePlanMount.ts';

const setLocation = (search: string) => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...window.location, search, assign: () => {} },
  });
};

const installRoot = () => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const main = document.createElement('main');
  main.id = 'deadline-plan-root';
  main.setAttribute('aria-live', 'polite');
  document.body.appendChild(main);
};

beforeEach(() => {
  callApiMock.mockReset();
  logSettingsErrorMock.mockReset().mockResolvedValue(undefined);
  installRoot();
  setLocation('?deviceId=dev_test');
});

describe('mountDeadlinePlan boot failure', () => {
  it('renders the underlying transport error and forwards it to logSettingsError', async () => {
    const cause = new Error('Homey api GET /ui_bootstrap failed: Network request failed');
    callApiMock.mockRejectedValue(cause);

    await mountDeadlinePlan();

    const surface = document.getElementById('deadline-plan-root');
    expect(surface).not.toBeNull();
    const text = surface?.textContent ?? '';
    // The error card includes both the framing line and the actual cause so
    // the user can read the failure without opening DevTools.
    expect(text).toContain('Smart task data could not be loaded');
    expect(text).toContain('Homey api GET /ui_bootstrap failed: Network request failed');
    // And the failure round-trips so it shows up in `/tmp/pels` instead of
    // disappearing into a swallowed catch.
    expect(logSettingsErrorMock).toHaveBeenCalledExactlyOnceWith(
      'Failed to load smart task plan boot data',
      cause,
      'mountDeadlinePlan',
    );
  });

  it('history-detail route surfaces the underlying error and logs it too', async () => {
    setLocation('?deviceId=dev_test&historyId=entry-1');
    const cause = new Error('Homey api GET /ui_deferred_objective_history failed: Network request failed');
    callApiMock.mockRejectedValue(cause);

    await mountDeadlinePlan();

    const surface = document.getElementById('deadline-plan-root');
    const text = surface?.textContent ?? '';
    expect(text).toContain('Smart task data could not be loaded');
    expect(text).toContain('Homey api GET /ui_deferred_objective_history failed: Network request failed');
    expect(logSettingsErrorMock).toHaveBeenCalledExactlyOnceWith(
      'Failed to load smart task history detail',
      cause,
      'mountHistoryDetail',
    );
  });

  it('history-detail error renders a Try again control that re-fetches', async () => {
    setLocation('?deviceId=dev_test&historyId=entry-1');
    const cause = new Error('Homey api GET /ui_deferred_objective_history failed: Network request failed');
    callApiMock.mockRejectedValueOnce(cause);
    callApiMock.mockResolvedValueOnce({ entriesByDeviceId: { dev_test: [] } });

    await mountDeadlinePlan();

    const surface = document.getElementById('deadline-plan-root');
    const retry = surface?.querySelector<HTMLElement>('.plan-card__retry');
    expect(retry).not.toBeNull();
    retry?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(callApiMock).toHaveBeenCalledTimes(2);
  });

  it('clicking Try again swaps to loading so the retry control cannot fire twice', async () => {
    setLocation('?deviceId=dev_test&historyId=entry-1');
    const cause = new Error('Homey api GET /ui_deferred_objective_history failed: Network request failed');
    // Initial fetch fails, the retry fetch never resolves so the loading
    // surface persists. A second click against the same captured handler
    // would still fire if the button stayed in the DOM; the assertion below
    // proves the button is gone after the first click.
    callApiMock.mockRejectedValueOnce(cause);
    callApiMock.mockReturnValueOnce(new Promise(() => {}));

    await mountDeadlinePlan();

    const surface = document.getElementById('deadline-plan-root');
    const retry = surface?.querySelector<HTMLElement>('.plan-card__retry');
    expect(retry).not.toBeNull();
    retry?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(surface?.querySelector('.plan-card__retry')).toBeNull();
    expect(surface?.textContent ?? '').toContain('Loading smart task');
    expect(callApiMock).toHaveBeenCalledTimes(2);
  });
});

// PR 8 polish: clicking the "Review device" recourse on a missed history
// entry must close the deadline-plan view first, then dispatch
// `open-device-detail` once the close path has settled. Dispatching
// synchronously raced popstate and only worked by luck of overlay z-index
// ordering; the router now exposes an `onSettled` callback so the
// dispatcher can sequence the overlay open after the unmount + tab switch.
describe('recourse dispatcher (history-detail "Review device")', () => {
  // Ensure the document-level recourse-click handler is bound before each
  // test in this block, independent of prior describe order. `mountDeadlinePlan`
  // binds it once per session via `recourseHandlerBound`; a single failing
  // mount with a rejected callApi exercises the binding without coupling to
  // the boot-failure tests above.
  beforeEach(async () => {
    callApiMock.mockRejectedValue(new Error('binding-only mount'));
    await mountDeadlinePlan();
  });

  it('defers open-device-detail until the close handler invokes onSettled', () => {
    const events: string[] = [];
    let capturedOnSettled: (() => void) | null = null;

    // Stub close handler — records the call and captures onSettled instead
    // of running it. This pins the contract: the dispatcher must hand a
    // callback to the router, not dispatch open-device-detail inline.
    setDeadlinePlanCloseHandler((options?: DeadlinePlanCloseOptions) => {
      events.push(`close:${options?.fallbackTab ?? ''}`);
      capturedOnSettled = options?.onSettled ?? null;
    });
    document.addEventListener('open-device-detail', () => {
      events.push('open-device-detail');
    });

    // Install a recourse button matching the producer's data-* contract.
    installRoot();
    const button = document.createElement('button');
    button.setAttribute('data-deadline-recourse-tab', 'overview');
    button.setAttribute('data-deadline-recourse-device-id', 'dev_water_heater');
    document.body.appendChild(button);

    button.click();

    // Close fired first; overlay open has NOT yet been dispatched.
    expect(events).toEqual(['close:overview']);
    expect(typeof capturedOnSettled).toBe('function');

    // Router signals close settled → overlay opens.
    capturedOnSettled!();
    expect(events).toEqual(['close:overview', 'open-device-detail']);
  });

  it('omits onSettled when the recourse has no device-id (budget-exhausted branch)', () => {
    let capturedOptions: DeadlinePlanCloseOptions | undefined;
    setDeadlinePlanCloseHandler((options?: DeadlinePlanCloseOptions) => {
      capturedOptions = options;
    });

    installRoot();
    const button = document.createElement('button');
    button.setAttribute('data-deadline-recourse-tab', 'budget');
    // No data-deadline-recourse-device-id — budget branch has no overlay.
    document.body.appendChild(button);

    button.click();

    expect(capturedOptions?.fallbackTab).toBe('budget');
    expect(capturedOptions?.onSettled).toBeUndefined();
  });
});
