import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { HOMES_CONFIG } from '../../contracts/src/settingsKeys.ts';
import { SETTINGS_UI_HOMES_PATH } from '../../contracts/src/settingsUiHomes.ts';
import {
  notifyHomeLimitsSettingChanged,
  refreshHomeLimitsOnLimitsPanel,
} from '../src/ui/homeLimits.ts';
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
 * Per-home Limits controller: the switcher list, the static-form visibility
 * toggle, and — the core contract — that a meter area's edits hit the SUFFIXED
 * scalar keys (`capacity_*:<homeId>`) while the Main home keeps the bare keys
 * (its untouched static form). Status reads come from `pels_status:<homeId>`.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_abc';

const flushAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const homesPayload = () => ({
  homes: [{ homeId: AREA_ID, name: 'Utleie', rootZoneId: 'z1', meterDeviceId: 'dev_a' }],
  membershipByDeviceId: {},
  zoneTree: null,
  hasSubHomes: true,
  configDegraded: false,
});

const setupDom = () => {
  document.body.innerHTML = '<div id="home-limits-mount"></div>'
    + '<form id="settings-limits-form"></form>';
};

const select = () => document.querySelector<HTMLSelectElement>('#home-limits-home-select');
const staticForm = () => document.querySelector<HTMLFormElement>('#settings-limits-form');

const selectArea = async (homeId: string) => {
  const el = select()!;
  el.value = homeId;
  el.dispatchEvent(new Event('change'));
  await flushAsync();
};

let homey: MockHomeyClient;

const install = (settings: Record<string, unknown> = {}) => {
  homey = installHomeyMock({ settings, uiState: { homes: homesPayload() } });
  setHomeyClient(homey as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  setupDom();
  state.activePanel = 'limits';
});

afterEach(() => {
  setHomeyClient(null);
  document.body.innerHTML = '';
});

describe('switcher + static-form visibility', () => {
  it('shows the switcher (Main + area) and keeps the static form for the Main home', async () => {
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(select()).not.toBeNull();
    expect([...select()!.options].map((option) => option.value)).toEqual(['main', AREA_ID]);
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

  it('falls back to Main-only when there are no meter areas', async () => {
    homey = installHomeyMock({ uiState: { homes: { homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, configDegraded: false } } });
    setHomeyClient(homey as never);
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(select()).toBeNull();
    expect(staticForm()!.hidden).toBe(false);
  });

  it('keeps the mount hidden with 0 meter areas, un-hides it when one exists', async () => {
    // Layout byte-identity: an empty mount that stays a grid child adds a stray
    // gap before Main's form. It must be display:none until a meter area exists.
    const noAreas = installHomeyMock({ uiState: { homes: { homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, configDegraded: false } } });
    setHomeyClient(noAreas as never);
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect(document.querySelector<HTMLElement>('#home-limits-mount')!.hidden).toBe(true);

    setHomeyClient(null);
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
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
  it('a rejected scalar read leaves the switcher-only degraded state + toasts the error', async () => {
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

    // Degraded state: no editor rendered, switcher still present, error toasted.
    expect(document.querySelector('#home-limits-hard-cap')).toBeNull();
    expect(select()).not.toBeNull();
    expect(showToastError).toHaveBeenCalled();
  });
});

describe('transient refresh error keeps the last-good roster (abandon-grace)', () => {
  it('a failed ui_homes refetch retains the existing areas instead of blanking the switcher', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect([...select()!.options].map((option) => option.value)).toEqual(['main', AREA_ID]);

    // The next roster refetch fails transiently.
    homey.api.mockImplementation((method: string, uri: string, bodyOrCb: unknown, cb?: unknown) => {
      const callback = (typeof bodyOrCb === 'function' ? bodyOrCb : cb) as (err: Error | null, value?: unknown) => void;
      if (method === 'GET' && uri === SETTINGS_UI_HOMES_PATH) { callback(new Error('homes fetch failed')); return; }
      callback(null, {});
    });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();

    // Roster + switcher retained (not blanked to Main-only).
    expect(select()).not.toBeNull();
    expect([...select()!.options].map((option) => option.value)).toEqual(['main', AREA_ID]);
  });
});

describe('homes_config change refreshes the switcher roster', () => {
  const AREA_TWO = 'h_two';
  const twoAreaHomes = () => ({
    homes: [
      { homeId: AREA_ID, name: 'Utleie', rootZoneId: 'z1', meterDeviceId: 'dev_a' },
      { homeId: AREA_TWO, name: 'Hytta', rootZoneId: 'z2', meterDeviceId: 'dev_b' },
    ],
    membershipByDeviceId: {},
    zoneTree: null,
    hasSubHomes: true,
    configDegraded: false,
  });
  const emptyHomes = () => ({
    homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, configDegraded: false,
  });

  it('adds a newly-created area to the switcher on a homes_config change', async () => {
    install();
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    expect([...select()!.options].map((option) => option.value)).toEqual(['main', AREA_ID]);

    // A second area is added elsewhere; the roster blob change fires.
    homey.__uiState.homes = twoAreaHomes();
    notifyHomeLimitsSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect([...select()!.options].map((option) => option.value)).toEqual(['main', AREA_ID, AREA_TWO]);
  });

  it('falls back to Main when the selected area is deleted via homes_config', async () => {
    install({ [`capacity_limit_kw:${AREA_ID}`]: 7, [`capacity_margin_kw:${AREA_ID}`]: 0.3, [`capacity_dry_run:${AREA_ID}`]: true });
    await refreshHomeLimitsOnLimitsPanel();
    await flushAsync();
    await selectArea(AREA_ID);
    expect(staticForm()!.hidden).toBe(true);

    // The selected area is removed elsewhere.
    homey.__uiState.homes = emptyHomes();
    notifyHomeLimitsSettingChanged(HOMES_CONFIG);
    await flushAsync();

    // Switcher gone (0 areas) and the Main static form is restored.
    expect(select()).toBeNull();
    expect(staticForm()!.hidden).toBe(false);
  });
});
