import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Usage (multi-home 7c): the BOOTSTRAP Usage paint goes through the
 * generation-fenced refresh.
 *
 * Handlers become interactive before `loadInitialData` finishes, so a user can
 * open Usage and pick a meter area while the parallel bootstrap loads are
 * still pending. The pick's own `refreshPowerData` run paints that area; a
 * bootstrap render pass that captured `getPowerUsage()` separately and painted
 * OUTSIDE the run generation would then overwrite the hourly chart with its
 * previously captured Main entries while the stats pass recomputes the hero
 * for the picked scope — one home's chart under the other home's hero.
 *
 * This spec drives the REAL `boot()` (only the Homey client seam is
 * controlled) and holds boot's bare `/ui_power` read to keep the bootstrap
 * parked while the pick lands. It must keep failing if boot ever regains a
 * fenceless Usage paint.
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const BARE_POWER_URI = '/ui_power';
const SCOPED_POWER_URI = `/ui_power?homeId=${AREA}`;

const ROSTER_PAYLOAD = {
  homes: [{ homeId: AREA, name: 'Rental unit' }],
  membershipByDeviceId: {},
  runtimeActive: true,
  configDegraded: false,
};

// Fixed clock (Date only — timeouts stay real so promise settling works) so
// the bucket lands deterministically inside "today".
const FIXED_NOW = Date.UTC(2025, 0, 6, 12, 30, 0);
const HOUR_ISO = new Date(Date.UTC(2025, 0, 6, 11, 0, 0)).toISOString();

const mainPowerPayload = () => ({
  tracker: { buckets: { [HOUR_ISO]: 2 } },
  status: null,
  heartbeat: null,
});

const areaPowerPayload = () => ({
  tracker: { buckets: { [HOUR_ISO]: 0.7 } },
  status: null,
  heartbeat: null,
  homeScope: { state: 'resolved', homeId: AREA },
});

// The persisted settings boot's load phases read; everything else resolves to
// null (the mock-settings convention `settings.test.ts` boots with).
const SETTINGS_STORE: Record<string, unknown> = {
  operating_mode: 'Home',
  capacity_priorities: {},
  mode_device_targets: {},
  controllable_devices: {},
  managed_devices: {},
  price_optimization_settings: {},
};

// Immediate answers for the reads whose consumers need a shaped payload; every
// other GET resolves null (each loader's own junk-classification absorbs it).
// `/ui_bootstrap` is deliberately null: boot then takes its plain-loads path,
// whose Phase-2 bare `/ui_power` read is the hold this race needs.
const IMMEDIATE_GET_RESPONSES: Record<string, unknown> = {
  '/ui_homes': ROSTER_PAYLOAD,
  [SCOPED_POWER_URI]: areaPowerPayload(),
  '/ui_plan': { plan: null },
  '/ui_devices': { devices: [], hasManagedSolarDevice: false, hasExhibitedExport: false },
  '/ui_device_log': { version: 1, entriesByDeviceId: {} },
  '/ui_deferred_objective_settings': { version: 1, objectivesByDeviceId: {} },
  '/starvation_rescue_devices': { rescuableDeviceIds: [] },
  '/homey_devices': [],
  '/homey_energy_meters': [],
};

// The Usage surface plus the few shell elements boot wires unconditionally
// (`#refresh-button` has an unguarded listener registration). The usage panel
// carries no `panel` class so `showTab('overview')` cannot hide it — this is
// the "user already opened Usage" posture, the same harness shape as
// `usageRefreshGeneration.test.ts`.
const buildBootDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div id="dry-run-banner" hidden></div>
    <md-outlined-button id="simulation-disable-button"></md-outlined-button>
    <div id="stale-data-banner" hidden><span id="stale-data-text"></span></div>
    <p id="empty-state" hidden></p>
    <md-outlined-button id="refresh-button"></md-outlined-button>
    <md-outlined-button id="reset-stats-button"></md-outlined-button>
    <section id="usage-panel" data-loading="true">
      <section id="usage-scope-unavailable" hidden>
        <h3 id="usage-scope-unavailable-headline"></h3>
        <p id="usage-scope-unavailable-body"></p>
      </section>
      <div id="usage-hero">
        <h2 id="usage-hero-headline">-- kWh today</h2>
        <span id="usage-hero-delta" hidden></span>
        <div id="usage-hero-solar" hidden></div>
        <div id="usage-hero-comparison"></div>
        <p id="usage-hero-projection" hidden></p>
      </div>
      <span hidden id="usage-today"></span>
      <span id="usage-week"></span>
      <span id="usage-month"></span>
      <div id="solar-usage-mount"></div>
      <div id="usage-pattern-averages">
        <div data-pattern-metric="weekday"><span id="usage-weekday-avg"></span></div>
        <div data-pattern-metric="weekend"><span id="usage-weekend-avg"></span></div>
      </div>
      <div id="hourly-pattern-toggle-mount"></div>
      <div id="hourly-pattern"></div>
      <div id="hourly-pattern-meta"></div>
      <div id="daily-list"></div>
      <div id="daily-empty" hidden></div>
      <h4 id="usage-day-title"></h4>
      <div id="usage-day-label"></div>
      <div id="usage-day-status-pill" hidden></div>
      <div id="usage-day-toggle-mount"></div>
      <div id="usage-day-total"></div>
      <div id="usage-day-peak"></div>
      <div id="usage-day-over-cap"></div>
      <div id="usage-day-chart"><div id="usage-day-bars"></div><div id="usage-day-labels"></div></div>
      <div id="usage-day-readout" hidden></div>
      <div id="usage-day-empty"></div>
      <div id="usage-day-meta"></div>
    </section>
  `;
};

type DeferredClient = {
  respond: (uri: string, error: Error | null, payload?: unknown) => void;
  pendingCount: (uri: string) => number;
};

const installBootClient = async (): Promise<DeferredClient> => {
  const pendingByUri = new Map<string, HomeyCallback<unknown>[]>();
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (key, cb) => cb(null, SETTINGS_STORE[key] ?? null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      if (method === 'GET' && uri === BARE_POWER_URI) {
        const queue = pendingByUri.get(uri) ?? [];
        queue.push(callback);
        pendingByUri.set(uri, queue);
        return;
      }
      if (method === 'GET' && Object.prototype.hasOwnProperty.call(IMMEDIATE_GET_RESPONSES, uri)) {
        callback(null, IMMEDIATE_GET_RESPONSES[uri]);
        return;
      }
      // Logs and every other read: harmless immediate nulls.
      callback(null, null);
    },
    on: () => {},
    clock: { getTimezone: () => 'UTC' },
  };
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  setHomeyClient(client);
  // `boot()` discovers the client through the global, not the setter.
  (globalThis as { Homey?: HomeySettingsClient }).Homey = client;
  (window as Window & { Homey?: HomeySettingsClient }).Homey = client;
  return {
    respond: (uri, error, payload) => {
      const [callback] = pendingByUri.get(uri)?.splice(0, 1) ?? [];
      if (!callback) throw new Error(`no pending request for ${uri}`);
      callback(error, payload);
    },
    pendingCount: (uri) => pendingByUri.get(uri)?.length ?? 0,
  };
};

// Two macrotask hops drain every microtask chain a released callback resumes.
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
};

const waitUntil = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
};

const heroText = () => document.getElementById('usage-hero-headline')!.textContent;
const dayTotalText = () => document.getElementById('usage-day-total')!.textContent;
const scopeReadState = () => document.getElementById('usage-panel')!.dataset.scopeRead;

describe('bootstrap Usage paint vs a mid-boot scope pick', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_NOW));
    window.localStorage.clear();
    buildBootDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { Homey?: HomeySettingsClient }).Homey;
    delete (window as Window & { Homey?: HomeySettingsClient }).Homey;
  });

  it('a scope pick made while bootstrap loads are pending is not overwritten by the bootstrap paint', async () => {
    const client = await installBootClient();
    const { boot } = await import('../src/ui/boot.ts');
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    const { state } = await import('../src/ui/state.ts');

    // Boot runs until its Phase-2 loads park on the held bare `/ui_power`
    // read. Handlers are already interactive at this point (they come up
    // before `loadInitialData`).
    const bootPromise = boot();
    await waitUntil(() => client.pendingCount(BARE_POWER_URI) >= 1, 'boot to reach the held /ui_power read');

    // The user opens Usage and picks the area mid-boot; the pick's own
    // generation-fenced run paints the area's history at once.
    await refreshHomeScope();
    selectHomeScope(AREA);
    await settle();
    expect(heroText()).toBe('0.7 kWh today');
    expect(dayTotalText()).toBe('0.7 kWh');

    // The held bootstrap reads settle LAST, carrying MAIN's payload, and boot
    // finishes its render phase.
    while (client.pendingCount(BARE_POWER_URI) > 0) {
      client.respond(BARE_POWER_URI, null, mainPowerPayload());
    }
    await bootPromise;
    await settle();

    // Boot really completed — a swallowed boot failure would skip the render
    // phase and make the paint assertions below vacuous.
    expect(state.initialLoadComplete).toBe(true);
    // The bootstrap paint went through the generation-fenced refresh, so it
    // re-read under the PICKED scope. A fenceless bootstrap paint would have
    // stamped Main's captured entries over the area's hourly chart (2.0 kWh
    // under a 0.7 kWh hero — two homes mixed on one panel).
    expect(dayTotalText()).toBe('0.7 kWh');
    expect(heroText()).toBe('0.7 kWh today');
    expect(scopeReadState()).toBe('served');
  });
});
