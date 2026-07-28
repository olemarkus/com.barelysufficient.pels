import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOME_SCOPE_ACTIVITY_NOT_RECORDED,
  HOME_SCOPE_DIAGNOSTICS_NOT_MEASURED,
  HOME_SCOPE_SIMULATION_MAIN_ONLY_NOTE,
} from '../../shared-domain/src/homeScopeCopy.ts';
import {
  CAPACITY_DRY_RUN,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
} from '../../contracts/src/settingsKeys.ts';
import { createHomeyMock, installHomeyMock } from './helpers/homeyApiMock.ts';

/* -------------------------------------------------------------------------- *
 * Honest not-supported states (multi-home PR 8c, locked decisions 1/4/5).
 *
 * Three surfaces do not follow the shell's home picker and must say so once
 * meter areas are in use, instead of serving Main-home payloads that read as
 * healthy for an area device:
 *
 * - Device-detail DIAGNOSTICS: the payload is Main's diagnostics recorder,
 *   which never sees an area device's plan — "No diagnostics recorded yet"
 *   would read as a device nobody is worried about. The gate renders the
 *   honest copy and skips the fetch the answer cannot come from.
 * - Device-detail ACTIVITY LOG: same recorder ownership, same gate.
 * - The Simulation-mode settings page: it carries only Main's switch, yet the
 *   hub's "Partly on" chip routes there for any split posture — the page
 *   names where each area's own control lives.
 *
 * Every gate has a single-home contrast case proving the pre-multi-home
 * behaviour is byte-identical when no area is in use.
 * -------------------------------------------------------------------------- */

const RENTAL = 'h_11111111';

const HOMES_PAYLOAD = {
  homes: [{
    homeId: RENTAL, name: 'Rental unit', rootZoneId: 'z_rental', meterDeviceId: 'm1',
  }],
  membershipByDeviceId: {
    'dev-rental-heater': { homeId: RENTAL, source: 'zone' },
    'dev-hall-heater': { homeId: 'main', source: 'fallback' },
  },
  zoneTree: null,
  hasSubHomes: true,
  runtimeActive: true,
  configDegraded: false,
};

const flushPromises = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
};

const buildDeviceDetailDom = () => {
  document.body.innerHTML = `
    <details id="device-detail-diagnostics-disclosure">
      <summary>Advanced diagnostics</summary>
      <div id="device-detail-diagnostics-status"></div>
      <div id="device-detail-diagnostics-cards"></div>
    </details>
    <details id="device-detail-activity-log-disclosure">
      <summary>Activity log</summary>
      <div id="device-detail-activity-log-body"></div>
    </details>
  `;
};

/** Wire the mocked client and prime the home-badge membership index. */
const primeMembership = async (homey: ReturnType<typeof createHomeyMock>) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient(homey);
  const { refreshHomeBadges } = await import('../src/ui/homeBadges.ts');
  await refreshHomeBadges();
};

const apiPathsCalled = (homey: ReturnType<typeof createHomeyMock>): string[] => (
  homey.api.mock.calls.map((call) => String(call[1]))
);

describe('device-detail honest states for a meter-area device', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(null);
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('renders "not measured yet" diagnostics for an area device and skips the Main-home fetch', async () => {
    buildDeviceDetailDom();
    const homey = createHomeyMock({ uiState: { homes: HOMES_PAYLOAD } });
    await primeMembership(homey);
    const { refreshDeviceDetailDiagnostics } = await import('../src/ui/deviceDetail/diagnostics.ts');

    await refreshDeviceDetailDiagnostics({ deviceId: 'dev-rental-heater', isCurrentDevice: () => true });

    expect(document.getElementById('device-detail-diagnostics-status')?.textContent)
      .toBe(HOME_SCOPE_DIAGNOSTICS_NOT_MEASURED);
    expect(apiPathsCalled(homey)).not.toContain('/ui_device_diagnostics');
  });

  it('keeps the normal diagnostics read for a Main-home device while areas are in use', async () => {
    buildDeviceDetailDom();
    const homey = createHomeyMock({ uiState: { homes: HOMES_PAYLOAD } });
    await primeMembership(homey);
    const { refreshDeviceDetailDiagnostics } = await import('../src/ui/deviceDetail/diagnostics.ts');

    await refreshDeviceDetailDiagnostics({ deviceId: 'dev-hall-heater', isCurrentDevice: () => true });

    expect(apiPathsCalled(homey)).toContain('/ui_device_diagnostics');
    expect(document.getElementById('device-detail-diagnostics-status')?.textContent)
      .not.toBe(HOME_SCOPE_DIAGNOSTICS_NOT_MEASURED);
  });

  it('renders "not recorded yet" activity for an area device and skips the Main-home fetch', async () => {
    buildDeviceDetailDom();
    const homey = createHomeyMock({ uiState: { homes: HOMES_PAYLOAD } });
    await primeMembership(homey);
    const { refreshDeviceDetailActivityLog } = await import('../src/ui/deviceDetail/activityLog.ts');

    await refreshDeviceDetailActivityLog({ deviceId: 'dev-rental-heater', isCurrentDevice: () => true });

    expect(document.getElementById('device-detail-activity-log-body')?.textContent)
      .toBe(HOME_SCOPE_ACTIVITY_NOT_RECORDED);
    expect(apiPathsCalled(homey)).not.toContain('/ui_device_log');
  });

  it('keeps the normal activity-log read for a Main-home device while areas are in use', async () => {
    buildDeviceDetailDom();
    const homey = createHomeyMock({ uiState: { homes: HOMES_PAYLOAD } });
    await primeMembership(homey);
    const { refreshDeviceDetailActivityLog } = await import('../src/ui/deviceDetail/activityLog.ts');

    await refreshDeviceDetailActivityLog({ deviceId: 'dev-hall-heater', isCurrentDevice: () => true });

    expect(apiPathsCalled(homey)).toContain('/ui_device_log');
    expect(document.getElementById('device-detail-activity-log-body')?.textContent)
      .not.toBe(HOME_SCOPE_ACTIVITY_NOT_RECORDED);
  });

  it('single-home install: no gate — the badge index is empty and the fetch proceeds', async () => {
    buildDeviceDetailDom();
    const homey = createHomeyMock({});
    await primeMembership(homey);
    const { refreshDeviceDetailDiagnostics } = await import('../src/ui/deviceDetail/diagnostics.ts');

    await refreshDeviceDetailDiagnostics({ deviceId: 'dev-rental-heater', isCurrentDevice: () => true });

    expect(apiPathsCalled(homey)).toContain('/ui_device_diagnostics');
  });
});

describe('Simulation-mode page scope note (multi-home honest states)', () => {
  const AREA_FLAG_KEY = `${CAPACITY_DRY_RUN}:${RENTAL}`;
  const ACTIVATED_ROSTER = {
    activationVersion: 1,
    subHomes: [{ homeId: RENTAL, name: 'Rental unit', rootZoneId: 'z_rental' }],
  };

  const buildSimulationDom = () => {
    document.body.innerHTML = `
      <div id="dry-run-banner" hidden><span id="dry-run-banner-text"></span></div>
      <p id="simulation-home-scope-note" hidden></p>
    `;
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(null);
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('un-hides the note naming the per-area control once an active meter area exists', async () => {
    buildSimulationDom();
    const homey = installHomeyMock({
      settings: {
        [HOMES_CONFIG]: ACTIVATED_ROSTER,
        [HOMES_CONFIG_INITIALIZED]: true,
        [AREA_FLAG_KEY]: true,
      },
    });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey as never);
    const { notifyAreaSimulationSettingChanged } = await import('../src/ui/capacity.ts');

    notifyAreaSimulationSettingChanged(HOMES_CONFIG);
    await flushPromises();

    const note = document.getElementById('simulation-home-scope-note');
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toBe(HOME_SCOPE_SIMULATION_MAIN_ONLY_NOTE);
  });

  it('keeps the note hidden on a single-home install', async () => {
    buildSimulationDom();
    const homey = installHomeyMock({ settings: {} });
    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(homey as never);
    const { notifyAreaSimulationSettingChanged } = await import('../src/ui/capacity.ts');

    notifyAreaSimulationSettingChanged(HOMES_CONFIG);
    await flushPromises();

    expect(document.getElementById('simulation-home-scope-note')?.hidden).toBe(true);
  });
});
