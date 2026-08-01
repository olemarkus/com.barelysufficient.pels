import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { notifyAreaSimulationSettingChanged } from '../src/ui/capacity.ts';
import {
  createSettingsSetHandler,
  createSettingsUnsetHandler,
} from '../src/ui/settingsChangeRouter.ts';
import { state, type MeterAreaSimulationEntry } from '../src/ui/state.ts';
import {
  CAPACITY_DRY_RUN,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  PELS_STATUS,
} from '../../contracts/src/settingsKeys.ts';

/* -------------------------------------------------------------------------- *
 * The aggregate simulation posture refresh (multi-home PR 8b review fixes).
 *
 * `state.meterAreaSimulation` backs the global simulation banner and the
 * Settings hub chip. This spec pins the refresh's failure semantics — a
 * transient or malformed per-area flag read (or an unset one with history)
 * keeps the area's last resolved value instead of replacing the snapshot with
 * a confident-but-wrong posture; an unavailable or suspect ROSTER read keeps
 * the whole snapshot (abandon-grace) while a resolved-empty roster clears it;
 * a stale overlapping refresh never overwrites a newer one — and the roster
 * keys' routing into the refresh (`homes_config` set AND unset), so an
 * already-booted WebView tracks area add/remove/rename without a panel visit.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_rental';
const AREA_FLAG_KEY = `${CAPACITY_DRY_RUN}:${AREA_ID}`;
const AREA_STATUS_KEY = `${PELS_STATUS}:${AREA_ID}`;
const ACTIVATED_ROSTER = {
  activationVersion: 1,
  subHomes: [{ homeId: AREA_ID, name: 'Rental unit', rootZoneId: 'z_rental' }],
};

const flushAsync = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
};

describe('meter-area simulation posture refresh', () => {
  let homey: MockHomeyClient;
  let priorEntries: MeterAreaSimulationEntry[];
  let priorDryRun: boolean;

  const setup = (settings: Record<string, unknown>) => {
    homey = installHomeyMock({ settings });
    setHomeyClient(homey as never);
  };

  beforeEach(() => {
    priorEntries = state.meterAreaSimulation;
    priorDryRun = state.dryRun;
    state.meterAreaSimulation = [];
  });

  afterEach(() => {
    // Also clears the module-level settings cache between tests.
    setHomeyClient(null);
    state.meterAreaSimulation = priorEntries;
    state.dryRun = priorDryRun;
  });

  it('keeps the last resolved snapshot when an area flag read fails', async () => {
    // Main is live; the area was resolved simulating earlier this session.
    // A transient read failure must not drop the area (the posture would
    // flip to all-live and hide the one warning naming it).
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });
    homey.get.mockImplementation((key: string, cb: (err: Error | null, value?: unknown) => void) => {
      if (key === AREA_FLAG_KEY) {
        cb(new Error('transient settings read failure'));
        return;
      }
      const store = homey.__settingsStore;
      cb(null, Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null);
    });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: true }];

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('keeps the last resolved value for a malformed persisted flag', async () => {
    // The runtime store keeps its last-good dryRun for a non-boolean value —
    // the UI must not announce a simulation the runtime is not doing.
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
      [AREA_FLAG_KEY]: 'yes',
    });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: false }];

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: false },
    ]);
  });

  it('keeps the roster snapshot when the homes_config read fails', async () => {
    // A transiently rejecting roster read must not resolve to "no areas" and
    // wipe every last-good entry — with Main live that would hide the one
    // banner naming the simulating area until another refresh (abandon-grace,
    // `notes/persisted-settings-state.md`).
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });
    homey.get.mockImplementation((key: string, cb: (err: Error | null, value?: unknown) => void) => {
      if (key === HOMES_CONFIG) {
        cb(new Error('transient settings read failure'));
        return;
      }
      const store = homey.__settingsStore;
      cb(null, Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null);
    });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: true }];

    notifyAreaSimulationSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('keeps the roster snapshot for a suspect persisted roster blob', async () => {
    // One meter shared across two areas: the runtime's store classifies that
    // blob suspect wholesale (`hasUniqueSubHomeMeters`) and keeps its prior
    // bundles — the UI mirror must retain its snapshot the same way, not
    // clear it as a resolved-empty roster.
    setup({
      [HOMES_CONFIG]: {
        activationVersion: 1,
        subHomes: [
          { homeId: AREA_ID, name: 'Rental unit', rootZoneId: 'z_rental', meterDeviceId: 'dev_shared' },
          { homeId: 'h_cabin', name: 'Cabin', rootZoneId: 'z_cabin', meterDeviceId: 'dev_shared' },
        ],
      },
      [HOMES_CONFIG_INITIALIZED]: true,
    });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: true }];

    notifyAreaSimulationSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('keeps the last resolved value when an area flag is unset', async () => {
    // Unsetting the suffixed flag leaves the RUNTIME on its last-good dryRun
    // (`setup/capacitySettingsStoreAdapter.ts` resolves every non-boolean to
    // the fallback bundle) — the UI must not repaint an already-live area
    // with the boot default and announce a simulation the runtime isn't
    // doing.
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: false }];

    createSettingsUnsetHandler()(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: false },
    ]);
  });

  it('carries an explicit unknown for a malformed flag with nothing last-good', async () => {
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
      [AREA_FLAG_KEY]: 'yes',
    });

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: null },
    ]);
  });

  it('reads a live area from the runtime posture when the reloaded WebView has no history', async () => {
    // The capacity bundle does not restart with the WebView: an area switched
    // live before its flag was unset stays live in the runtime, which says so
    // in its own `pels_status:<id>` blob. Without that read a fresh WebView
    // would repaint the area with the boot default and claim a simulation
    // nobody is running.
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
      [AREA_STATUS_KEY]: { limitReason: 'none', devicesOff: 0, dryRunEffective: false },
    });

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: false },
    ]);
  });

  it('resolves a genuinely unset flag to the simulating boot default', async () => {
    // Absent, with no runtime posture published either = never written = the
    // runtime's dry-run-TRUE boot default.
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('never lets a stale refresh overwrite a newer one', async () => {
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });
    const pendingFlagReads: Array<(err: Error | null, value?: unknown) => void> = [];
    homey.get.mockImplementation((key: string, cb: (err: Error | null, value?: unknown) => void) => {
      if (key === AREA_FLAG_KEY) {
        pendingFlagReads.push(cb);
        return;
      }
      const store = homey.__settingsStore;
      cb(null, Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null);
    });

    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();
    notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();
    expect(pendingFlagReads).toHaveLength(2);

    // The NEWER refresh resolves first: the area went live.
    pendingFlagReads[1](null, false);
    await flushAsync();
    // The OLDER refresh finishes last carrying the pre-change flag; without
    // the generation fence it would overwrite the newer answer indefinitely.
    pendingFlagReads[0](null, true);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: false },
    ]);
  });

  it('surfaces a newly added default-simulating area on a homes_config set', async () => {
    // A booted WebView with no areas gains one from another surface. Its flag
    // is unwritten (boot-default simulating) — the posture must pick it up
    // without a Limits/Simulation panel visit.
    setup({
      [HOMES_CONFIG]: ACTIVATED_ROSTER,
      [HOMES_CONFIG_INITIALIZED]: true,
    });

    createSettingsSetHandler()(HOMES_CONFIG);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('keeps the snapshot when a homes_config unset still carries the marker', async () => {
    // The unset route has no capacity-panel loader behind it — the posture
    // refresh is its only path to re-reading the roster. But a SET
    // written-before marker contradicts the missing blob (the runtime store's
    // own `'suspect'`), so this must not read as a vouched empty roster and
    // wipe the entry naming the simulating area.
    setup({ [HOMES_CONFIG_INITIALIZED]: true });
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: true }];

    createSettingsUnsetHandler()(HOMES_CONFIG);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
  });

  it('drops a removed roster from the posture when the marker is gone too', async () => {
    // Blob and marker both absent is the vouched never-written state, so the
    // refresh legitimately narrows the stale snapshot to no areas.
    setup({});
    state.meterAreaSimulation = [{ homeId: AREA_ID, name: 'Rental unit', simulating: true }];

    createSettingsUnsetHandler()(HOMES_CONFIG);
    await flushAsync();

    expect(state.meterAreaSimulation).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * The banner's own SCOPE claim, on the rendered element. `hasMeterAreas` is
 * module state, so this reloads the capacity module against a DOM carrying the
 * banner — the only way to catch the refresh handing the banner a claim that
 * contradicts the snapshot it just retained.
 * -------------------------------------------------------------------------- */

describe('simulation banner scope across a suspect roster read', () => {
  const BANNER_TEMPLATE = [
    '<div id="dry-run-banner" hidden></div>',
    '<span id="dry-run-banner-text"></span>',
  ].join('');

  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  it('keeps naming the simulating area when the roster turns suspect-empty', async () => {
    // Static template built from a literal — no untrusted content.
    document.body.innerHTML = BANNER_TEMPLATE;
    vi.resetModules();
    const homeyModule = await import('../src/ui/homey.ts');
    const client = installHomeyMock({
      settings: {
        [HOMES_CONFIG]: ACTIVATED_ROSTER,
        [HOMES_CONFIG_INITIALIZED]: true,
        [AREA_FLAG_KEY]: true,
      },
    });
    homeyModule.setHomeyClient(client as never);
    const capacity = await import('../src/ui/capacity.ts');
    const uiState = await import('../src/ui/state.ts');
    uiState.state.dryRun = false; // Main is live; only the area simulates.
    const banner = document.querySelector('#dry-run-banner') as HTMLElement;

    capacity.notifyAreaSimulationSettingChanged(AREA_FLAG_KEY);
    await flushAsync();
    expect(banner.hidden).toBe(false);
    expect(banner.dataset.homeScope).toBe('areas');

    // The saved roster is rewritten into a blob nobody can vouch for whose
    // `subHomes` happens to be empty. The snapshot survives (abandon-grace),
    // so the scope claim behind the banner must survive with it — reading it
    // as a vouched empty roster would hide the only warning naming the area.
    client.__settingsStore[HOMES_CONFIG] = { activationVersion: 2, subHomes: [] };
    homeyModule.invalidateSettingCache(HOMES_CONFIG);

    capacity.notifyAreaSimulationSettingChanged(HOMES_CONFIG);
    await flushAsync();

    expect(uiState.state.meterAreaSimulation).toEqual([
      { homeId: AREA_ID, name: 'Rental unit', simulating: true },
    ]);
    expect(banner.hidden).toBe(false);
    expect(banner.dataset.homeScope).toBe('areas');
  });
});
