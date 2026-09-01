import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_SCOPE_OVERVIEW_UNAVAILABLE_BODY,
  HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE,
} from '../../shared-domain/src/homeScopeCopy.ts';
import type { OverviewDeferredObjectiveActivePlans } from '../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveSettingsV1 } from '../../contracts/src/deferredObjectiveSettings.ts';
import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Overview (multi-home 6b): the scope-following plan reader and the
 * bare-URI-prime realtime trap.
 *
 * Three properties carry the seam:
 *
 * 1. Main selection is BYTE-IDENTICAL to the pre-multi-home behaviour — the
 *    bare `/ui_plan` URI (never `?homeId=main`), always `served`.
 * 2. A scoped read discriminates the producer's `homeScope` BEFORE any flat
 *    field; `unavailable` renders the honest notice, never `plan: null`
 *    dressed as "no plan committed yet".
 * 3. THE TRAP: the realtime `plan_updated` / `power_updated` pushes are
 *    MAIN'S streams and re-seed the BARE cache entry with Main's payload.
 *    While a meter area is the selected scope, the Overview must NOT consume
 *    that pushed payload — Main's hero numbers and device set under the
 *    area's name would be the exact lie the scope bar promises not to tell.
 *    The trap tests drive the REAL realtime handlers, so removing the scope
 *    guard in `planRedesign.ts` fails them.
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const SCOPED_PLAN_URI = `/ui_plan?homeId=${AREA}`;
const SCOPED_POWER_URI = `/ui_power?homeId=${AREA}`;

const ROSTER_PAYLOAD = {
  homes: [{ homeId: AREA, name: 'Rental unit' }],
  membershipByDeviceId: {},
  runtimeActive: true,
  configDegraded: false,
};

const buildPlan = (params: { totalKw: number; deviceId: string; deviceName: string; plannedState?: string }) => ({
  meta: buildPlanMeta({
    totalKw: params.totalKw,
    softLimitKw: 3,
    headroomKw: 3 - params.totalKw,
    controlledKw: 0.5,
    uncontrolledKw: Math.max(0, params.totalKw - 0.5),
    usedKWh: 0.2,
    hourBudgetKWh: 3,
    minutesRemaining: 30}),
  devices: [{
    id: params.deviceId,
    name: params.deviceName,
    currentState: 'on',
    plannedState: params.plannedState ?? 'keep',
    priority: 1,
    controllable: true,
    available: true,
    currentDrawKw: 0.5,
    reason: params.plannedState === 'shed'
      ? { code: 'capacity' }
      : { code: 'keep', detail: null },
  }],
});

const MAIN_PLAN = buildPlan({ totalKw: 5.2, deviceId: 'dev_main_heater', deviceName: 'Main Heater' });
const AREA_PLAN = buildPlan({ totalKw: 0.7, deviceId: 'dev_rental_heater', deviceName: 'Rental Heater' });

// A partial payload the plan shape guard rejects: the device entry carries no
// name and no structured reason. A truncated/older producer answer looks like
// this — the scope envelope is perfectly fine, the plan inside is not.
const MALFORMED_PLAN = {
  meta: { ...AREA_PLAN.meta },
  devices: [{ id: 'dev_rental_heater' }],
};

const SERVED_AREA_POWER = {
  tracker: null,
  status: { state: 'live', status: { powerFreshnessState: 'fresh' } },
  readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 },
  homeScope: { state: 'resolved', homeId: AREA },
};

type InstallOptions = {
  api: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /**
   * URIs whose transport responses are HELD until the test releases them via
   * the returned `heldCalls` — the only way to pin what the surface shows
   * while a read is in flight, and to settle overlapping reads out of order.
   */
  holdUris?: readonly string[];
};

type Emitter = (event: string, payload?: unknown) => void;

type HeldCall = {
  uri: string;
  /** Respond with `payload`, or with the installed `api` map's entry. */
  respond: (payload?: unknown) => void;
};

const installClient = async ({ api, settings = {}, holdUris = [] }: InstallOptions): Promise<{
  calledUris: string[];
  emit: Emitter;
  heldCalls: HeldCall[];
}> => {
  const calledUris: string[] = [];
  const heldCalls: HeldCall[] = [];
  const listeners: Record<string, Array<(payload?: unknown) => void>> = {};
  // The Overview renders the DEVICE list joined to the plan, so a test that
  // serves only a plan draws no cards. Default each `/ui_devices` read from the
  // plan this scope serves — production's device list is a superset of the
  // plan's devices, so mirroring its ids is the faithful minimum. A test that
  // stubs `/ui_devices` explicitly still wins.
  const devicesFor = (uri: string): unknown => {
    const planUri = uri.replace('/ui_devices', '/ui_plan');
    const served = api[planUri] as { plan?: { devices?: Array<Record<string, unknown>> } } | undefined;
    const scoped = api[planUri] as { homeScope?: unknown } | undefined;
    return {
      devices: (served?.plan?.devices ?? []).map((device) => ({
        id: device.id,
        name: device.name,
        priority: device.priority,
        targets: [],
        available: true,
      })),
      // The scoped device read discriminates the producer's `homeScope` before
      // any flat field, exactly as the plan read does — so a scoped stub must
      // carry the same envelope or it resolves `unavailable`.
      ...(scoped?.homeScope ? { homeScope: scoped.homeScope } : {}),
    };
  };
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (key, cb) => cb(null, Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      calledUris.push(`${method} ${uri}`);
      const answer = (payload?: unknown) => {
        if (payload !== undefined) {
          callback(null, payload);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(api, uri)) {
          callback(null, api[uri]);
          return;
        }
        if (uri.startsWith('/ui_devices')) {
          callback(null, devicesFor(uri));
          return;
        }
        callback(new Error(`unexpected uri ${uri}`));
      };
      if (holdUris.includes(uri)) {
        heldCalls.push({ uri, respond: answer });
        return;
      }
      answer();
    },
    on: (event, cb) => {
      (listeners[event] ??= []).push(cb as (payload?: unknown) => void);
    },
    clock: { getTimezone: () => 'UTC' },
  };
  setHomeyClient(client);
  return {
    calledUris,
    emit: (event, payload) => (listeners[event] ?? []).forEach((cb) => cb(payload)),
    heldCalls,
  };
};

// Adopt the meter area through the REAL scope module (roster fetch + pick), so
// the reader and the realtime guard are exercised on the same path the scope
// bar drives — never a mocked selection.
const selectArea = async (): Promise<void> => {
  const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
  await refreshHomeScope();
  selectHomeScope(AREA);
};

const buildOverviewDom = () => {
  document.body.innerHTML = `
    <section id="overview-panel">
      <div id="plan-redesign-surface"></div>
    </section>
  `;
};

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const heroPowerValue = (): string | null => (
  document.querySelector('.plan-hero__metric-value')?.textContent ?? null
);

const hasDeviceCard = (deviceId: string): boolean => (
  document.querySelector(`[data-device-id="${deviceId}"]`) !== null
);

const surfaceText = (): string => (
  document.getElementById('plan-redesign-surface')?.textContent ?? ''
);

beforeEach(() => {
  vi.resetModules();
  buildOverviewDom();
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readOverviewPlan', () => {
  it('reads the BARE /ui_plan for the Main selection, byte-identically', async () => {
    const { calledUris } = await installClient({ api: { '/ui_plan': { plan: MAIN_PLAN } } });
    const { readOverviewPlan } = await import('../src/ui/overviewPlanRead.ts');

    const read = await readOverviewPlan();

    expect(calledUris).toEqual(['GET /ui_plan']);
    expect(read.state).toBe('served');
    if (read.state === 'served') expect(read.payload.plan).toBe(MAIN_PLAN);
  });

  it('reads the ?homeId= variant for a selected area, never the bare path', async () => {
    const { calledUris } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
      },
    });
    await selectArea();
    const { readOverviewPlan } = await import('../src/ui/overviewPlanRead.ts');

    const read = await readOverviewPlan();

    expect(calledUris).toContain(`GET ${SCOPED_PLAN_URI}`);
    expect(calledUris).not.toContain('GET /ui_plan');
    expect(read.state).toBe('served');
    if (read.state === 'served') expect(read.payload.plan).toBe(AREA_PLAN);
  });

  it.each([
    ['the producer answered unavailable', { plan: null, homeScope: { state: 'unavailable' as const } }],
    ['the producer ignored the query (no scope block)', { plan: MAIN_PLAN }],
    // A correctly resolved envelope carrying a partial plan: the envelope
    // check alone would serve it, and `plan: null` downstream would read as
    // "this area has committed no plan yet" — a fabricated verdict about a
    // home whose plan could not be read.
    ['the resolved envelope carries a MALFORMED plan', {
      plan: MALFORMED_PLAN,
      homeScope: { state: 'resolved' as const, homeId: AREA },
    }],
  ])('a scoped read is unavailable when %s, flat fields unreachable', async (_name, payload) => {
    await installClient({
      api: { '/ui_homes': ROSTER_PAYLOAD, '/settings_ui_log': { ok: true }, [SCOPED_PLAN_URI]: payload },
    });
    await selectArea();
    const { readOverviewPlan } = await import('../src/ui/overviewPlanRead.ts');

    const read = await readOverviewPlan();

    expect(read.state).toBe('unavailable');
    expect('payload' in read).toBe(false);
  });

  it('a REJECTING scoped read is unavailable too, never a thrown escape', async () => {
    // The scoped GET still rejects after Homey's retries (no map entry here).
    // The reader owns that classification: a rejection escaping it would abort
    // the caller's `Promise.all` AFTER the scope pick already blanked the
    // surface, leaving the Overview on the loading skeleton.
    await installClient({ api: { '/ui_homes': ROSTER_PAYLOAD, '/settings_ui_log': { ok: true } } });
    await selectArea();
    const { readOverviewPlan } = await import('../src/ui/overviewPlanRead.ts');

    const read = await readOverviewPlan();

    expect(read.state).toBe('unavailable');
    expect('payload' in read).toBe(false);
  });
});

describe('Overview under a selected meter area', () => {
  it('renders the area\'s own hero and device cards, and Main\'s after switching back', async () => {
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_plan': { plan: MAIN_PLAN },
        '/ui_power': { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 } },
        '/ui_prices': null,
        '/ui_deferred_objective_history': { version: 1, entriesByDeviceId: {} },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
    });
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    const homeScope = await import('../src/ui/homeScope.ts');
    // Main's Overview renders the bare-URI device list every surface shares
    // (`state.latestDevices`), so seed it for the Main leg below. The AREA leg
    // deliberately does NOT use it — it reads its own `?homeId=` device list,
    // which is the whole point of the assertions that follow.
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [{
      id: 'dev_main_heater', name: 'Main Heater', targets: [], available: true,
    }] as unknown as typeof state.latestDevices;
    state.devicesLoaded = true;

    await refreshPlan();

    expect(heroPowerValue()).toBe('0.7');
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);
    expect(hasDeviceCard('dev_main_heater')).toBe(false);

    homeScope.selectHomeScope('main');
    await refreshPlan();

    expect(heroPowerValue()).toBe('5.2');
    expect(hasDeviceCard('dev_main_heater')).toBe(true);
    expect(hasDeviceCard('dev_rental_heater')).toBe(false);
  });

  it('renders the honest notice for an unavailable area, never fabricated numbers', async () => {
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        [SCOPED_PLAN_URI]: { plan: null, homeScope: { state: 'unavailable' } },
        [SCOPED_POWER_URI]: { tracker: {}, status: { state: 'unavailable', reason: 'home_scope_unavailable' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 }, homeScope: { state: 'unavailable' } },
      },
    });
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');

    await refreshPlan();

    const notice = document.getElementById('plan-scope-unavailable');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE);
    expect(notice?.textContent).toContain(HOME_SCOPE_OVERVIEW_UNAVAILABLE_BODY);
    // No hero, no cards, no "No plan available yet" verdict — the empty shape
    // is not a measurement.
    expect(document.querySelector('.plan-hero')).toBeNull();
    expect(document.querySelector('[data-device-id]')).toBeNull();
    expect(surfaceText()).not.toContain('No plan available yet');
  });

  it('renders the honest notice when the area\'s plan payload is MALFORMED, never "no plan yet"', async () => {
    // The producer resolved the scope for the right home but answered with a
    // partial plan. Collapsing that to `plan: null` would tell the owner this
    // area has committed no plan yet — a verdict about a home whose plan the
    // WebView could not actually read.
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: MALFORMED_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
    });
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');

    await refreshPlan();

    const notice = document.getElementById('plan-scope-unavailable');
    expect(notice?.textContent).toContain(HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE);
    expect(document.querySelector('.plan-hero')).toBeNull();
    expect(surfaceText()).not.toContain('No plan available yet');
  });

  it('renders the honest notice when the area\'s plan read REJECTS, not a stranded skeleton', async () => {
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        '/settings_ui_log': { ok: true },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
        // No `[SCOPED_PLAN_URI]` entry: that GET rejects — the case a retrying
        // transport eventually gives up on.
      },
    });
    await selectArea();
    const { refreshPlan, resetPlanSurfaceForScopeChange } = await import('../src/ui/plan.ts');
    // The scope pick blanks the surface BEFORE the refresh, exactly as the
    // Overview's scope subscription does.
    resetPlanSurfaceForScopeChange();
    expect(document.getElementById('plan-scope-unavailable')).toBeNull();

    // Must settle, not reject: a rejection here is the user staring at the
    // loading skeleton until some later refresh happens to land.
    await refreshPlan();

    const notice = document.getElementById('plan-scope-unavailable');
    expect(notice?.textContent).toContain(HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE);
    expect(document.querySelector('.plan-hero')).toBeNull();
    expect(surfaceText()).not.toContain('No plan available yet');
  });

  it('omits the Main-home smart-task row under an area (locked scope decision)', async () => {
    const deadlineAtMs = Date.now() + 2 * 60 * 60 * 1000;
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_plan': { plan: MAIN_PLAN },
        '/ui_power': { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 } },
        '/ui_prices': null,
        '/ui_deferred_objective_history': { version: 1, entriesByDeviceId: {} },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
    });
    const { state } = await import('../src/ui/state.ts');
    const activePlans: OverviewDeferredObjectiveActivePlans = {
      version: 1,
      plansByDeviceId: {
        dev_main_heater: {
          pending: false,
          deviceName: 'Main Heater',
          deadlineAtMs,
          latest: {
            revision: 1,
            revisedAtMs: Date.now(),
            computedFromPricesUpTo: null,
            reason: 'prices_arrived',
            hours: [],
            energyNeededKWh: 2,
            planStatus: 'on_track',
          },
        },
      },
    };
    const objectives: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        dev_main_heater: {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          deadlineAtMs,
          targetTemperatureC: 60,
        },
      },
    };
    state.deferredObjectiveActivePlans = activePlans;
    state.deferredObjectiveSettings = objectives;
    const { refreshPlan } = await import('../src/ui/plan.ts');
    const homeScope = await import('../src/ui/homeScope.ts');

    await refreshPlan();
    expect(document.getElementById('plan-smart-task-row')).not.toBeNull();

    await selectArea();
    await refreshPlan();
    expect(document.getElementById('plan-smart-task-row')).toBeNull();

    homeScope.selectHomeScope('main');
    await refreshPlan();
    expect(document.getElementById('plan-smart-task-row')).not.toBeNull();
  });

  it('takes the simulation context from the area\'s own flag, never Main\'s', async () => {
    const areaPlanWithPendingShed = buildPlan({
      totalKw: 0.7, deviceId: 'dev_rental_heater', deviceName: 'Rental Heater', plannedState: 'shed',
    });
    const api = {
      '/ui_homes': ROSTER_PAYLOAD,
      '/ui_prices': null,
      [SCOPED_PLAN_URI]: { plan: areaPlanWithPendingShed, homeScope: { state: 'resolved', homeId: AREA } },
      [SCOPED_POWER_URI]: SERVED_AREA_POWER,
    };

    // Area flag false (live control) while Main simulates: no simulation chip.
    await installClient({ api, settings: { [`capacity_dry_run:${AREA}`]: false } });
    let { state } = await import('../src/ui/state.ts');
    state.dryRun = true;
    await selectArea();
    let { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    expect(surfaceText()).not.toContain('Simulation mode');

    // Area flag absent (the runtime's simulate-until-enabled boot default)
    // while Main is live: the chip must show.
    vi.resetModules();
    buildOverviewDom();
    await installClient({ api });
    ({ state } = await import('../src/ui/state.ts'));
    state.dryRun = false;
    await selectArea();
    ({ refreshPlan } = await import('../src/ui/plan.ts'));
    await refreshPlan();
    expect(surfaceText()).toContain('Simulation mode');
  });
});

describe('the bare-URI-prime realtime trap', () => {
  const installRealtimeHarness = async () => {
    const { emit, calledUris } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_plan': { plan: MAIN_PLAN },
        '/ui_power': { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 } },
        '/ui_prices': null,
        '/ui_deferred_objective_history': { version: 1, entriesByDeviceId: {} },
        '/ui_starvation_rescue_devices': { rescuableDeviceIds: [] },
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
    });
    const { initRealtimeListeners } = await import('../src/ui/realtime.ts');
    initRealtimeListeners();
    return { emit, calledUris };
  };

  it('a Main plan_updated push never repaints a selected area\'s Overview', async () => {
    const { emit } = await installRealtimeHarness();
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    await flushAsync();
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);

    // Main's push: primes the BARE cache entry (correct — that entry is
    // Main's) but must NOT paint Main's plan under the area's name.
    emit('plan_updated', MAIN_PLAN);
    await flushAsync();

    expect(heroPowerValue()).toBe('0.7');
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);
    expect(hasDeviceCard('dev_main_heater')).toBe(false);
  });

  it('the same push repaints the Overview under the Main selection', async () => {
    // Contrast case: proves the assertion above fails through the guard, not
    // through a broken pipeline.
    const { emit } = await installRealtimeHarness();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    await flushAsync();
    expect(heroPowerValue()).toBe('5.2');

    emit('plan_updated', buildPlan({ totalKw: 6.4, deviceId: 'dev_main_heater', deviceName: 'Main Heater' }));
    await flushAsync();

    expect(heroPowerValue()).toBe('6.4');
  });

  it('a Main power_updated push never stomps a selected area\'s hero numbers', async () => {
    // The old observable was the 'No data' freshness chip; that chip is
    // retired (staleness is the global banner's fact), so the guard is pinned
    // on the hero numbers a stomping Main push would have replaced.
    const { emit } = await installRealtimeHarness();
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    await flushAsync();

    // Main's power stream says nothing about the area.
    emit('power_updated', {
      tracker: null,
      status: { state: 'live', status: { powerNowKw: null } },
      readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 },
    });
    await flushAsync();

    expect(heroPowerValue()).toBe('0.7');
  });
});

describe('overlapping same-area refreshes', () => {
  it('an older same-area refresh can never overwrite the newer commit', async () => {
    // Two refreshes for the SAME area overlap on the real paths: an activation
    // refresh is still awaiting its plan read when the area's `pels_status:<id>`
    // commit stream starts another. Both pass the home-id check — only the
    // per-refresh generation can drop the older settle.
    const { heldCalls } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
      holdUris: [SCOPED_PLAN_URI],
    });
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');

    // Refresh A (older) — its scoped plan read is held in flight.
    const older = refreshPlan();
    // Refresh B (newer) through the REAL commit-stream route: the router
    // invalidates the scoped cache, then refreshes the visible Overview.
    const { createSettingsSetHandler } = await import('../src/ui/settingsChangeRouter.ts');
    createSettingsSetHandler()(`pels_status:${AREA}`);
    await flushAsync();
    const heldPlanReads = heldCalls.filter((call) => call.uri === SCOPED_PLAN_URI);
    expect(heldPlanReads).toHaveLength(2);

    // The NEWER read settles first, carrying the just-committed plan …
    heldPlanReads[1].respond({
      plan: buildPlan({ totalKw: 0.9, deviceId: 'dev_rental_heater', deviceName: 'Rental Heater' }),
      homeScope: { state: 'resolved', homeId: AREA },
    });
    await flushAsync();
    expect(heroPowerValue()).toBe('0.9');

    // … and the OLDER read settles last with the pre-commit plan. Same home
    // id, so the scope check alone would admit the stale overwrite.
    heldPlanReads[0].respond();
    await older;
    await flushAsync();
    expect(heroPowerValue()).toBe('0.9');
  });
});

describe('overlapping Main refreshes across a scope round trip', () => {
  it('an older Main refresh can never overwrite the newer Main commit', async () => {
    // Main refresh A is still awaiting its plan read when the user rounds
    // Main → area → Main and refresh B commits. A's home-id check passes (the
    // scope IS Main again), so only a generation stamped on BOTH branches can
    // drop it — the area branch's guard alone never sees a Main refresh.
    const { heldCalls } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_plan': { plan: MAIN_PLAN },
        '/ui_power': { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 } },
        '/ui_prices': null,
        '/ui_deferred_objective_history': { version: 1, entriesByDeviceId: {} },
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
      holdUris: ['/ui_plan'],
    });
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPlan } = await import('../src/ui/plan.ts');

    // Refresh A (older, Main) — its plan read is held in flight.
    const olderMain = refreshPlan();
    await flushAsync();

    // The round trip: out to the area (which commits the area's own render) …
    selectHomeScope(AREA);
    await refreshPlan();
    expect(heroPowerValue()).toBe('0.7');

    // … and back to Main, where refresh B settles with the current plan.
    selectHomeScope('main');
    const newerMain = refreshPlan();
    await flushAsync();
    const heldMainReads = heldCalls.filter((call) => call.uri === '/ui_plan');
    expect(heldMainReads).toHaveLength(2);
    heldMainReads[1].respond({
      plan: buildPlan({ totalKw: 6.4, deviceId: 'dev_main_heater', deviceName: 'Main Heater' }),
    });
    await newerMain;
    await flushAsync();
    expect(heroPowerValue()).toBe('6.4');

    // A settles LAST with its pre-round-trip plan. Same scope, so the identity
    // check alone would admit the stale overwrite.
    heldMainReads[0].respond();
    await olderMain;
    await flushAsync();
    expect(heroPowerValue()).toBe('6.4');
  });
});

describe('Overview activation after a scope change while it was hidden', () => {
  // The activation path needs the real `showTab`: `.panel` sections whose
  // visibility it toggles, captured by `dom.ts` at import time.
  const buildShellDom = () => {
    document.body.innerHTML = `
      <div id="toast"></div>
      <section class="panel" id="overview-panel" data-panel="overview">
        <div id="plan-redesign-surface"></div>
      </section>
      <section class="panel hidden" id="usage-panel" data-panel="usage"></section>
    `;
  };

  it('blanks the stale home render before the new scope\'s refresh lands', async () => {
    buildShellDom();
    const { heldCalls } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_plan': { plan: MAIN_PLAN },
        '/ui_power': { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'received', lastPowerUpdateMs: 1_700_000_000_000 } },
        '/ui_prices': null,
        '/ui_deferred_objective_history': { version: 1, entriesByDeviceId: {} },
        '/ui_starvation_rescue_devices': { rescuableDeviceIds: [] },
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
      holdUris: ['/ui_plan'],
    });
    // Imported before the scope moves, so the visible-panel scope subscription
    // is registered — proving it really skips a hidden Overview and the
    // activation hook is what covers the gap.
    const { showTab } = await import('../src/ui/tabNavigation.ts');
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    await flushAsync();
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);

    // Hide the Overview (the user is on another panel), then pick Main: the
    // visible-panel subscription must not fire for a hidden Overview.
    document.getElementById('overview-panel')?.classList.add('hidden');
    const { selectHomeScope } = await import('../src/ui/homeScope.ts');
    selectHomeScope('main');
    await flushAsync();
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);

    // Reopen through the real activation path. Main's plan read is HELD, so
    // whatever the surface shows now is what the user stares at while the
    // refresh is in flight: it must be the skeleton, never the old area's
    // hero/cards under the new scope's bar.
    showTab('overview');
    await flushAsync();
    expect(hasDeviceCard('dev_rental_heater')).toBe(false);
    expect(hasDeviceCard('dev_main_heater')).toBe(false);

    heldCalls.filter((call) => call.uri === '/ui_plan').forEach((call) => call.respond());
    await flushAsync();
    expect(hasDeviceCard('dev_main_heater')).toBe(true);
    expect(heroPowerValue()).toBe('5.2');
  });

  it('keeps the committed render on an ordinary reopen (no skeleton flash)', async () => {
    // The reset is conditional on a scope MISMATCH: reopening the Overview
    // with the scope unchanged must repaint in place, not blank to the
    // skeleton first.
    buildShellDom();
    const { heldCalls } = await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
      holdUris: [SCOPED_PLAN_URI],
    });
    const { showTab } = await import('../src/ui/tabNavigation.ts');
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    const first = refreshPlan();
    // The visible-panel scope subscription started a held read of its own
    // during `selectArea`; release every in-flight scoped read so `first`
    // settles (the newest-started one commits).
    heldCalls.filter((call) => call.uri === SCOPED_PLAN_URI).forEach((call) => call.respond());
    await first;
    await flushAsync();
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);

    document.getElementById('overview-panel')?.classList.add('hidden');
    showTab('overview');
    await flushAsync();

    // The activation refresh's plan read is still held: the surface must keep
    // the area's committed render while it refreshes in place.
    expect(hasDeviceCard('dev_rental_heater')).toBe(true);
  });
});

describe('the selected area\'s tracker write repaints a visible Overview', () => {
  it('repaints on a tracker write with NO status write beside it', async () => {
    // `power_tracker_state:<id>` writes on its own — scheduled persistence,
    // the hourly prune, a meter-swap freshness reset — and the Overview hero
    // reads that home's scoped power/plan payloads. Without an Overview route
    // on this key the hero sits on the cached payload until some later
    // `pels_status:<id>` write or a tab activation.
    const api: Record<string, unknown> = {
      '/ui_homes': ROSTER_PAYLOAD,
      '/ui_prices': null,
      '/settings_ui_log': { ok: true },
      [SCOPED_PLAN_URI]: { plan: AREA_PLAN, homeScope: { state: 'resolved', homeId: AREA } },
      [SCOPED_POWER_URI]: SERVED_AREA_POWER,
    };
    await installClient({ api });
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    await flushAsync();
    expect(heroPowerValue()).toBe('0.7');

    // The area moved on; only its tracker key is written.
    api[SCOPED_PLAN_URI] = {
      plan: buildPlan({ totalKw: 0.9, deviceId: 'dev_rental_heater', deviceName: 'Rental Heater' }),
      homeScope: { state: 'resolved', homeId: AREA },
    };
    const { createSettingsSetHandler } = await import('../src/ui/settingsChangeRouter.ts');
    createSettingsSetHandler()(`power_tracker_state:${AREA}`);
    await flushAsync();

    expect(heroPowerValue()).toBe('0.9');
  });
});

describe('the selected area\'s dry-run flag UNSET repaints a visible Overview', () => {
  it('returns the hero to the simulating boot default, not the stale live-control voice', async () => {
    const areaPlanWithPendingShed = buildPlan({
      totalKw: 0.7, deviceId: 'dev_rental_heater', deviceName: 'Rental Heater', plannedState: 'shed',
    });
    const dryRunKey = `capacity_dry_run:${AREA}`;
    const settings: Record<string, unknown> = { [dryRunKey]: false };
    await installClient({
      api: {
        '/ui_homes': ROSTER_PAYLOAD,
        '/ui_prices': null,
        '/settings_ui_log': { ok: true },
        [SCOPED_PLAN_URI]: { plan: areaPlanWithPendingShed, homeScope: { state: 'resolved', homeId: AREA } },
        [SCOPED_POWER_URI]: SERVED_AREA_POWER,
      },
      settings,
    });
    const { state } = await import('../src/ui/state.ts');
    state.dryRun = false;
    await selectArea();
    const { refreshPlan } = await import('../src/ui/plan.ts');
    await refreshPlan();
    expect(surfaceText()).not.toContain('Simulation mode');

    // The flag is DELETED (area cleanup, a second WebView, the API): the
    // runtime reads absence as its simulate-until-enabled boot default, and
    // the `settings.unset` event is the only signal an open WebView gets.
    delete settings[dryRunKey];
    const { createSettingsUnsetHandler } = await import('../src/ui/settingsChangeRouter.ts');
    createSettingsUnsetHandler()(dryRunKey);
    await flushAsync();

    expect(surfaceText()).toContain('Simulation mode');
  });
});
