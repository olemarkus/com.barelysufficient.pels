import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes';
import { DEVICE_HOME_ASSIGNMENTS, HOMES_CONFIG } from '../../contracts/src/settingsKeys';
import { createHomeyMock } from './helpers/homeyApiMock';

/* -------------------------------------------------------------------------- *
 * Meter-area home badges on the Devices and Modes lists.
 *
 * The load-bearing case is the Modes list: `savePriorities` ranks the RENDERED
 * rows `index + 1`, so a badge that filtered the list would silently rewrite
 * the hidden home's stored priorities. The suite therefore asserts both that
 * every device still renders and that the saved rank map is byte-identical to
 * the single-home one.
 * -------------------------------------------------------------------------- */

const flushPromises = () => new Promise<void>((resolve) => {
  setTimeout(() => resolve(), 0);
});

const RENTAL = 'h_11111111';
const ANNEX = 'h_22222222';

const buildHomesPayload = (overrides: Record<string, unknown> = {}) => ({
  homes: [
    {
      homeId: RENTAL, name: 'Leilighet i underetasjen', rootZoneId: 'z_rental', meterDeviceId: 'm1',
    },
    {
      homeId: ANNEX, name: 'Annex', rootZoneId: 'z_annex', meterDeviceId: 'm2',
    },
  ],
  membershipByDeviceId: {
    'dev-rental': { homeId: RENTAL, source: 'zone' },
    'dev-annex': { homeId: ANNEX, source: 'pin' },
    'dev-main': { homeId: 'main', source: 'fallback' },
  },
  zoneTree: null,
  hasSubHomes: true,
  runtimeActive: true,
  configDegraded: false,
  ...overrides,
});

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'dev-main',
  name: 'Hall heater',
  deviceClass: 'heater',
  deviceType: 'temperature',
  targets: [{ id: 'target_temperature', value: 20, unit: '°C', step: 0.5 }],
  binaryControl: { on: true },
  ...overrides,
});

const THREE_DEVICES = [
  buildDevice({ id: 'dev-rental', name: 'Rental panel' }),
  buildDevice({ id: 'dev-annex', name: 'Annex panel' }),
  buildDevice({ id: 'dev-main', name: 'Hall heater' }),
];

const setupDevicesDom = () => {
  document.body.innerHTML = `
    <div id="device-card-list"></div>
    <p id="empty-state" hidden></p>
    <button id="refresh-button"></button>
  `;
};

const setupModesDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <md-filled-select id="mode-select" data-test-value="Home"></md-filled-select>
    <md-filled-select id="active-mode-select"></md-filled-select>
    <div id="priority-list"></div>
    <p id="priority-empty" hidden></p>
    <md-filled-text-field id="mode-new"></md-filled-text-field>
  `;
};

const mockDeviceListPeers = () => {
  vi.doMock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/plan.ts', () => ({ refreshPlan: vi.fn() }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast: vi.fn().mockResolvedValue(undefined),
    showToastError: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError: vi.fn().mockResolvedValue(undefined),
    logSettingsWarn: vi.fn().mockResolvedValue(undefined),
  }));
};

/** Wire the Homey client and prime the badge index from a `ui_homes` payload. */
const primeBadges = async (homes: unknown) => {
  const homey = createHomeyMock({ uiState: { homes } });
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient(homey);
  const { refreshHomeBadges } = await import('../src/ui/homeBadges.ts');
  await refreshHomeBadges();
  return homey;
};

describe('home badge index resolution', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('badges nothing while the saved config is held (runtimeActive false)', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    // `ui_homes` diagnostics report SAVED areas even while the control port is
    // held all-main, so a badge here would name a home the runtime is not using.
    // A vouched-for held config RESOLVES (to the empty index) — it must clear
    // stale badges, unlike a degraded read.
    const held = resolveHomeBadgeRead(buildHomesPayload({ runtimeActive: false }));
    expect(held).toEqual({
      status: 'resolved',
      index: { areaNameByHomeId: {}, areaHomeIdByDeviceId: {} },
    });
  });

  it('badges nothing on a single-home install', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    expect(resolveHomeBadgeRead({
      homes: [], membershipByDeviceId: {}, hasSubHomes: false, runtimeActive: true, configDegraded: false,
    })).toEqual({
      status: 'resolved',
      index: { areaNameByHomeId: {}, areaHomeIdByDeviceId: {} },
    });
  });

  it('classifies a degraded snapshot as unavailable rather than an empty index', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    // `configDegraded` payloads may carry empty/stale homes data the runtime
    // cannot vouch for (suspect store read, boot window) — resolving one would
    // let it replace a good index. Only a literal `false` is a vouch, so a
    // flagless payload is unavailable too.
    expect(resolveHomeBadgeRead(buildHomesPayload({ configDegraded: true }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ configDegraded: undefined }))).toEqual({ status: 'unavailable' });
  });

  it('classifies a vouched payload with missing or junk flags as unavailable, not an empty index', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    // `configDegraded: false` vouches for the snapshot, but a MISSING or
    // non-boolean `runtimeActive`/`hasSubHomes` is a partial/malformed payload
    // (version skew, truncated serve) — not an affirmation that no areas are
    // active. Resolving it to the empty index would clear every badge.
    expect(resolveHomeBadgeRead(buildHomesPayload({ runtimeActive: undefined }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ hasSubHomes: undefined }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ runtimeActive: 'true' }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ hasSubHomes: 1 }))).toEqual({ status: 'unavailable' });
    // Boolean `false` remains a vouched intentional-no-badging read (held
    // config / single-home) and must keep RESOLVING to the empty index — the
    // gate narrows to typed booleans without breaking stale-badge clearing.
    expect(resolveHomeBadgeRead(buildHomesPayload({ hasSubHomes: false })).status).toBe('resolved');
  });

  it('classifies a malformed active badge collection as unavailable, not a cleared index', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    // The flags vouch that meter areas are ACTIVE, so the collections carrying
    // them have to be present. A truncated serve that drops `homes` would clear
    // every badge; one that drops `membershipByDeviceId` would re-badge every
    // device as Main home. Both state something the payload never carried, so
    // both take the same abandon-grace as a malformed flag.
    expect(resolveHomeBadgeRead(buildHomesPayload({ homes: undefined }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ homes: 'h_11111111' }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ membershipByDeviceId: undefined })))
      .toEqual({ status: 'unavailable' });
    // An array is not a membership map either — `{}`-shaped reads only.
    expect(resolveHomeBadgeRead(buildHomesPayload({ membershipByDeviceId: [] })))
      .toEqual({ status: 'unavailable' });
    // `hasSubHomes: true` promised at least one area, so a list that yields
    // none — empty, or every entry unusable — contradicts its own flags and is
    // the same defect as a missing list.
    expect(resolveHomeBadgeRead(buildHomesPayload({ homes: [] }))).toEqual({ status: 'unavailable' });
    expect(resolveHomeBadgeRead(buildHomesPayload({ homes: [{ homeId: '', name: 'Nameless id' }, 'junk'] })))
      .toEqual({ status: 'unavailable' });
    // An empty membership map is NOT malformed: with areas configured, every
    // device may still legitimately belong to the Main home.
    expect(resolveHomeBadgeRead(buildHomesPayload({ membershipByDeviceId: {} }))).toEqual({
      status: 'resolved',
      index: {
        areaNameByHomeId: { [RENTAL]: 'Leilighet i underetasjen', [ANNEX]: 'Annex' },
        areaHomeIdByDeviceId: {},
      },
    });
  });

  it('keeps the last-good index when a vouched payload drops the membership map', async () => {
    await primeBadges(buildHomesPayload());
    const { refreshHomeBadges, resolveHomeBadge } = await import('../src/ui/homeBadges.ts');
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(createHomeyMock({
      // Healthy flags, active areas, but the membership map never arrived. The
      // old fallback read that as "every device is Main home" and overwrote a
      // good index with it.
      uiState: { homes: buildHomesPayload({ membershipByDeviceId: undefined }) },
    }));

    await refreshHomeBadges();

    expect(resolveHomeBadge('dev-rental')?.label).toBe('Leilighet i underetasjen');
  });

  it('keeps the last-good index when a vouched payload arrives with a missing flag', async () => {
    await primeBadges(buildHomesPayload());
    const { refreshHomeBadges, resolveHomeBadge } = await import('../src/ui/homeBadges.ts');
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(createHomeyMock({
      // `configDegraded: false` but no `runtimeActive`: a partial payload must
      // not overwrite the good index and re-badge every device as Main home.
      uiState: { homes: buildHomesPayload({ runtimeActive: undefined }) },
    }));

    await refreshHomeBadges();

    expect(resolveHomeBadge('dev-rental')?.label).toBe('Leilighet i underetasjen');
  });

  it('drops malformed entries and memberships naming an unlisted home', async () => {
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    const read = resolveHomeBadgeRead(buildHomesPayload({
      homes: [
        { homeId: RENTAL, name: 'Rental unit', rootZoneId: 'z', meterDeviceId: null },
        { homeId: '', name: 'Nameless id' },
        { homeId: ANNEX, name: 42 },
      ],
      membershipByDeviceId: {
        'dev-rental': { homeId: RENTAL, source: 'zone' },
        'dev-annex': { homeId: ANNEX, source: 'zone' },
        'dev-broken': 'not-an-object',
      },
    }));
    expect(read).toEqual({
      status: 'resolved',
      index: {
        areaNameByHomeId: { [RENTAL]: 'Rental unit' },
        // The annex is not a listed area, so its device reads as Main home
        // rather than carrying a raw home id.
        areaHomeIdByDeviceId: { 'dev-rental': RENTAL },
      },
    });
  });

  it('resolves a blank-named area to the canonical "Meter area" label instead of dropping it', async () => {
    // Persisted areas may carry an empty or whitespace-only name; the
    // terminology contract renders those as "Meter area". Dropping the entry
    // would strip a valid area's badges; keeping raw whitespace would render
    // an invisible label.
    const { resolveHomeBadgeRead } = await import('../src/ui/homeBadges.ts');
    const read = resolveHomeBadgeRead(buildHomesPayload({
      homes: [
        { homeId: RENTAL, name: '', rootZoneId: 'z', meterDeviceId: null },
        { homeId: ANNEX, name: '   ', rootZoneId: 'z2', meterDeviceId: null },
      ],
      membershipByDeviceId: {
        'dev-rental': { homeId: RENTAL, source: 'zone' },
      },
    }));
    expect(read).toEqual({
      status: 'resolved',
      index: {
        areaNameByHomeId: {
          [RENTAL]: 'Meter area',
          [ANNEX]: 'Meter area',
        },
        areaHomeIdByDeviceId: { 'dev-rental': RENTAL },
      },
    });
  });

  it('keeps the last-good index when the ui_homes read fails', async () => {
    const logSettingsError = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError, logSettingsWarn: vi.fn() }));
    await primeBadges(buildHomesPayload());
    const { refreshHomeBadges, resolveHomeBadge } = await import('../src/ui/homeBadges.ts');
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(createHomeyMock({
      apiHandlers: {
        [`GET ${SETTINGS_UI_HOMES_PATH}`]: () => {
          throw new Error('transport down');
        },
      },
    }));

    await refreshHomeBadges();

    // A blanked index would re-badge every device as Main home — a lie the
    // owner cannot distinguish from a real re-home.
    expect(resolveHomeBadge('dev-rental')?.label).toBe('Leilighet i underetasjen');
    expect(logSettingsError).toHaveBeenCalled();
  });

  it('keeps the last-good index when the homes snapshot is degraded', async () => {
    const homey = await primeBadges(buildHomesPayload());
    const { refreshHomeBadges, resolveHomeBadge } = await import('../src/ui/homeBadges.ts');
    // Suspect store read / boot window: the runtime serves `configDegraded`
    // over an empty cache while the real meter areas are still persisted.
    // Trusting it would re-badge every device as Main home — same abandon-grace
    // as the failed read above.
    homey.__uiState.homes = buildHomesPayload({
      homes: [], membershipByDeviceId: {}, hasSubHomes: false, configDegraded: true,
    });

    await refreshHomeBadges();

    expect(resolveHomeBadge('dev-rental')?.label).toBe('Leilighet i underetasjen');
  });

  it('discards an older ui_homes answer that settles after a newer one', async () => {
    // The device-list fetch and a homes_config notification can overlap; the
    // reads may settle out of order, and the older answer landing last must
    // not overwrite the newer index with a pre-edit membership view.
    const settlers: Array<(payload: unknown) => void> = [];
    const homey = createHomeyMock({
      apiHandlers: {
        [`GET ${SETTINGS_UI_HOMES_PATH}`]: () => new Promise((resolve) => {
          settlers.push(resolve);
        }),
      },
    });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey);
    const { refreshHomeBadges, resolveHomeBadge } = await import('../src/ui/homeBadges.ts');

    const older = refreshHomeBadges();
    const newer = refreshHomeBadges();
    expect(settlers).toHaveLength(2);
    // The newer read settles first, serving the post-rename roster...
    settlers[1]?.(buildHomesPayload({
      homes: [{
        homeId: RENTAL, name: 'Utleiedel', rootZoneId: 'z_rental', meterDeviceId: 'm1',
      }],
    }));
    await newer;
    // ...then the older, pre-rename answer lands last.
    settlers[0]?.(buildHomesPayload());
    await older;

    expect(resolveHomeBadge('dev-rental')?.label).toBe('Utleiedel');
  });
});

describe('home badge chip', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
  });

  it('names the area, names Main home for the complement, and bounds a long name', async () => {
    await primeBadges(buildHomesPayload());
    const { appendHomeBadge } = await import('../src/ui/homeBadges.ts');

    const host = document.createElement('div');
    appendHomeBadge(host, 'dev-rental');
    appendHomeBadge(host, 'dev-main');
    const [area, main] = Array.from(host.querySelectorAll<HTMLElement>('.pels-home-badge'));

    expect(area?.textContent).toBe('Leilighet i underetasjen');
    expect(area?.dataset.tone).toBe('outline');
    // The badge layers on the canonical chip primitive; `.pels-home-badge`
    // carries the width bound that keeps a long name inside a 320 px viewport.
    expect(area?.classList.contains('plan-chip')).toBe(true);
    expect(area?.getAttribute('data-tooltip')).toBe(
      'This device belongs to “Leilighet i underetasjen” and counts against that meter.',
    );
    expect(main?.textContent).toBe('Main home');
    expect(main?.getAttribute('data-tooltip')).toBe('This device belongs to the Main home.');
  });

  it('renders no badge at all on a single-home install', async () => {
    await primeBadges({
      homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, runtimeActive: true, configDegraded: false,
    });
    const { appendHomeBadge } = await import('../src/ui/homeBadges.ts');
    const host = document.createElement('div');
    appendHomeBadge(host, 'dev-main');
    expect(host.children.length).toBe(0);
  });
});

describe('devices list home badges', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDevicesDom();
    mockDeviceListPeers();
  });

  it('badges every row after fetching membership independently of the device payload', async () => {
    const homey = await primeBadges(buildHomesPayload());
    const { getTargetDevices, renderDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');
    state.initialLoadComplete = true;
    state.budgetExemptMap = {};

    (homey.api as ReturnType<typeof vi.fn>).mockClear();
    await getTargetDevices();
    await flushPromises();
    // Membership starts with the device read, but remains independent so it
    // cannot hold the device payload hostage.
    const homesCalls = (homey.api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_homes');
    expect(homesCalls).toHaveLength(1);

    renderDevices(THREE_DEVICES);

    const badgeFor = (deviceId: string) => document
      .querySelector(`[data-device-id="${deviceId}"] .pels-home-badge`)?.textContent;
    expect(badgeFor('dev-rental')).toBe('Leilighet i underetasjen');
    expect(badgeFor('dev-annex')).toBe('Annex');
    expect(badgeFor('dev-main')).toBe('Main home');
  });

  it('returns devices when the optional badge request never settles', async () => {
    vi.doMock('../src/ui/homeBadges.ts', () => ({
      appendHomeBadge: vi.fn(),
      refreshHomeBadges: vi.fn(() => new Promise<void>(() => {})),
    }));
    const homey = createHomeyMock({ uiState: { devices: THREE_DEVICES } });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey);
    const { getTargetDevices } = await import('../src/ui/devices.ts');

    try {
      await expect(getTargetDevices()).resolves.toEqual(THREE_DEVICES);
    } finally {
      vi.doUnmock('../src/ui/homeBadges.ts');
    }
  });

  it('fetches badge membership on the discovery path so new devices render badged', async () => {
    // `refreshDevices` takes the direct branch when discovery returns devices,
    // bypassing `getTargetDevices` — the seam the badge fetch normally rides.
    // Without its own fetch there, every discovered device renders unbadged
    // until something else refetches. No priming here: the index must be
    // populated by the refresh itself.
    const homey = createHomeyMock({
      uiState: { homes: buildHomesPayload(), devices: THREE_DEVICES },
    });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey);
    const { refreshDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');
    state.initialLoadComplete = true;
    state.budgetExemptMap = {};

    await refreshDevices();
    await flushPromises();

    const badgeFor = (deviceId: string) => document
      .querySelector(`[data-device-id="${deviceId}"] .pels-home-badge`)?.textContent;
    expect(badgeFor('dev-rental')).toBe('Leilighet i underetasjen');
    expect(badgeFor('dev-main')).toBe('Main home');
  });
});

describe('modes list home badges', () => {
  beforeEach(() => {
    vi.resetModules();
    // The devices suite doMock-ed modes.ts as a peer; this suite drives the
    // real one. (resetModules clears the module registry, not mock registrations.)
    vi.doUnmock('../src/ui/modes.ts');
    setupModesDom();
  });

  it('labels every row without filtering, and leaves savePriorities ranks untouched', async () => {
    const homey = await primeBadges(buildHomesPayload());
    const { renderPriorities, savePriorities } = await import('../src/ui/modes.ts');
    const { state } = await import('../src/ui/state.ts');
    state.activeMode = 'Home';
    state.editingMode = 'Home';
    state.managedMap = { 'dev-rental': true, 'dev-annex': true, 'dev-main': true };
    state.capacityPriorities = { Home: { 'dev-rental': 1, 'dev-annex': 2, 'dev-main': 3 } };
    state.modeTargets = { Home: {} };
    state.latestDevices = THREE_DEVICES;

    renderPriorities(THREE_DEVICES);

    // NOT filtered: all three homes' devices render, in priority order.
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#priority-list .device-row'));
    expect(rows.map((row) => row.dataset.deviceId)).toEqual(['dev-rental', 'dev-annex', 'dev-main']);
    expect(rows.map((row) => row.querySelector('.pels-home-badge')?.textContent))
      .toEqual(['Leilighet i underetasjen', 'Annex', 'Main home']);
    // The badge is additive — the device name is still its own text node.
    expect(rows[0]?.querySelector('.mode-row__name-text')?.textContent).toBe('Rental panel');

    await savePriorities();
    await flushPromises();

    // `savePriorities` ranks the RENDERED rows 1..N. Every device is rendered,
    // so no home's stored rank is rewritten by the badge feature.
    const priorityWrites = (homey.set as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'capacity_priorities');
    const written = priorityWrites[priorityWrites.length - 1]?.[1];
    expect(written).toEqual({ Home: { 'dev-rental': 1, 'dev-annex': 2, 'dev-main': 3 } });
  });
});

describe('badge refresh routing', () => {
  beforeEach(() => {
    vi.resetModules();
    // Earlier suites doMock-ed devices.ts's peers; this suite drives the real
    // settings-change router graph. (resetModules clears the module registry,
    // not mock registrations.)
    [
      '../src/ui/modes.ts',
      '../src/ui/priceOptimization.ts',
      '../src/ui/plan.ts',
      '../src/ui/toast.ts',
      '../src/ui/logging.ts',
    ].forEach((specifier) => {
      vi.doUnmock(specifier);
    });
    document.body.replaceChildren();
  });

  it.each([
    [HOMES_CONFIG],
    [DEVICE_HOME_ASSIGNMENTS],
  ])('a %s write refetches membership so badges track the saved areas', async (key) => {
    const homey = await primeBadges(buildHomesPayload());
    const { resolveHomeBadge } = await import('../src/ui/homeBadges.ts');
    expect(resolveHomeBadge('dev-rental')?.label).toBe('Leilighet i underetasjen');

    // The owner renames the rental area and deletes the annex; without the
    // router branch the badges would keep naming the pre-edit areas for the
    // rest of the WebView session (`loadDevicesOnce` only ever runs once).
    homey.__uiState.homes = buildHomesPayload({
      homes: [{
        homeId: RENTAL, name: 'Utleiedel', rootZoneId: 'z_rental', meterDeviceId: 'm1',
      }],
    });
    const { createSettingsSetHandler } = await import('../src/ui/settingsChangeRouter.ts');
    createSettingsSetHandler()(key);
    await flushPromises();
    await flushPromises();

    expect(resolveHomeBadge('dev-rental')?.label).toBe('Utleiedel');
    // The annex is no longer a listed area, so its device reads as Main home.
    expect(resolveHomeBadge('dev-annex')?.label).toBe('Main home');
  });
});
