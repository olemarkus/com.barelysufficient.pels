// Per-kind section layout: the device page composes by reparenting singleton
// section nodes. These tests assert the visible order per kind, the EV row
// relocations, idempotence, and the bare-page Setup auto-expand.

import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUiApi';

const SECTION_IDS = [
  'device-detail-modes-section',
  'device-detail-delta-section',
  'device-detail-surplus-section',
  'device-detail-shedding-section',
  'device-detail-stepped-section',
  'device-detail-charging-section',
  'device-detail-car-section',
  'device-detail-setup-section',
  'device-detail-smart-task',
  'device-detail-diagnostics-section',
  'device-detail-activity-log-section',
];

const buildDom = () => {
  document.body.innerHTML = `
    <div class="slide-panel__content">
      ${SECTION_IDS.map((id) => `
        <section class="detail-section" id="${id}">
          <details class="settings-collapse" open><summary></summary>
            <div class="collapse-content"></div>
          </details>
        </section>`).join('')}
      <details id="device-detail-setup-disclosure"><summary></summary></details>
    </div>
  `;
  const addRows = (parent: Element, ids: string[]) => ids.forEach((id) => {
    const row = document.createElement('div');
    row.id = id;
    parent.appendChild(row);
  });
  addRows(document.querySelector('#device-detail-shedding-section .collapse-content')!, [
    'device-detail-shed-field',
    'device-detail-overshoot-temp-row',
  ]);
  addRows(document.querySelector('#device-detail-setup-section .collapse-content')!, [
    'device-detail-managed-row',
    'device-detail-temperature-control-disabled-row',
    'device-detail-controllable-row',
    'device-detail-start-policy-row',
    'device-detail-respect-external-off-row',
    'device-detail-price-opt-row',
    'device-detail-surplus-track-row',
    'device-detail-budget-exempt-row',
  ]);
};

const childIds = (sectionId: string): string[] => Array.from(
  document.querySelector(`#${sectionId} .collapse-content`)!.children,
).map((el) => el.id);

const SETUP_ROW_ORDER = [
  'device-detail-managed-row',
  'device-detail-temperature-control-disabled-row',
  'device-detail-controllable-row',
  'device-detail-start-policy-row',
  'device-detail-respect-external-off-row',
  'device-detail-price-opt-row',
  'device-detail-surplus-track-row',
  'device-detail-budget-exempt-row',
];

const buildDevice = (
  overrides: Partial<SettingsUiDeviceSnapshot> = {},
): SettingsUiDeviceSnapshot => (withDescriptorIdentity<SettingsUiDeviceSnapshot>({
  available: true,
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  expectedPowerKw: 1.5, expectedPowerSource: 'default',
  ...overrides,
}));

const sectionOrder = (): string[] => Array.from(
  document.querySelectorAll('.slide-panel__content > section'),
).map((el) => el.id);

const loadLayout = async () => {
  vi.resetModules();
  const { state } = await import('../src/ui/state.ts');
  state.deviceTargetPowerConfigs = {};
  state.deviceControlProfiles = {};
  const module = await import('../src/ui/deviceDetail/sectionLayout.ts');
  return { module, state };
};

beforeEach(() => {
  buildDom();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('applyDeviceDetailSectionLayout', () => {
  it('leads the EV page with Charging, Car and Power limiting, and gathers the limiting rows', async () => {
    const { module, state } = await loadLayout();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 5)).toEqual([
      'device-detail-charging-section',
      'device-detail-car-section',
      'device-detail-shedding-section',
      'device-detail-setup-section',
      'device-detail-stepped-section',
    ]);
    // Power-limit control and its start policy lead what limiting does;
    // "Leave off until turned on again" follows it.
    expect(childIds('device-detail-shedding-section')).toEqual([
      'device-detail-controllable-row',
      'device-detail-start-policy-row',
      'device-detail-shed-field',
      'device-detail-respect-external-off-row',
      'device-detail-overshoot-temp-row',
    ]);
    // Charge on solar surplus is a charging rule.
    expect(childIds('device-detail-charging-section')).toEqual(['device-detail-surplus-track-row']);
    // Activity log reads before advanced diagnostics.
    const order = sectionOrder();
    expect(order.indexOf('device-detail-activity-log-section'))
      .toBeLessThan(order.indexOf('device-detail-diagnostics-section'));
  });

  it('leaves a rendered EV page untouched on a refresh', async () => {
    const { module, state } = await loadLayout();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };
    module.applyDeviceDetailSectionLayout(device);
    const before = childIds('device-detail-shedding-section');

    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    module.applyDeviceDetailSectionLayout(device);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(childIds('device-detail-shedding-section')).toEqual(before);
  });

  it('keeps the temperature page led by per-mode targets with limiting last of the open cards', async () => {
    const { module } = await loadLayout();
    const device = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 5)).toEqual([
      'device-detail-modes-section',
      'device-detail-delta-section',
      'device-detail-surplus-section',
      'device-detail-stepped-section',
      'device-detail-shedding-section',
    ]);
    const field = document.getElementById('device-detail-shed-field');
    expect(field?.closest('#device-detail-shedding-section')).not.toBeNull();
    expect((document.getElementById('device-detail-shedding-section') as HTMLElement).hidden).toBe(false);
  });

  it('leads the stepped page with the profile card', async () => {
    const { module, state } = await loadLayout();
    const device = buildDevice({ deviceClass: 'heater', deviceType: 'onoff' });
    state.deviceControlProfiles = {
      [device.id]: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 3000 }],
      },
    };

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 2)).toEqual([
      'device-detail-stepped-section',
      'device-detail-shedding-section',
    ]);
  });

  it('puts the Smart task box after Setup and before the activity log', async () => {
    const { module } = await loadLayout();
    module.applyDeviceDetailSectionLayout(buildDevice());
    const order = sectionOrder();
    expect(order.indexOf('device-detail-smart-task')).toBe(order.indexOf('device-detail-setup-section') + 1);
    expect(order.indexOf('device-detail-smart-task'))
      .toBeLessThan(order.indexOf('device-detail-activity-log-section'));
  });

  it('re-applies when the resolved kind changes and skips when it does not', async () => {
    const { module, state } = await loadLayout();
    const thermostat = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    module.applyDeviceDetailSectionLayout(thermostat);
    expect(sectionOrder()[0]).toBe('device-detail-modes-section');

    const ev = buildDevice({ id: 'device-2', deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [ev.id]: { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360, step: 460 },
    };
    module.applyDeviceDetailSectionLayout(ev);
    expect(sectionOrder()[0]).toBe('device-detail-charging-section');
  });

  it('returns the limiting and solar rows to Setup on the way back from EV', async () => {
    const { module, state } = await loadLayout();
    const ev = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [ev.id]: { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360, step: 460 },
    };
    module.applyDeviceDetailSectionLayout(ev);

    const thermostat = buildDevice({
      id: 'device-2',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    module.applyDeviceDetailSectionLayout(thermostat);

    expect(childIds('device-detail-setup-section')).toEqual(SETUP_ROW_ORDER);
    expect(childIds('device-detail-shedding-section')).toEqual([
      'device-detail-shed-field',
      'device-detail-overshoot-temp-row',
    ]);
    expect(childIds('device-detail-charging-section')).toEqual([]);
  });

  it('moves the rows with the kind even while focus defers the section reorder', async () => {
    const { module, state } = await loadLayout();
    const thermostat = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    module.applyDeviceDetailSectionLayout(thermostat);

    // Focus inside the panel (the Setup select during a control-model change).
    const input = document.createElement('button');
    document.querySelector('#device-detail-modes-section .collapse-content')?.appendChild(input);
    input.focus();

    const ev = buildDevice({ id: 'device-2', deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [ev.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };
    module.applyDeviceDetailSectionLayout(ev);

    // Reorder deferred (modes still first) but the rows followed the kind.
    expect(sectionOrder()[0]).toBe('device-detail-modes-section');
    expect(document.getElementById('device-detail-controllable-row')
      ?.closest('#device-detail-shedding-section')).not.toBeNull();

    // The deferred reorder lands on the next apply once focus has left.
    input.blur();
    module.applyDeviceDetailSectionLayout(ev);
    expect(sectionOrder()[0]).toBe('device-detail-charging-section');
  });

  it('does not move sections while focus sits inside the panel', async () => {
    const { module } = await loadLayout();
    const input = document.createElement('button');
    document.querySelector('#device-detail-modes-section .collapse-content')?.appendChild(input);
    input.focus();

    module.applyDeviceDetailSectionLayout(buildDevice({ deviceClass: 'socket', deviceType: 'onoff' }));

    // Layout untouched: the original DOM order still stands.
    expect(sectionOrder()[0]).toBe('device-detail-modes-section');
  });
});

describe('autoExpandSetupWhenBare', () => {
  it('expands Setup once for a plain binary device and unmanaged devices', async () => {
    const { module } = await loadLayout();
    const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement;
    disclosure.open = false;
    const socket = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });

    module.autoExpandSetupWhenBare({ deviceId: socket.id, device: socket, isManaged: true });
    expect(disclosure.open).toBe(true);

    // Re-closing sticks: the once-per-device guard stops refresh loops from
    // fighting the user.
    disclosure.open = false;
    module.autoExpandSetupWhenBare({ deviceId: socket.id, device: socket, isManaged: true });
    expect(disclosure.open).toBe(false);
  });

  it('leaves Setup collapsed for a managed temperature device', async () => {
    const { module } = await loadLayout();
    const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement;
    disclosure.open = false;
    const thermostat = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });

    module.autoExpandSetupWhenBare({ deviceId: thermostat.id, device: thermostat, isManaged: true });
    expect(disclosure.open).toBe(false);
  });
});
