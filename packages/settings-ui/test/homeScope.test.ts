import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { HOMES_CONFIG, MAIN_HOME_ID } from '../../contracts/src/settingsKeys.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes.ts';
import { HOME_SCOPE_BAR_LABEL } from '../../shared-domain/src/homeScopeCopy.ts';
import {
  getHomeScope,
  initHomeScope,
  notifyHomeScopeSettingChanged,
  refreshHomeScope,
  selectHomeScope,
  subscribeToHomeScope,
} from '../src/ui/homeScope.ts';
import { state } from '../src/ui/state.ts';

vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

/* -------------------------------------------------------------------------- *
 * The shell's global home scope bar: it stays hidden (no grid row) for a home
 * with no meter areas and on pages that do not honour the scope, remembers the
 * pick across sessions, and never lets a persisted id survive the deletion of
 * its area.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_abc';
const AREA_TWO = 'h_two';
const SCOPE_STORAGE_KEY = 'pels.shell.homeScope';

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const homesPayload = (homes: Array<{ homeId: string; name: string }>) => ({
  homes: homes.map((home) => ({ ...home, rootZoneId: 'z1', meterDeviceId: 'dev_a' })),
  membershipByDeviceId: {},
  zoneTree: null,
  hasSubHomes: homes.length > 0,
  runtimeActive: true,
  configDegraded: false,
});

let homey: MockHomeyClient;

const install = (homes: Array<{ homeId: string; name: string }>) => {
  homey = installHomeyMock({ uiState: { homes: homesPayload(homes) } });
  setHomeyClient(homey as never);
};

const bar = () => document.querySelector<HTMLElement>('#home-scope-bar')!;
/** The menu button names the home in force; the caret is a trailing icon. */
const chip = () => document.querySelector<HTMLElement>('#home-scope-chip');
const chipHome = () => chip()?.textContent?.trim() ?? null;
const toggleMenu = () => chip()!.dispatchEvent(new Event('click', { bubbles: true }));
/**
 * The menu is mounted only while open, so read its items through an open/close
 * cycle — the same way the roster is actually reachable to a user.
 */
const readMenu = <T>(read: (items: Element[]) => T): T => {
  toggleMenu();
  const value = read([...document.querySelectorAll('md-menu-item')]);
  toggleMenu();
  return value;
};
const optionHomeIds = () => readMenu((items) => items.map((item) => item.getAttribute('data-home-id')));
const optionLabels = () => readMenu((items) => items.map((item) => item.textContent));
/** Drive the picker the way a user does: open the chip, tap an item. */
const pickHome = (homeId: string) => {
  toggleMenu();
  document.querySelector<HTMLElement>(`#home-scope-option-${homeId}`)!
    .dispatchEvent(new Event('click', { bubbles: true }));
};

// The scope is module state shared by the whole WebView, so every case starts
// from a known-empty roster with Main selected and no persisted pick — otherwise
// a leftover area from an earlier case could mask a real bug here.
// jsdom ships no Web Animations API, but Material's menu close path calls
// `surfaceEl.animate` — a REAL close (a pick, or the bar hiding while the menu
// is open) would otherwise surface as an unhandled rejection that fails the
// whole vitest run despite every assertion passing. Minimal Animation-like
// stub; assigned once, kept across cases.
if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = (() => ({
    finished: Promise.resolve(),
    cancel: () => {},
    play: () => {},
    pause: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof Element.prototype.animate;
}

beforeEach(async () => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="home-scope-bar" hidden></div>';
  state.activePanel = 'limits';
  window.localStorage.clear();
  selectHomeScope(MAIN_HOME_ID);
  install([]);
  initHomeScope();
  await refreshHomeScope();
});

afterEach(() => {
  setHomeyClient(null);
  document.body.innerHTML = '';
});

describe('visibility', () => {
  it('stays hidden for a home with no meter areas', async () => {
    install([]);
    await refreshHomeScope();
    await flushAsync();
    expect(bar().hidden).toBe(true);
    expect(chip()).toBeNull();
  });

  it('shows Main home first, then each meter area, once an area exists', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }, { homeId: AREA_TWO, name: 'Hytta' }]);
    await refreshHomeScope();
    await flushAsync();
    expect(bar().hidden).toBe(false);
    expect(document.body.textContent).toContain(HOME_SCOPE_BAR_LABEL);
    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID, AREA_TWO]);
    expect(optionLabels()).toEqual(['Main home', 'Utleie', 'Hytta']);
    expect(chipHome()).toBe('Main home');
  });

  it('stays hidden on a page whose content does not honour the scope', async () => {
    // Honesty gate: a bar naming a home on a page still showing whole-home
    // figures would be a claim the page cannot pay. Later train PRs add their
    // panel id as each surface learns the scope. (`budget` stays Main-only —
    // the daily budget is a Main-home constraint; its explicit scope line
    // lands in the honest-states PR.)
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    state.activePanel = 'budget';
    await refreshHomeScope();
    await flushAsync();
    expect(bar().hidden).toBe(true);
    expect(chip()).toBeNull();

    // Navigating to a scope-aware page repaints it without a refetch.
    initHomeScope();
    state.activePanel = 'limits';
    document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId: 'limits' } }));
    expect(bar().hidden).toBe(false);
  });
});

describe('selection', () => {
  it('notifies subscribers and persists the pick', async () => {
    const listener = vi.fn();
    subscribeToHomeScope(listener);
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();

    pickHome(AREA_ID);
    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBe(AREA_ID);

    // Back to Main clears the key rather than persisting the default.
    selectHomeScope(MAIN_HOME_ID);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull();
  });

  it('resolves an id the roster does not contain back to the Main home', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);
    expect(chipHome()).toBe('Utleie');

    // A ghost id resolves to Main AND the rendered chip snaps back, so the
    // control can never name a scope that is not in force.
    selectHomeScope('h_ghost');
    expect(getHomeScope().selectedHomeId).toBe(MAIN_HOME_ID);
    expect(chipHome()).toBe('Main home');
  });

  it('reopens with a single tap after Material dismisses its own menu', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();

    toggleMenu();
    expect(document.querySelectorAll('md-menu-item').length).toBeGreaterThan(0);
    // Outside click and Escape close the menu inside Material, announced only
    // by its lowercase `closed` event (`menu.js` dispatches
    // `new Event('closed')`). The open flag must resync from it, or the next
    // chip tap burns on unmounting an already-closed menu instead of opening.
    document.querySelector('md-menu')!.dispatchEvent(new Event('closed'));
    toggleMenu();
    expect(document.querySelectorAll('md-menu-item').length).toBeGreaterThan(0);
    // The open flag is module state shared across cases (see beforeEach), and
    // every menu helper here assumes closed-at-entry — leave it that way.
    toggleMenu();
    expect(document.querySelectorAll('md-menu-item').length).toBe(0);
  });

  it('closes the menu state when navigating away hides the bar', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    toggleMenu();
    expect(document.querySelectorAll('md-menu-item').length).toBeGreaterThan(0);
    // Navigate to a page without the bar: the menu's logical state must close
    // with it — the unmounting menu's own `closed` echo is deliberately
    // ignored (stale-echo guard), so returning would otherwise remount the
    // picker already open, popping over the page with no user action.
    initHomeScope();
    // 'budget' stays scope-unaware through the train (the daily budget is a
    // Main-home constraint), so it is the stable navigate-away target.
    state.activePanel = 'budget';
    document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId: 'budget' } }));
    expect(bar().hidden).toBe(true);
    state.activePanel = 'limits';
    document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId: 'limits' } }));
    expect(bar().hidden).toBe(false);
    expect(document.querySelectorAll('md-menu-item').length).toBe(0);
  });

  it('serves a blank-named area as "Meter area" instead of refusing the roster', async () => {
    // The runtime legitimately persists empty/whitespace names; the canonical
    // display rule renders them "Meter area". Refusing the roster would hide
    // the bar and strand the area unselectable; admitting raw whitespace
    // would render a blank picker label.
    install([{ homeId: AREA_ID, name: '   ' }]);
    await refreshHomeScope();
    await flushAsync();
    expect(bar().hidden).toBe(false);
    expect(optionLabels()).toEqual(['Main home', 'Meter area']);
  });

  it('ignores a stale closed echo from a menu a pick already unmounted', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();

    // A pick unmounts the menu instantly, but Material's close animation keeps
    // running on the detached element and still ends in a `closed` dispatch.
    toggleMenu();
    const staleMenu = document.querySelector('md-menu')!;
    toggleMenu();
    expect(staleMenu.isConnected).toBe(false);

    // The user has already opened the next menu when the echo lands: it must
    // not close a menu it never belonged to.
    toggleMenu();
    staleMenu.dispatchEvent(new Event('closed'));
    expect(document.querySelectorAll('md-menu-item').length).toBeGreaterThan(0);

    toggleMenu();
    expect(document.querySelectorAll('md-menu-item').length).toBe(0);
  });
});

describe('reconciliation against a fresh roster', () => {
  it('adopts a persisted area that the fresh roster still has', async () => {
    // A fresh WebView session: boot arms the persisted pick, the first roster
    // read confirms it.
    window.localStorage.setItem(SCOPE_STORAGE_KEY, AREA_ID);
    initHomeScope();
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(chipHome()).toBe('Utleie');
  });

  it('lets an explicit Main pick override a still-armed persisted area', async () => {
    // A Main-only deep link (Check power source) followed before the first
    // roster read: the selection is already Main, so the pick used to fall
    // into the same-value early return and leave the candidate armed — the
    // ensuing roster read then adopted the stale area over the explicit pick.
    window.localStorage.setItem(SCOPE_STORAGE_KEY, AREA_ID);
    initHomeScope();
    selectHomeScope(MAIN_HOME_ID);
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    expect(getHomeScope().selectedHomeId).toBe(MAIN_HOME_ID);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull();
  });

  it('refuses a persisted area the fresh roster no longer has, and clears the key', async () => {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, 'h_deleted');
    initHomeScope();
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    expect(getHomeScope().selectedHomeId).toBe(MAIN_HOME_ID);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull();
  });

  it('drops the selection AND the stored key when the area is deleted', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBe(AREA_ID);

    homey.__uiState.homes = homesPayload([]);
    notifyHomeScopeSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(getHomeScope().selectedHomeId).toBe(MAIN_HOME_ID);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBeNull();
    expect(bar().hidden).toBe(true);
  });

  it('tracks a roster change made while a page without the bar is shown', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    selectHomeScope(AREA_ID);

    // The area is deleted from the Multiple meters panel, where the bar does not
    // render. The roster must still be refetched, or the next hop into a
    // scope-aware page would paint a home that no longer exists.
    state.activePanel = 'homes';
    homey.__uiState.homes = homesPayload([]);
    notifyHomeScopeSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(getHomeScope().selectedHomeId).toBe(MAIN_HOME_ID);
    expect(getHomeScope().areas).toEqual([]);
  });

  it('keeps the last-good roster when the runtime cannot vouch for the config', async () => {
    // `configDegraded` means the served `homes` may be a stale or empty cache
    // while real areas persist; trusting it would delete the user's scope for
    // good, since the stored key goes with it.
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);

    homey.__uiState.homes = { ...homesPayload([]), configDegraded: true };
    await refreshHomeScope();
    await flushAsync();

    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBe(AREA_ID);
  });

  it('keeps the last-good roster when the degradation flag is not a boolean', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);

    // Everything else is well-shaped and the roster is empty, so only the flag
    // stands between this response and the branch that clears the roster and
    // deletes the stored key. An absent flag is the runtime saying nothing.
    homey.__uiState.homes = {
      homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, runtimeActive: true,
    };
    await refreshHomeScope();
    await flushAsync();

    // No string ever equals `true`, so a `=== true` degradation guard lets both
    // `'true'` and `'false'` through and reads the roster as vouched-for.
    homey.__uiState.homes = { ...homesPayload([]), configDegraded: 'false' };
    await refreshHomeScope();
    await flushAsync();

    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
    expect(window.localStorage.getItem(SCOPE_STORAGE_KEY)).toBe(AREA_ID);
  });

  it('keeps the last-good roster when the payload is malformed', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);

    // A structurally successful but junk payload must not admit invalid ids, and
    // a stringy `runtimeActive` must never read as permission to control.
    homey.__uiState.homes = { homes: [{ homeId: 7, name: null }], runtimeActive: 'false' };
    await refreshHomeScope();
    await flushAsync();

    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(getHomeScope().runtimeActive).toBe(true);
    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
  });

  it('keeps the last-good roster when an area id is domain-invalid or duplicated', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);

    // The runtime's normalizer (`isValidSubHomeId` + first-wins de-dup) can
    // never serve these, so each whole roster is junk: an admitted reserved id
    // would double Main in the picker, a `':'` id would write suffixed settings
    // keys no home owns, a dangerous key would collide with Object.prototype in
    // per-home records, and a duplicate makes the picked scope ambiguous.
    const junkRosters = [
      [{ homeId: MAIN_HOME_ID, name: 'Fake main' }],
      [{ homeId: 'h_a:b', name: 'Colon id' }],
      [{ homeId: '__proto__', name: 'Dangerous key' }],
      [{ homeId: 'h_dup', name: 'First' }, { homeId: 'h_dup', name: 'Second' }],
    ];
    for (const homes of junkRosters) {
      homey.__uiState.homes = homesPayload(homes);
      await refreshHomeScope();
      await flushAsync();
      expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
      expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
    }
  });

  it('discards a roster response superseded by a newer refresh', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();

    // Two overlapping reads settle out of order: the stale one must not land.
    const pending: Array<() => void> = [];
    homey.api.mockImplementation((method: string, uri: string, bodyOrCb: unknown, cb?: unknown) => {
      const callback = (typeof bodyOrCb === 'function' ? bodyOrCb : cb) as (
        err: Error | null, value?: unknown,
      ) => void;
      if (method === 'GET' && uri === SETTINGS_UI_HOMES_PATH) {
        const served = homey.__uiState.homes;
        pending.push(() => callback(null, served));
        return;
      }
      callback(null, {});
    });

    homey.__uiState.homes = homesPayload([]);
    const stale = refreshHomeScope();
    homey.__uiState.homes = homesPayload([{ homeId: AREA_ID, name: 'Utleie' }]);
    const fresh = refreshHomeScope();

    // Newest answers first, the superseded one last.
    pending[1]!();
    pending[0]!();
    await Promise.all([stale, fresh]);
    await flushAsync();

    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
  });

  it('keeps the last-good roster and selection when the refetch fails', async () => {
    install([{ homeId: AREA_ID, name: 'Utleie' }]);
    await refreshHomeScope();
    await flushAsync();
    selectHomeScope(AREA_ID);

    homey.api.mockImplementation((method: string, uri: string, bodyOrCb: unknown, cb?: unknown) => {
      const callback = (typeof bodyOrCb === 'function' ? bodyOrCb : cb) as (
        err: Error | null, value?: unknown,
      ) => void;
      if (method === 'GET' && uri === SETTINGS_UI_HOMES_PATH) { callback(new Error('homes fetch failed')); return; }
      callback(null, {});
    });
    await refreshHomeScope();
    await flushAsync();

    // Abandon-grace: a momentary SDK miss must not drop the user's scope.
    expect(getHomeScope().selectedHomeId).toBe(AREA_ID);
    expect(optionHomeIds()).toEqual([MAIN_HOME_ID, AREA_ID]);
  });
});
