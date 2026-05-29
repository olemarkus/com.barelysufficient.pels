import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../contracts/src/settingsUiApi.ts';

// Stale-history-refresh race guard. PR1 made the independently-fetched history
// callback re-render the active list (to thread the resolved `historyPresent`
// flag). If the user re-opens the Smart tasks tab — firing a second
// `refreshDeadlinesList()` — before the first history request settles, the
// older callback could fire late and re-render the active surface with its own
// (now stale) empty-state, clobbering the newer paint. The controller stamps
// each invocation with a monotonic generation and the history callback only
// re-renders the active list while its generation is still the latest.

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

import { refreshDeadlinesList } from '../src/ui/deadlinesList.ts';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 4, 11, 0, 0, 0);

// Bootstrap payload with no active plans → the active list renders its
// zero-card empty state, which is exactly where `historyPresent` is
// observable in the DOM (first-run copy vs between-runs copy).
const emptyBootstrap = {
  settings: { deferred_objectives: { version: 1, objectivesByDeviceId: {} } },
  deferredObjectiveActivePlans: { version: 1, plansByDeviceId: {} },
};
const emptyDevices = { devices: [] };

const historyEntry = () => ({
  id: 'entry-1',
  deviceId: 'dev_a',
  deviceName: 'Boiler',
  objectiveKind: 'temperature' as const,
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: T0 + HOUR_MS,
  startedAtMs: T0,
  finalizedAtMs: T0 + HOUR_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 4,
  outcome: 'met' as const,
  metAtMs: T0 + HOUR_MS,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'observation' as const,
  originalPlan: null,
  finalPlan: null,
});

const historyWithEntries = (): SettingsUiDeferredObjectivePlanHistoryPayload => ({
  version: 1,
  entriesByDeviceId: { dev_a: [historyEntry()] },
});
const historyEmpty = (): SettingsUiDeferredObjectivePlanHistoryPayload => ({
  version: 1,
  entriesByDeviceId: {},
});

type Deferred = {
  promise: Promise<SettingsUiDeferredObjectivePlanHistoryPayload>;
  resolve: (value: SettingsUiDeferredObjectivePlanHistoryPayload) => void;
};
const makeDeferred = (): Deferred => {
  let resolve!: (value: SettingsUiDeferredObjectivePlanHistoryPayload) => void;
  const promise = new Promise<SettingsUiDeferredObjectivePlanHistoryPayload>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const installSurfaces = (): void => {
  document.body.replaceChildren();
  const active = document.createElement('div');
  active.id = 'deadlines-list-root';
  document.body.appendChild(active);
  const history = document.createElement('div');
  history.id = 'deadlines-history-root';
  document.body.appendChild(history);
};

const activeSurface = (): HTMLElement => document.getElementById('deadlines-list-root') as HTMLElement;

// Drive a single `refreshDeadlinesList()` invocation, routing bootstrap/devices
// to immediate resolves and the history fetch to the supplied deferred so the
// test controls exactly when each invocation's history callback fires.
const startRefresh = (historyDeferred: Deferred): Promise<void> => {
  callApiMock.mockImplementation((_method: string, path: string) => {
    if (path === '/ui_bootstrap') return Promise.resolve(emptyBootstrap);
    if (path === '/ui_devices') return Promise.resolve(emptyDevices);
    if (path === '/ui_deferred_objective_history') return historyDeferred.promise;
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
  return refreshDeadlinesList();
};

// Drain the microtask queue so the fire-and-forget history `.then` chain
// (`void fetchPlanHistoryOrNull().then(...)`, which `refreshDeadlinesList`
// does not await) settles. A `setTimeout(0)` macrotask resolves only after the
// pending microtasks have run, so a single turn is enough — no busy loop.
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('refreshDeadlinesList stale-history-refresh guard', () => {
  beforeEach(() => {
    callApiMock.mockReset();
    logSettingsErrorMock.mockReset().mockResolvedValue(undefined);
    installSurfaces();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('ignores a stale (older-generation) history callback while honouring the current one', async () => {
    // Invocation 1: history HAS entries (would render the between-runs copy if
    // its callback ever re-rendered the active list). Hold its history fetch
    // open so the callback can fire late.
    const first = makeDeferred();
    const firstRefresh = startRefresh(first);
    await flush();
    // Bootstrap-side paint: empty active list, history not yet known → the
    // conservative first-run copy.
    expect(activeSurface().querySelector('[data-state="empty"]')).not.toBeNull();
    expect(activeSurface().textContent).not.toContain('No smart tasks scheduled');

    // Invocation 2 (user re-opens the tab): bumps the generation. History has
    // NO entries → its current-generation callback re-renders the first-run
    // copy. Resolve its history immediately.
    const second = makeDeferred();
    const secondRefresh = startRefresh(second);
    second.resolve(historyEmpty());
    await secondRefresh;
    await flush();
    expect(activeSurface().querySelector('[data-state="empty"]')).not.toBeNull();
    expect(activeSurface().textContent).not.toContain('No smart tasks scheduled');

    // Now the STALE invocation-1 history settles with entries. Its callback is
    // older-generation, so it must NOT flip the active surface to between-runs.
    first.resolve(historyWithEntries());
    await firstRefresh;
    await flush();
    expect(activeSurface().querySelector('[data-state="empty-between-runs"]')).toBeNull();
    expect(activeSurface().textContent).not.toContain('No smart tasks scheduled');
    expect(activeSurface().querySelector('[data-state="empty"]')).not.toBeNull();
  });

  it('lets the latest invocation history callback re-render the active list (between-runs)', async () => {
    // Single, current invocation whose history HAS entries → the callback is
    // the latest generation and must flip the active empty state from the
    // first-run fallback to the between-runs copy. Positive control proving the
    // guard does not over-suppress the legitimate re-render.
    const only = makeDeferred();
    const refresh = startRefresh(only);
    await flush();
    // Before history resolves: first-run fallback.
    expect(activeSurface().querySelector('[data-state="empty"]')).not.toBeNull();

    only.resolve(historyWithEntries());
    await refresh;
    await flush();
    // History present + current generation → between-runs copy now owns the
    // empty state.
    expect(activeSurface().querySelector('[data-state="empty-between-runs"]')).not.toBeNull();
    expect(activeSurface().textContent).toContain('No smart tasks scheduled');
    expect(activeSurface().querySelector('[data-state="empty"]')).toBeNull();
  });
});
