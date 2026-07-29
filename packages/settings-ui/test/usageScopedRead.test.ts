import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeScopedRead } from '../../contracts/src/homeScopedRead.ts';
import {
  HOME_SCOPE_USAGE_UNAVAILABLE_BODY,
  HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE,
} from '../../shared-domain/src/homeScopeCopy.ts';
import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';

/* -------------------------------------------------------------------------- *
 * Per-home Usage (multi-home 7c): the scoped `ui_power` reader.
 *
 * Three properties carry the whole seam and all must survive mutation:
 *
 * 1. Main selection keeps the pre-multi-home REQUEST byte-identical — the
 *    bare `/ui_power` URI (never `?homeId=main`) and validates its untyped
 *    callback envelope before serving. The `apiCache` is keyed by exact URI
 *    and ~20 sites invalidate the bare path, so any drift here silently serves
 *    a single-home user a stale Usage tab.
 * 2. A scoped read discriminates the producer's `homeScope` BEFORE any flat
 *    field is reachable. `unavailable` (and a payload with no scope block —
 *    a producer that ignored the query) must never surface tracker fields:
 *    the empty shape would render as fabricated zeros in that area's history.
 * 3. A THROWN read — either branch — is classified at this boundary as
 *    `unavailable`, never propagated: a rejection escaping the reader aborts
 *    the caller's render pass before the honest-state flip, leaving the fresh
 *    scope's chip over the previous home's figures (the area→Main switch with
 *    a cold bare cache).
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const SCOPED_POWER_URI = `/ui_power?homeId=${AREA}`;

const ROSTER_PAYLOAD = {
  homes: [{ homeId: AREA, name: 'Rental unit' }],
  membershipByDeviceId: {},
  runtimeActive: true,
  configDegraded: false,
};

// Fixed clock so bucket ISO keys land deterministically inside "today".
const FIXED_NOW = Date.UTC(2025, 0, 6, 12, 30, 0);
const HOUR_ISO = new Date(Date.UTC(2025, 0, 6, 11, 0, 0)).toISOString();

const MAIN_TRACKER = { buckets: { [HOUR_ISO]: 2 } };
const AREA_TRACKER = { buckets: { [HOUR_ISO]: 0.7 } };

type ApiResponses = Record<string, unknown>;

const installClient = async (responses: ApiResponses): Promise<string[]> => {
  const calledUris: string[] = [];
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (_key, cb) => cb(null, null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      calledUris.push(`${method} ${uri}`);
      if (Object.prototype.hasOwnProperty.call(responses, uri)) {
        callback(null, responses[uri]);
        return;
      }
      callback(new Error(`unexpected uri ${uri}`));
    },
    on: () => {},
    clock: { getTimezone: () => 'UTC' },
  };
  setHomeyClient(client);
  return calledUris;
};

// Adopt the meter area as the shell's selected home through the REAL scope
// module (roster fetch + pick), so the reader is exercised on the same path
// the scope bar drives — not on a mocked selection.
const selectArea = async (): Promise<void> => {
  const { refreshHomeScope, selectHomeScope } = await import('../src/ui/homeScope.ts');
  await refreshHomeScope();
  selectHomeScope(AREA);
};

const buildUsageDom = () => {
  document.body.innerHTML = `
    <section id="usage-panel" data-loading="true">
      <section id="usage-scope-unavailable" class="usage-scope-unavailable" hidden>
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
      <div id="usage-pattern-averages">
        <div data-pattern-metric="weekday"><span id="usage-weekday-avg"></span></div>
        <div data-pattern-metric="weekend"><span id="usage-weekend-avg"></span></div>
      </div>
      <div id="hourly-pattern-toggle-mount"></div>
      <div id="hourly-pattern"></div>
      <div id="hourly-pattern-meta"></div>
      <div id="daily-list"></div>
      <div id="daily-empty" hidden></div>
    </section>
  `;
};

describe('resolveHomeScopedRead', () => {
  it('serves a payload resolved FOR THE REQUESTED home, by identity', () => {
    const payload = { tracker: null, homeScope: { state: 'resolved', homeId: AREA } as const };
    const read = resolveHomeScopedRead(payload, AREA);
    expect(read.state).toBe('served');
    if (read.state === 'served') expect(read.payload).toBe(payload);
  });

  it.each([
    ['an unavailable scope block', { tracker: MAIN_TRACKER, homeScope: { state: 'unavailable' as const } }],
    ['a payload with NO scope block (producer ignored the query)', { tracker: MAIN_TRACKER }],
    ['a payload resolved for ANOTHER home (misrouted producer answer)', {
      tracker: MAIN_TRACKER, homeScope: { state: 'resolved' as const, homeId: 'h_other_area' },
    }],
    ['a null payload', null],
    ['an undefined payload', undefined],
  ])('classifies %s as unavailable with the flat fields unreachable', (_name, payload) => {
    const read = resolveHomeScopedRead(payload as never, AREA);
    expect(read.state).toBe('unavailable');
    // Mutation check: the tracker above is non-empty on purpose — the
    // unavailable arm must not carry it (no `payload` property at all).
    expect('payload' in read).toBe(false);
  });
});

describe('readUsagePower', () => {
  beforeEach(() => {
    vi.resetModules();
    buildUsageDom();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the BARE /ui_power for the Main selection, byte-identically', async () => {
    const uris = await installClient({ '/ui_power': { tracker: MAIN_TRACKER, status: null, heartbeat: null } });
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(uris).toEqual(['GET /ui_power']);
    expect(read.state).toBe('served');
    if (read.state === 'served') expect(read.payload.tracker).toBe(MAIN_TRACKER);
  });

  it.each([
    ['a null answer', null],
    ['an undefined answer', undefined],
    ['a partial envelope', { tracker: MAIN_TRACKER, status: null }],
    ['a malformed tracker', { tracker: [], status: null, heartbeat: null }],
    ['a non-finite heartbeat', { tracker: MAIN_TRACKER, status: null, heartbeat: Number.NaN }],
    ['a scoped answer', {
      tracker: AREA_TRACKER,
      status: null,
      heartbeat: null,
      homeScope: { state: 'resolved', homeId: AREA },
    }],
  ])('classifies Main power as unavailable for %s', async (_name, payload) => {
    await installClient({ '/ui_power': payload });
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(read).toEqual({ state: 'unavailable' });
  });

  it('reads the ?homeId= variant for a selected area, never the bare path', async () => {
    const uris = await installClient({
      '/ui_homes': ROSTER_PAYLOAD,
      [SCOPED_POWER_URI]: {
        tracker: AREA_TRACKER, status: null, heartbeat: null, homeScope: { state: 'resolved', homeId: AREA },
      },
    });
    await selectArea();
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(uris).toContain(`GET ${SCOPED_POWER_URI}`);
    expect(uris).not.toContain('GET /ui_power');
    expect(read.state).toBe('served');
    if (read.state === 'served') expect(read.payload.tracker).toBe(AREA_TRACKER);
  });

  it.each([
    ['the producer answered unavailable', {
      tracker: null, status: null, heartbeat: null, homeScope: { state: 'unavailable' as const },
    }],
    ['the producer ignored the query (no scope block)', { tracker: MAIN_TRACKER, status: null, heartbeat: null }],
    // A resolved scope block naming ANOTHER home is a producer answering for
    // the wrong home. The tracker is Main's non-empty history on purpose: if
    // the reader accepted this on `state: 'resolved'` alone, those figures
    // would render under the selected area's chip.
    ['the producer resolved ANOTHER home (misrouted payload)', {
      tracker: MAIN_TRACKER, status: null, heartbeat: null,
      homeScope: { state: 'resolved' as const, homeId: 'h_other_area' },
    }],
  ])('a scoped read is unavailable when %s', async (_name, payload) => {
    await installClient({ '/ui_homes': ROSTER_PAYLOAD, [SCOPED_POWER_URI]: payload });
    await selectArea();
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(read.state).toBe('unavailable');
    expect('payload' in read).toBe(false);
  });

  it('classifies a THROWN scoped read as unavailable — the adapter owns the failure', async () => {
    // No scoped response installed: the client rejects the request, the way a
    // transient Homey transport miss does mid-scope-switch. The rejection must
    // become the explicit `unavailable` result HERE — propagating it would
    // abort the caller's render pass before the honest-state flip, leaving the
    // new scope's chip over the previous home's figures.
    await installClient({ '/ui_homes': ROSTER_PAYLOAD });
    await selectArea();
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(read.state).toBe('unavailable');
    expect('payload' in read).toBe(false);
  });

  it('classifies a THROWN Main read as unavailable — the adapter owns that failure too', async () => {
    // No bare response installed: the Main selection's read rejects after the
    // transport's retries (a cold cache, so nothing absorbs the miss). The
    // rejection must become the explicit `unavailable` result HERE, exactly as
    // the scoped branch's does — escaping, it aborts the caller's render pass
    // after a scope reset, leaving Main's chip over the previous area's data.
    await installClient({});
    const { readUsagePower } = await import('../src/ui/usagePowerRead.ts');

    const read = await readUsagePower();

    expect(read.state).toBe('unavailable');
    expect('payload' in read).toBe(false);
  });
});

describe('Usage panel scope states', () => {
  beforeEach(() => {
    vi.resetModules();
    buildUsageDom();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the honest unavailable state instead of fabricated zeros', async () => {
    await installClient({
      '/ui_homes': ROSTER_PAYLOAD,
      [SCOPED_POWER_URI]: {
        tracker: null, status: null, heartbeat: null, homeScope: { state: 'unavailable' },
      },
    });
    await selectArea();
    const { getPowerUsage, renderPowerStats } = await import('../src/ui/power.ts');

    await renderPowerStats();

    const panel = document.getElementById('usage-panel')!;
    expect(panel.dataset.scopeRead).toBe('unavailable');
    // The skeleton still drops — the notice must not hide behind the shimmer.
    expect(panel.dataset.loading).toBe('false');
    const notice = document.getElementById('usage-scope-unavailable')!;
    expect(notice.hidden).toBe(false);
    expect(document.getElementById('usage-scope-unavailable-headline')!.textContent)
      .toBe(HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE);
    expect(document.getElementById('usage-scope-unavailable-body')!.textContent)
      .toBe(HOME_SCOPE_USAGE_UNAVAILABLE_BODY);
    // No fabricated figures anywhere: the headline keeps its placeholder and
    // the hourly reader surfaces nothing.
    expect(document.getElementById('usage-hero-headline')!.textContent).toBe('-- kWh today');
    expect(await getPowerUsage()).toEqual([]);
  });

  it('renders the honest unavailable state when the scoped read REJECTS', async () => {
    // Same surface contract as the producer-answered `unavailable` above, but
    // for a thrown read: `renderPowerStats` must complete (not reject before
    // the honest-state flip) and land the panel on the notice, never on the
    // previous home's figures under the new scope's chip.
    await installClient({ '/ui_homes': ROSTER_PAYLOAD });
    await selectArea();
    const { renderPowerStats } = await import('../src/ui/power.ts');

    await renderPowerStats();

    const panel = document.getElementById('usage-panel')!;
    expect(panel.dataset.scopeRead).toBe('unavailable');
    expect(panel.dataset.loading).toBe('false');
    expect(document.getElementById('usage-scope-unavailable')!.hidden).toBe(false);
    expect(document.getElementById('usage-hero-headline')!.textContent).toBe('-- kWh today');
  });

  it('switching area → Main over a rejecting bare read lands on the honest notice, not the area\'s figures', async () => {
    // The reported race verbatim: the area is served and painted, the user
    // picks Main, the bare cache is cold, and `/ui_power` exhausts its retries.
    // The refresh must COMPLETE and flip the panel to the honest unavailable
    // notice — a propagating rejection would abort the pass after the scope
    // reset and leave the bar saying Main above the area's history.
    await installClient({
      '/ui_homes': ROSTER_PAYLOAD,
      [SCOPED_POWER_URI]: {
        tracker: AREA_TRACKER, status: null, heartbeat: null, homeScope: { state: 'resolved', homeId: AREA },
      },
    });
    await selectArea();
    const homeScope = await import('../src/ui/homeScope.ts');
    const { renderPowerStats } = await import('../src/ui/power.ts');

    await renderPowerStats();
    expect(document.getElementById('usage-panel')!.dataset.scopeRead).toBe('served');
    expect(document.getElementById('usage-hero-headline')!.textContent).toBe('0.7 kWh today');

    homeScope.selectHomeScope('main');
    await renderPowerStats();

    const panel = document.getElementById('usage-panel')!;
    expect(panel.dataset.scopeRead).toBe('unavailable');
    expect(document.getElementById('usage-scope-unavailable')!.hidden).toBe(false);
    expect(document.getElementById('usage-scope-unavailable-headline')!.textContent)
      .toBe(HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE);
  });

  it('renders the area\'s own history when served, and Main\'s after switching back', async () => {
    await installClient({
      '/ui_homes': ROSTER_PAYLOAD,
      '/ui_power': { tracker: MAIN_TRACKER, status: null, heartbeat: null },
      [SCOPED_POWER_URI]: {
        tracker: AREA_TRACKER, status: null, heartbeat: null, homeScope: { state: 'resolved', homeId: AREA },
      },
    });
    await selectArea();
    const homeScope = await import('../src/ui/homeScope.ts');
    const { renderPowerStats } = await import('../src/ui/power.ts');

    await renderPowerStats();

    const panel = document.getElementById('usage-panel')!;
    expect(panel.dataset.scopeRead).toBe('served');
    expect(document.getElementById('usage-scope-unavailable')!.hidden).toBe(true);
    expect(document.getElementById('usage-hero-headline')!.textContent).toBe('0.7 kWh today');

    homeScope.selectHomeScope('main');
    await renderPowerStats();

    expect(panel.dataset.scopeRead).toBe('served');
    expect(document.getElementById('usage-hero-headline')!.textContent).toBe('2.0 kWh today');
  });
});
