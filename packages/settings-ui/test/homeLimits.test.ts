import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { HOMES_CONFIG, MAIN_HOME_ID } from '../../contracts/src/settingsKeys.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes.ts';
import {
  notifyHomeLimitsSettingChanged,
  refreshHomeLimitsOnLimitsPanel,
} from '../src/ui/homeLimits.ts';
import { notifyHomeScopeSettingChanged, selectHomeScope } from '../src/ui/homeScope.ts';
import { showToastError } from '../src/ui/toast.ts';
import { state } from '../src/ui/state.ts';

// The toast + log seams reach real DOM/SDK; stub them (the homey get/set + api
// mock stays real so the suffixed-key write assertions are genuine).
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

/* -------------------------------------------------------------------------- *
 * Per-home Limits controller: how it follows the shell's global scope bar, the
 * static-form visibility toggle, and — the core contract — that a meter area's
 * edits hit the SUFFIXED scalar keys (`capacity_*:<homeId>`) while the Main
 * home keeps the bare keys (its untouched static form). Status reads come from
 * `pels_status:<homeId>`. The scope bar is driven through its real DOM select,
 * exactly as a user drives it.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_abc';

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const homesPayload = (runtimeActive = true) => ({
  homes: [{ homeId: AREA_ID, name: 'Utleie', rootZoneId: 'z1', meterDeviceId: 'dev_a' }],
  membershipByDeviceId: {},
  zoneTree: null,
  hasSubHomes: true,
  runtimeActive,
  configDegraded: false,
});

const MAIN_HINT_AT_INSTALL = 'Your grid tariff step (effekttrinn) — '
  + 'PELS keeps each hour’s average power under this.';

const setupDom = () => {
  document.body.innerHTML = '<div id="home-scope-bar" hidden></div>'
    + '<h2 id="limits-title">Limits &amp; safety</h2>'
    + '<div id="home-limits-mount"></div>'
    + '<form id="settings-limits-form">'
    + `<small id="settings-capacity-limit-hint">${MAIN_HINT_AT_INSTALL}</small>`
    + '</form>'
    + '<div id="settings-limits-global"></div>';
};

const chip = () => document.querySelector<HTMLElement>('#home-scope-chip');
// The menu is mounted only while open, so read the roster through an open/close
// cycle — the same way it is actually reachable to a user.
const toggleMenu = () => chip()!.dispatchEvent(new Event('click', { bubbles: true }));
const optionLabels = () => {
  toggleMenu();
  const labels = [...document.querySelectorAll('md-menu-item')].map((item) => item.textContent);
  toggleMenu();
  return labels;
};
const staticForm = () => document.querySelector<HTMLFormElement>('#settings-limits-form');
const panelTitle = () => document.querySelector<HTMLElement>('#limits-title')!;
const globalCard = () => document.querySelector<HTMLElement>('#settings-limits-global')!;
const mainCapHint = () => document.querySelector<HTMLElement>('#settings-capacity-limit-hint')!;

// Drive the shell's scope chip the way a user does: open it, tap a home.
const selectArea = async (homeId: string) => {
  toggleMenu();
  document.querySelector<HTMLElement>(`#home-scope-option-${homeId}`)!
    .dispatchEvent(new Event('click', { bubbles: true }));
  await flushAsync();
};

let homey: MockHomeyClient;

const install = (settings: Record<string, unknown> = {}, runtimeActive = true) => {
  homey = installHomeyMock({ settings, uiState: { homes: homesPayload(runtimeActive) } });
  setHomeyClient(homey as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  setupDom();
  state.activePanel = 'limits';
  // The scope bar is module state shared by the whole WebView, so a case that
  // left an area selected must not leak into the next one.
  selectHomeScope(MAIN_HOME_ID);
});

afterEach(() => {
  setHomeyClient(null);
  document.body.innerHTML = '';
});

describe('scope bar + static-form visibility', () => {
  it('offers Main + each area in the scope bar and keeps the static form for Main', async () => {
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(chip()).not.toBeNull();
    expect(optionLabels()).toEqual(['Main home', 'Utleie']);
    // Main selected by default ⇒ the static Main-home form stays visible.
    expect(staticForm()!.hidden).toBe(false);
  });

  it('hides the static form and shows the per-home editor for a meter area', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    expect(staticForm()!.hidden).toBe(true);
    expect(document.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('7');
    // A meter area defaults to simulation ⇒ activation notice is present.
    expect(document.querySelector('#home-limits-sim-notice')).not.toBeNull();
    // Returning to the Main home restores the static form.
    await selectArea('main');
    expect(staticForm()!.hidden).toBe(false);
    expect(document.querySelector('#home-limits-hard-cap')).toBeNull();
  });

  it('clears an off-panel area editor synchronously before refreshing a new scope', async () => {
    install({
      [`capacity_limit_kw:${AREA_ID}`]: 7,
      [`capacity_margin_kw:${AREA_ID}`]: 0.3,
      [`capacity_dry_run:${AREA_ID}`]: true,
    });
    await refreshHomeLimitsOnLimitsPanel();
    await selectArea(AREA_ID);
    expect(document.querySelector('#home-limits-hard-cap')).not.toBeNull();

    state.activePanel = 'overview';
    selectHomeScope(MAIN_HOME_ID);
    // Off-panel scope notifications intentionally retain the editor until the
    // next activation, so it is still present before that hook starts.
    expect(document.querySelector('#home-limits-hard-cap')).not.toBeNull();

    state.activePanel = 'limits';
    const refresh = refreshHomeLimitsOnLimitsPanel();

    expect(document.querySelector('#home-limits-hard-cap')).toBeNull();
    expect(staticForm()!.hidden).toBe(false);
    await refresh;
  });

  it('falls back to safe defaults when persisted area limits are non-finite', async () => {
    install({
      [`capacity_limit_kw:${AREA_ID}`]: Number.NaN,
      [`capacity_margin_kw:${AREA_ID}`]: Number.POSITIVE_INFINITY,
      [`capacity_dry_run:${AREA_ID}`]: true,
    });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    expect(document.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('10');
    expect(document.querySelector<HTMLInputElement>('#home-limits-margin')?.value).toBe('0.2');
  });

  it('falls back to Main-only when there are no meter areas', async () => {
    homey = installHomeyMock({
      uiState: {
        homes: {
          homes: [],
          membershipByDeviceId: {},
          zoneTree: null,
          hasSubHomes: false,
          runtimeActive: true,
          configDegraded: false,
        },
      },
    });
    setHomeyClient(homey as never);
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(chip()).toBeNull();
    expect(staticForm()!.hidden).toBe(false);
  });

  it('names the area on the status card and lifts global settings out of its claim', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();

    // Main scope with areas present: base title, the app-global card visible,
    // and the Main hard-cap hint naming its home ("your" would now be a claim
    // over the whole house from one home among several).
    expect(panelTitle().textContent).toBe('Limits & safety');
    expect(globalCard().hidden).toBe(false);
    expect(mainCapHint().textContent).toContain('The Main home’s grid tariff step');

    await selectArea(AREA_ID);
    // Area scope: the title carries the area (survives scrolling, a persisted
    // scope, and the simulation notice disappearing once control is on), the
    // status card names it too, and the app-global settings step out from under
    // the scope claim leaving an account of where they went.
    // The sticky bar names the home at every scroll position, so the panel title
    // never restates it — that put an untruncated name above a truncated copy.
    expect(panelTitle().textContent).toBe('Limits & safety');
    expect(document.querySelector('#home-limits-status')?.textContent)
      .toContain('Status now · Utleie');
    expect(globalCard().hidden).toBe(true);
    // The two settings are described separately: only Power source is app-wide,
    // while the whole-home meter is the Main home's OWN meter — calling both
    // "for the whole home" invites an aggregate that counts the meter areas.
    expect(document.querySelector('#home-limits-global-note')?.textContent)
      .toContain('the whole-home meter is the Main home’s own meter');
  });

  it('leaves the Main hard-cap hint alone for a home with no meter areas', async () => {
    homey = installHomeyMock({
      uiState: {
        homes: {
          homes: [],
          membershipByDeviceId: {},
          zoneTree: null,
          hasSubHomes: false,
          runtimeActive: true,
          configDegraded: false,
        },
      },
    });
    setHomeyClient(homey as never);
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(mainCapHint().textContent).toBe(MAIN_HINT_AT_INSTALL);
    expect(panelTitle().textContent).toBe('Limits & safety');
    expect(globalCard().hidden).toBe(false);
  });

  it('keeps the mount hidden until a meter area is the selected scope', async () => {
    // Layout identity: an empty mount that stays a grid child adds a stray gap
    // before Main's form. It must be display:none while Main is the scope —
    // which is every moment of a single-meter home's life.
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(document.querySelector<HTMLElement>('#home-limits-mount')!.hidden).toBe(true);

    await selectArea(AREA_ID);
    expect(document.querySelector<HTMLElement>('#home-limits-mount')!.hidden).toBe(false);
  });

});

describe('control toggle — optimistic rollback + serialization', () => {
  const seedSimulatingArea = async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
  };

  const controlSwitch = () => document.querySelector('#home-limits-simulation-switch') as HTMLElement & { selected: boolean };

  it('does not claim or persist control for a legacy-held meter area', async () => {
    const dryRunKey = `capacity_dry_run:${AREA_ID}`;
    install({
      [`capacity_limit_kw:${AREA_ID}`]: 7,
      [`capacity_margin_kw:${AREA_ID}`]: 0.3,
      [dryRunKey]: false,
      [`pels_status:${AREA_ID}`]: {
        controlledKw: 2.5,
        uncontrolledKw: 1.5,
        powerKnown: true,
        hasLivePowerSample: true,
        devicesOff: 0,
        limitReason: 'none',
      },
    }, false);
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    const sw = controlSwitch();
    expect(sw.selected).toBe(false);
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('#home-limits-status-chip')?.textContent).toBe('Not active');
    expect(document.querySelector('#home-limits-status-power')?.textContent).toBe('—');
    expect(document.querySelector('#home-limits-inactive-notice')?.textContent)
      .toContain('open Multiple meters and save this area');

    sw.selected = true;
    sw.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(homey.set.mock.calls.some(([key]: unknown[]) => key === dryRunKey)).toBe(false);
  });

  it('rolls the toggle + posture back to the persisted value when the write is rejected', async () => {
    await seedSimulatingArea();
    const dryRunKey = `capacity_dry_run:${AREA_ID}`;
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === dryRunKey) { cb?.(new Error('persist failed')); return; }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });

    const sw = controlSwitch();
    sw.selected = true; // try to activate control
    sw.dispatchEvent(new Event('change'));
    await flushAsync();

    // The write was attempted, then rolled back to simulating (dry-run true).
    expect(homey.set.mock.calls.some(([key]: unknown[]) => key === dryRunKey)).toBe(true);
    const rolledBack = controlSwitch();
    expect(rolledBack.selected).toBeFalsy(); // back OFF (control not enabled)
    expect(rolledBack.hasAttribute('disabled')).toBe(false); // no longer busy
    // The activation notice is back because posture rolled back to simulating.
    expect(document.querySelector('#home-limits-sim-notice')).not.toBeNull();
  });

  it('serialises writes — a second toggle mid-flight is prevented, not lost or duplicated', async () => {
    await seedSimulatingArea();
    const dryRunKey = `capacity_dry_run:${AREA_ID}`;
    let pendingCb: ((err: Error | null) => void) | null = null;
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === dryRunKey) { homey.__settingsStore[key] = value; pendingCb = cb ?? null; return; }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });

    // Write 1: activate control. It stays pending (callback held).
    const sw = controlSwitch();
    sw.selected = true;
    sw.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(controlSwitch().hasAttribute('disabled')).toBe(true);
    expect(homey.set.mock.calls.filter(([k]: unknown[]) => k === dryRunKey).length).toBe(1);

    // A second change arriving while write 1 is in flight is dropped by the
    // in-flight guard (a real disabled switch can't be re-toggled by the user,
    // so its value is unchanged; the guard is the logic backstop).
    controlSwitch().dispatchEvent(new Event('change'));
    await flushAsync();
    expect(homey.set.mock.calls.filter(([k]: unknown[]) => k === dryRunKey).length).toBe(1);

    // Resolve write 1: control settles ON, toggle re-enabled, notice cleared,
    // and the first write is NOT lost — the persisted value is its intent.
    pendingCb?.(null);
    await flushAsync();
    const settled = controlSwitch();
    expect(settled.hasAttribute('disabled')).toBe(false);
    expect(settled.selected).toBe(true);
    expect(document.querySelector('#home-limits-sim-notice')).toBeNull();
    expect(homey.__settingsStore[dryRunKey]).toBe(false);
  });
});

describe('per-home writes hit the suffixed keys', () => {
  it('writes capacity_limit_kw:<homeId> / capacity_margin_kw:<homeId> on a cap edit', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    const capInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    capInput.value = '9';
    capInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();

    const setCalls = homey.set.mock.calls.map((call) => [call[0], call[1]]);
    expect(setCalls).toContainEqual([`capacity_limit_kw:${AREA_ID}`, 9]);
    // The Main-home bare key is never written by this controller.
    expect(setCalls.some(([key]) => key === 'capacity_limit_kw')).toBe(false);
  });

  it('serialises overlapping cap edits and persists the latest intent', async () => {
    const capKey = `capacity_limit_kw:${AREA_ID}`;
    install({ [capKey]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    const pendingCapWrites: Array<{
      value: unknown;
      complete: () => void;
    }> = [];
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === capKey) {
        pendingCapWrites.push({
          value,
          complete: () => {
            homey.__settingsStore[key] = value;
            cb?.(null);
          },
        });
        return;
      }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });

    const firstInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    firstInput.value = '9';
    firstInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9]);

    const latestInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    latestInput.value = '6';
    latestInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();
    // The newer write stays queued until the older callback settles.
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9]);

    pendingCapWrites[0]!.complete();
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9, 6]);

    pendingCapWrites[1]!.complete();
    await flushAsync();
    expect(homey.__settingsStore[capKey]).toBe(6);
    expect(document.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('6');

    // The latest successful completion updated the persisted fingerprint, so a
    // same-value change does not enqueue a third write.
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(pendingCapWrites).toHaveLength(2);
  });

  it('tracks per-field success before applying a queued revert', async () => {
    const capKey = `capacity_limit_kw:${AREA_ID}`;
    const marginKey = `capacity_margin_kw:${AREA_ID}`;
    install({ [capKey]: 7, [marginKey]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    const pendingWrites: Array<{
      key: string;
      value: unknown;
      succeed: () => void;
      fail: () => void;
    }> = [];
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      pendingWrites.push({
        key,
        value,
        succeed: () => {
          homey.__settingsStore[key] = value;
          cb?.(null);
        },
        fail: () => { cb?.(new Error('write failed')); },
      });
    });

    const capInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    capInput.value = '9';
    capInput.dispatchEvent(new Event('input'));
    const marginInput = document.querySelector<HTMLInputElement>('#home-limits-margin')!;
    marginInput.value = '0.5';
    marginInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-margin')!.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(pendingWrites.map(({ key, value }) => [key, value])).toEqual([
      [capKey, 9],
      [marginKey, 0.5],
    ]);

    const revertedCap = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    revertedCap.value = '7';
    revertedCap.dispatchEvent(new Event('input'));
    const revertedMargin = document.querySelector<HTMLInputElement>('#home-limits-margin')!;
    revertedMargin.value = '0.3';
    revertedMargin.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-margin')!.dispatchEvent(new Event('change'));
    await flushAsync();

    pendingWrites[0]!.succeed();
    await flushAsync();
    // The chain waits for the older intent's margin callback too.
    expect(pendingWrites).toHaveLength(2);

    pendingWrites[1]!.fail();
    await flushAsync();
    // Cap 9 succeeded, so the queued revert must write 7. Margin 0.5 failed,
    // so its persisted fingerprint remains the original 0.3 and needs no write.
    expect(pendingWrites.map(({ key, value }) => [key, value])).toEqual([
      [capKey, 9],
      [marginKey, 0.5],
      [capKey, 7],
    ]);

    pendingWrites[2]!.succeed();
    await flushAsync();
    expect(homey.__settingsStore[capKey]).toBe(7);
    expect(homey.__settingsStore[marginKey]).toBe(0.3);
  });

  it('drains a queued cap edit after the user switches away from the area', async () => {
    const capKey = `capacity_limit_kw:${AREA_ID}`;
    install({ [capKey]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    const pendingCapWrites: Array<{
      value: unknown;
      complete: () => void;
    }> = [];
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === capKey) {
        pendingCapWrites.push({
          value,
          complete: () => {
            homey.__settingsStore[key] = value;
            cb?.(null);
          },
        });
        return;
      }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });

    const firstInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    firstInput.value = '9';
    firstInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();

    const latestInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    latestInput.value = '6';
    latestInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9]);

    await selectArea(MAIN_HOME_ID);
    expect(document.querySelector('#home-limits-hard-cap')).toBeNull();

    pendingCapWrites[0]!.complete();
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9, 6]);

    pendingCapWrites[1]!.complete();
    await flushAsync();
    expect(homey.__settingsStore[capKey]).toBe(6);
  });

  it('preserves per-home intent order across a realtime editor replacement', async () => {
    const capKey = `capacity_limit_kw:${AREA_ID}`;
    install({ [capKey]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    const pendingCapWrites: Array<{
      value: unknown;
      complete: () => void;
    }> = [];
    homey.set.mockImplementation((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === capKey) {
        pendingCapWrites.push({
          value,
          complete: () => {
            homey.__settingsStore[key] = value;
            cb?.(null);
          },
        });
        return;
      }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });

    const firstInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    firstInput.value = '9';
    firstInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();

    const queuedInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    queuedInput.value = '6';
    queuedInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();

    // A same-home realtime read replaces the editor with the still-persisted
    // value while 9 → 6 remains queued on this area's write chain.
    notifyHomeLimitsSettingChanged(capKey);
    await flushAsync();
    expect(document.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('7');

    const newestInput = document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!;
    newestInput.value = '5';
    newestInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-hard-cap')!.dispatchEvent(new Event('change'));
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9]);

    pendingCapWrites[0]!.complete();
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9, 6]);

    pendingCapWrites[1]!.complete();
    await flushAsync();
    expect(pendingCapWrites.map((write) => write.value)).toEqual([9, 6, 5]);

    pendingCapWrites[2]!.complete();
    await flushAsync();
    expect(homey.__settingsStore[capKey]).toBe(5);
    expect(document.querySelector<HTMLInputElement>('#home-limits-hard-cap')?.value).toBe('5');
  });

  it('writes capacity_dry_run:<homeId> = false when control is turned ON (activation)', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    // The area ships simulating (dry-run true) ⇒ the positive toggle starts OFF;
    // turning it ON activates control and persists dry-run FALSE.
    const sw = document.querySelector('#home-limits-simulation-switch') as HTMLElement & { selected: boolean };
    expect(sw.hasAttribute('selected')).toBe(false);
    sw.selected = true;
    sw.dispatchEvent(new Event('change'));
    await flushAsync();

    const setCalls = homey.set.mock.calls.map((call) => [call[0], call[1]]);
    expect(setCalls).toContainEqual([`capacity_dry_run:${AREA_ID}`, false]);
    // The activation notice clears once control is on.
    expect(document.querySelector('#home-limits-sim-notice')).toBeNull();
  });

  it('rejects a margin ≥ cap without writing', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: false });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    const marginInput = document.querySelector<HTMLInputElement>('#home-limits-margin')!;
    marginInput.value = '9';
    marginInput.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('#home-limits-margin')!.dispatchEvent(new Event('change'));
    await flushAsync();

    expect(document.querySelector('#home-limits-margin-alert')).not.toBeNull();
    const setCalls = homey.set.mock.calls.map((call) => call[0]);
    expect(setCalls).not.toContain(`capacity_margin_kw:${AREA_ID}`);
  });
});

describe('status card from pels_status:<homeId>', () => {
  it('renders power now + posture from the suffixed status blob', async () => {
    install({
      [`capacity_limit_kw:${AREA_ID}`]: 8,
      [`capacity_margin_kw:${AREA_ID}`]: 0.3,
      [`capacity_dry_run:${AREA_ID}`]: false,
      [`pels_status:${AREA_ID}`]: {
        controlledKw: 2.5, uncontrolledKw: 1.5, powerKnown: true, hasLivePowerSample: true, devicesOff: 0, limitReason: 'none',
      },
    });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);

    expect(document.querySelector('#home-limits-status-power')?.textContent).toBe('4.0 kW');
    expect(document.querySelector('#home-limits-status-cap')?.textContent).toBe('8.0 kW');
    expect(document.querySelector('#home-limits-status-chip')?.textContent).toBe('Active');
  });

  it('re-reads status on a realtime pels_status:<homeId> change', async () => {
    install({
      [`capacity_limit_kw:${AREA_ID}`]: 8,
      [`capacity_margin_kw:${AREA_ID}`]: 0.3,
      [`capacity_dry_run:${AREA_ID}`]: false,
      [`pels_status:${AREA_ID}`]: { powerKnown: false, hasLivePowerSample: false, devicesOff: 0, limitReason: 'none' },
    });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    expect(document.querySelector('#home-limits-status-power')?.textContent).toBe('—');

    // Runtime writes a fresh live status; the realtime hook re-reads it.
    homey.__settingsStore[`pels_status:${AREA_ID}`] = {
      controlledKw: 3, uncontrolledKw: 0.5, powerKnown: true, hasLivePowerSample: true, devicesOff: 2, limitReason: 'hourly',
    };
    notifyHomeLimitsSettingChanged(`pels_status:${AREA_ID}`);
    await flushAsync();
    expect(document.querySelector('#home-limits-status-power')?.textContent).toBe('3.5 kW');
    expect(document.querySelector('#home-limits-status-line')?.textContent).toBe('Limiting 2 devices to stay under the cap.');
  });
});

describe('load failure surfaces an error, never an unhandled rejection', () => {
  it('a rejected scalar read leaves the scope-bar-only degraded state + toasts the error', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    // The selected area's scalar read now rejects (a transient SDK failure).
    homey.get.mockImplementation((key: string, cb: (err: Error | null, value?: unknown) => void) => {
      if (key === `capacity_limit_kw:${AREA_ID}`) { cb(new Error('read failed')); return; }
      cb(null, homey.__settingsStore[key] ?? null);
    });

    // The discarded load must not throw unhandled — the guard catches it.
    await selectArea(AREA_ID);

    // Degraded state: no editor rendered, the scope bar still there, error toasted.
    expect(document.querySelector('#home-limits-hard-cap')).toBeNull();
    expect(chip()).not.toBeNull();
    expect(showToastError).toHaveBeenCalled();
  });
});

describe('transient refresh error keeps the last-good roster (abandon-grace)', () => {
  it('a failed ui_homes refetch retains the existing areas instead of blanking the bar', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(optionLabels()).toEqual(['Main home', 'Utleie']);

    // The next roster refetch fails transiently.
    homey.api.mockImplementation((method: string, uri: string, bodyOrCb: unknown, cb?: unknown) => {
      const callback = (typeof bodyOrCb === 'function' ? bodyOrCb : cb) as (err: Error | null, value?: unknown) => void;
      if (method === 'GET' && uri === SETTINGS_UI_HOMES_PATH) { callback(new Error('homes fetch failed')); return; }
      callback(null, {});
    });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();

    // Roster + bar retained (not blanked to Main-only).
    expect(chip()).not.toBeNull();
    expect(optionLabels()).toEqual(['Main home', 'Utleie']);
  });
});

describe('homes_config change refreshes the scope roster', () => {
  const AREA_TWO = 'h_two';
  const twoAreaHomes = () => ({
    homes: [
      { homeId: AREA_ID, name: 'Utleie', rootZoneId: 'z1', meterDeviceId: 'dev_a' },
      { homeId: AREA_TWO, name: 'Hytta', rootZoneId: 'z2', meterDeviceId: 'dev_b' },
    ],
    membershipByDeviceId: {},
    zoneTree: null,
    hasSubHomes: true,
    runtimeActive: true,
    configDegraded: false,
  });
  const emptyHomes = () => ({
    homes: [],
    membershipByDeviceId: {},
    zoneTree: null,
    hasSubHomes: false,
    runtimeActive: true,
    configDegraded: false,
  });

  it('adds a newly-created area to the scope bar on a homes_config change', async () => {
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(optionLabels()).toEqual(['Main home', 'Utleie']);

    // A second area is added elsewhere; the roster blob change fires.
    homey.__uiState.homes = twoAreaHomes();
    notifyHomeScopeSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(optionLabels()).toEqual(['Main home', 'Utleie', 'Hytta']);
  });

  it('renames the open editor when the selected area is renamed', async () => {
    // The area name is the one editor field sourced from the roster rather than
    // a suffixed key, so a rename must reach the notice below — otherwise the
    // scope bar and the notice would name two different homes.
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    expect(document.querySelector('#home-limits-sim-notice')?.textContent).toContain('Utleie');

    homey.__uiState.homes = {
      ...homesPayload(),
      homes: [{
        homeId: AREA_ID, name: 'Kjellerleilighet', rootZoneId: 'z1', meterDeviceId: 'dev_a',
      }],
    };
    notifyHomeScopeSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(optionLabels()).toEqual(['Main home', 'Kjellerleilighet']);
    expect(document.querySelector('#home-limits-sim-notice')?.textContent)
      .toContain('Kjellerleilighet');
  });

  it('falls back to Main when the selected area is deleted via homes_config', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    expect(staticForm()!.hidden).toBe(true);

    // The selected area is removed elsewhere.
    homey.__uiState.homes = emptyHomes();
    notifyHomeScopeSettingChanged(HOMES_CONFIG);
    await flushAsync();

    // Scope bar gone (0 areas) and the Main static form is restored.
    expect(chip()).toBeNull();
    expect(staticForm()!.hidden).toBe(false);
  });
});
