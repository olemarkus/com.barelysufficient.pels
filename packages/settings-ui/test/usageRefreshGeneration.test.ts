import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Usage (multi-home 7c): the stale-completion guard on the Usage
 * repaint.
 *
 * `refreshPowerData` paints every Usage surface from one discriminated power
 * read, then awaits the solar/prices read. Its callers overlap freely — a
 * rapid Main→area scope pick starts a second run while the first is still
 * awaiting. Unversioned, the older run's late completion can repaint after
 * the newer one's. Each run stamps a monotonic generation and every paint is
 * gated on still being the latest run — one test per gate, so no check can
 * silently absorb another's job.
 *
 * All tests drive the REAL modules (scope bar pick → subscription → refresh),
 * with only the Homey client seam controlled so the test decides which read
 * settles when.
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const SCOPED_POWER_URI = `/ui_power?homeId=${AREA}`;
const PRICES_URI = '/ui_prices';

const ROSTER_PAYLOAD = {
  homes: [{ homeId: AREA, name: 'Rental unit' }],
  runtimeActive: true,
  configDegraded: false,
  membershipByDeviceId: {},
};

// Fixed clock (Date only — timeouts stay real so promise settling works) so
// the bucket lands deterministically inside "today".
const FIXED_NOW = Date.UTC(2025, 0, 6, 12, 30, 0);
const HOUR_ISO = new Date(Date.UTC(2025, 0, 6, 11, 0, 0)).toISOString();

const mainPowerPayload = () => ({
  tracker: { buckets: { [HOUR_ISO]: 2 } },
  readings: { state: 'received' as const, lastPowerUpdateMs: 1_700_000_000_000 },
  status: { state: 'unavailable', reason: 'no_status_recorded' },
});

const areaPowerPayload = () => ({
  tracker: { buckets: { [HOUR_ISO]: 0.7 } },
  readings: { state: 'received' as const, lastPowerUpdateMs: 1_700_000_000_000 },
  status: { state: 'unavailable', reason: 'no_status_recorded' },
  homeScope: { state: 'resolved', homeId: AREA },
});

// Solar-carrying variants: recorded generation passes the card's visibility
// gate, and the two homes produce visibly different kWh so a mixed paint is
// unmissable.
const MAIN_GENERATED_KWH = 5;
const AREA_GENERATED_KWH = 1;

const mainSolarPowerPayload = () => ({
  ...mainPowerPayload(),
  tracker: { buckets: { [HOUR_ISO]: 2 }, generationBuckets: { [HOUR_ISO]: MAIN_GENERATED_KWH } },
  readings: { state: 'received' as const, lastPowerUpdateMs: 1_700_000_000_000 },
});

const areaSolarPowerPayload = () => ({
  ...areaPowerPayload(),
  tracker: { buckets: { [HOUR_ISO]: 0.7 }, generationBuckets: { [HOUR_ISO]: AREA_GENERATED_KWH } },
  readings: { state: 'received' as const, lastPowerUpdateMs: 1_700_000_000_000 },
});

// The Usage panel surface: the hero + summary + history mounts the stats pass
// paints, the day-view card the hourly-entries pass paints (`#usage-day-total`
// is the observable for "which home's chart is showing"), and the solar mount
// so the stats pass really awaits the prices read like production does.
const buildUsageDom = (panelHidden = false) => {
  document.body.innerHTML = `
    <section id="usage-panel" ${panelHidden ? 'class="hidden"' : ''} data-loading="true">
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
  /** Release one held request; `position` picks among same-URI holds (FIFO). */
  respond: (uri: string, error: Error | null, payload?: unknown, position?: number) => void;
  pendingCount: (uri: string) => number;
};

/**
 * A client that answers everything immediately EXCEPT the listed URIs, whose
 * callbacks queue until the test releases them — that queue is the whole race:
 * the test chooses which read settles first.
 */
const installDeferredClient = async (deferredUris: readonly string[]): Promise<DeferredClient> => {
  const pendingByUri = new Map<string, HomeyCallback<unknown>[]>();
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (_key, cb) => cb(null, null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      if (method === 'GET' && uri === '/ui_homes') {
        callback(null, ROSTER_PAYLOAD);
        return;
      }
      if (method === 'GET' && deferredUris.includes(uri)) {
        const queue = pendingByUri.get(uri) ?? [];
        queue.push(callback);
        pendingByUri.set(uri, queue);
        return;
      }
      // Logs and every other read: harmless immediate nulls.
      callback(null, null);
    },
    on: () => {},
    clock: { getTimezone: () => 'UTC' },
  };
  setHomeyClient(client);
  return {
    respond: (uri, error, payload, position = 0) => {
      const [callback] = pendingByUri.get(uri)?.splice(position, 1) ?? [];
      if (!callback) throw new Error(`no pending request for ${uri} at position ${position}`);
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

const heroText = () => document.getElementById('usage-hero-headline')!.textContent;
const dayTotalText = () => document.getElementById('usage-day-total')!.textContent;
const scopeReadState = () => document.getElementById('usage-panel')!.dataset.scopeRead;
// The panel's pending contract: `data-loading="true"` hides the hero, cards,
// solar mount and footer behind the shimmer (see the skeleton rules in
// style.css), so this attribute IS "are the figures being shown".
const loadingState = () => document.getElementById('usage-panel')!.dataset.loading;
// First metric on the Solar card is "Produced" — the value that differs
// between the two homes.
const solarProducedText = () => document.querySelector('#solar-usage-card .usage-metric__value')?.textContent;

describe('Usage refresh generation guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a stale run whose first read settles after a newer scope pick painted', async () => {
    buildUsageDom();
    const client = await installDeferredClient(['/ui_power', SCOPED_POWER_URI]);
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    // Run 1 (Main scope): its bare read hangs, the way a slow WebView fetch does.
    const run1 = refreshPowerData();
    await settle();
    expect(client.pendingCount('/ui_power')).toBe(1);

    // The user picks the area. The scope subscription starts run 2, whose
    // scoped read answers at once and paints the area's own history.
    selectHomeScope(AREA);
    await settle();
    client.respond(SCOPED_POWER_URI, null, areaPowerPayload());
    await settle();
    expect(heroText()).toBe('0.7 kWh today');
    expect(dayTotalText()).toBe('0.7 kWh');

    // Run 1's read settles LAST, carrying Main's figures. The stale completion
    // must be dropped whole — unversioned, it would repaint Main's hourly
    // chart under the area's hero (its second read resolves against the NEW
    // scope), mixing two homes on one panel.
    client.respond('/ui_power', null, mainPowerPayload());
    await run1;
    await settle();
    expect(dayTotalText()).toBe('0.7 kWh');
    expect(heroText()).toBe('0.7 kWh today');
  });

  it('keeps a failed Main read unavailable instead of masking it with a second read', async () => {
    buildUsageDom();
    let powerReadCount = 0;
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    const client: HomeySettingsClient = {
      ready: () => Promise.resolve(),
      get: (_key, cb) => cb(null, null),
      set: (_key, _value, cb) => cb(null),
      api: (method, uri, bodyOrCallback, cb) => {
        const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
        if (method === 'GET' && uri === '/ui_power') {
          powerReadCount += 1;
          if (powerReadCount === 1) {
            callback(new Error('transient Main read failure'));
          } else {
            callback(null, mainPowerPayload());
          }
          return;
        }
        callback(null, null);
      },
      on: () => {},
      clock: { getTimezone: () => 'UTC' },
    };
    setHomeyClient(client);
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    await refreshPowerData();

    // A second read would succeed and falsely turn the complete refresh into a
    // served, measured-empty hourly view paired with populated summary stats.
    expect(powerReadCount).toBe(1);
    expect(scopeReadState()).toBe('unavailable');
    expect(document.getElementById('usage-scope-unavailable')!.hidden).toBe(false);
    expect(heroText()).toBe('-- kWh today');
  });

  it('a run superseded during the solar/prices await must not paint its hero', async () => {
    buildUsageDom();
    const client = await installDeferredClient(['/ui_power', SCOPED_POWER_URI, PRICES_URI]);
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    // Run 1 (Main): its power read answers, the hourly chart paints, and the
    // stats pass proceeds to the solar section — whose prices read the test
    // holds. The hero is NOT painted yet (it follows the solar await).
    const run1 = refreshPowerData();
    await settle();
    client.respond('/ui_power', null, mainPowerPayload());
    await settle();
    expect(dayTotalText()).toBe('2.0 kWh');
    expect(heroText()).toBe('-- kWh today');
    expect(client.pendingCount(PRICES_URI)).toBe(1);

    // The user picks the area mid-solar-await. Run 2 reads, reaches its own
    // solar await (a second held prices read), and its release paints the
    // area's hero.
    selectHomeScope(AREA);
    await settle();
    client.respond(SCOPED_POWER_URI, null, areaPowerPayload());
    await settle();
    expect(client.pendingCount(PRICES_URI)).toBe(2);
    client.respond(PRICES_URI, null, null, 1);
    await settle();
    expect(heroText()).toBe('0.7 kWh today');
    expect(dayTotalText()).toBe('0.7 kWh');

    // Run 1's prices read settles LAST. Its resumption sits past the staleness
    // stamp, so it must drop — painting would put MAIN's hero over the area's
    // chart, the exact mixed panel the generation guard exists to prevent.
    client.respond(PRICES_URI, null, null, 0);
    await run1;
    await settle();
    expect(heroText()).toBe('0.7 kWh today');
    expect(dayTotalText()).toBe('0.7 kWh');
  });

  it('a run superseded during the solar/prices await must not repaint the solar card', async () => {
    // The solar card is the ONE surface the caller's post-await check cannot
    // protect: `renderSolarUsageSection` awaits its own prices read and paints
    // before returning, so a stale run reaching that await would overwrite just
    // the card — leaving one home's solar under another home's hero, a mixed
    // panel that persists until the next refresh.
    buildUsageDom();
    const client = await installDeferredClient(['/ui_power', SCOPED_POWER_URI, PRICES_URI]);
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    // Run 1 (Main): power read answers, stats pass reaches the held prices read.
    const run1 = refreshPowerData();
    await settle();
    client.respond('/ui_power', null, mainSolarPowerPayload());
    await settle();
    expect(client.pendingCount(PRICES_URI)).toBe(1);

    // The user picks the area mid-solar-await; run 2 paints the area's card.
    selectHomeScope(AREA);
    await settle();
    client.respond(SCOPED_POWER_URI, null, areaSolarPowerPayload());
    await settle();
    expect(client.pendingCount(PRICES_URI)).toBe(2);
    client.respond(PRICES_URI, null, null, 1);
    await settle();
    expect(solarProducedText()).toBe('1.0 kWh');

    // Run 1's prices read settles LAST. Ungated, it would write Main's 5.0 kWh
    // into the card and only then discover it was superseded.
    client.respond(PRICES_URI, null, null, 0);
    await run1;
    await settle();
    expect(solarProducedText()).toBe('1.0 kWh');
  });

  it('a scope pick hides the previous home\'s figures until the new home\'s run repaints', async () => {
    buildUsageDom();
    const client = await installDeferredClient(['/ui_power', SCOPED_POWER_URI]);
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    // Main paints completely: the panel leaves its first-paint pending state.
    const run1 = refreshPowerData();
    await settle();
    client.respond('/ui_power', null, mainPowerPayload());
    await run1;
    await settle();
    expect(loadingState()).toBe('false');
    expect(heroText()).toBe('2.0 kWh today');

    // The pick renames the panel SYNCHRONOUSLY while the area's read is still
    // in flight. Main's 2.0 kWh must go back behind the shimmer immediately —
    // left visible, it reads as the area's own measured history.
    selectHomeScope(AREA);
    await settle();
    expect(loadingState()).toBe('true');

    client.respond(SCOPED_POWER_URI, null, areaPowerPayload());
    await settle();
    expect(loadingState()).toBe('false');
    expect(heroText()).toBe('0.7 kWh today');
  });

  it('a superseded run must not reveal the panel while the new home is still loading', async () => {
    buildUsageDom();
    const client = await installDeferredClient(['/ui_power', SCOPED_POWER_URI, PRICES_URI]);
    const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
    await refreshHomeScope();
    const { refreshPowerData } = await import('../src/ui/uiRefreshTasks.ts');

    // Run 1 (Main) parks in its solar/prices await, past the point where its
    // hourly entries already painted.
    const run1 = refreshPowerData();
    await settle();
    client.respond('/ui_power', null, mainPowerPayload());
    await settle();
    expect(client.pendingCount(PRICES_URI)).toBe(1);

    // Area picked: pending state on, run 2's scoped read held.
    selectHomeScope(AREA);
    await settle();
    expect(loadingState()).toBe('true');

    // Run 1 now finishes — it drops its paints, but its render pass still runs
    // to completion. Clearing the skeleton there would uncover Main's hero and
    // hourly chart under the area's name, with the area's own read still in
    // flight: the reveal belongs to the run that owns the pending state.
    client.respond(PRICES_URI, null, null, 0);
    await run1;
    await settle();
    expect(loadingState()).toBe('true');
    expect(client.pendingCount(SCOPED_POWER_URI)).toBe(1);

    client.respond(SCOPED_POWER_URI, null, areaPowerPayload());
    await settle();
    expect(loadingState()).toBe('false');
    expect(heroText()).toBe('0.7 kWh today');
  });
});
