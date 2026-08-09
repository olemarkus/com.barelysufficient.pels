// Per-kind section layout: the device page composes by reparenting singleton
// section nodes. These tests assert the visible order per kind, the EV
// shed-field relocation, idempotence, and the bare-page Setup auto-expand.

import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const SECTION_IDS = [
  'device-detail-modes-section',
  'device-detail-delta-section',
  'device-detail-surplus-section',
  'device-detail-shedding-section',
  'device-detail-stepped-section',
  'device-detail-charging-section',
  'device-detail-car-section',
  'device-detail-setup-section',
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
  const shedContent = document.querySelector('#device-detail-shedding-section .collapse-content')!;
  const field = document.createElement('div');
  field.id = 'device-detail-shed-field';
  shedContent.appendChild(field);
};

const buildDevice = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  expectedPowerKw: 1.5, expectedPowerSource: 'default',
  ...overrides,
});

const sectionOrder = (): string[] => Array.from(
  document.querySelectorAll('.slide-panel__content > section'),
).map((el) => el.id);

const loadLayout = async () => {
  vi.resetModules();
  const { state } = await import('../src/ui/state.ts');
  state.deviceTargetPowerConfigs = {};
  state.deviceControlProfiles = {};
  const module = await import('../src/ui/deviceDetail/sectionLayout.ts');
  module.resetDeviceDetailSectionLayoutForTest();
  return { module, state };
};

beforeEach(() => {
  buildDom();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('applyDeviceDetailSectionLayout', () => {
  it('leads the EV page with Charging and Car and hides the shedding card', async () => {
    const { module, state } = await loadLayout();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 2)).toEqual([
      'device-detail-charging-section',
      'device-detail-car-section',
    ]);
    // The limiting field moves into the Charging card and its own card hides.
    const field = document.getElementById('device-detail-shed-field');
    expect(field?.closest('#device-detail-charging-section')).not.toBeNull();
    expect((document.getElementById('device-detail-shedding-section') as HTMLElement).hidden).toBe(true);
    // Activity log reads before advanced diagnostics.
    const order = sectionOrder();
    expect(order.indexOf('device-detail-activity-log-section'))
      .toBeLessThan(order.indexOf('device-detail-diagnostics-section'));
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
        model: 'stepped_load',
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 3000 }],
      },
    };

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 2)).toEqual([
      'device-detail-stepped-section',
      'device-detail-shedding-section',
    ]);
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

  it('returns the shed field and unhides the limiting card on the way back from EV', async () => {
    const { module, state } = await loadLayout();
    const ev = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [ev.id]: { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360, step: 460 },
    };
    module.applyDeviceDetailSectionLayout(ev);
    expect((document.getElementById('device-detail-shedding-section') as HTMLElement).hidden).toBe(true);

    const thermostat = buildDevice({
      id: 'device-2',
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    module.applyDeviceDetailSectionLayout(thermostat);

    const field = document.getElementById('device-detail-shed-field');
    expect(field?.closest('#device-detail-shedding-section')).not.toBeNull();
    expect((document.getElementById('device-detail-shedding-section') as HTMLElement).hidden).toBe(false);
  });

  it('tracks shed-field placement on a kind change even while focus defers the reorder', async () => {
    const { module, state } = await loadLayout();
    const thermostat = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    module.applyDeviceDetailSectionLayout(thermostat);

    // Focus inside the panel (the Setup select during a control-model change).
    const input = document.createElement('button');
    document.querySelector('#device-detail-setup-section .collapse-content')?.appendChild(input);
    input.focus();

    const ev = buildDevice({ id: 'device-2', deviceClass: 'evcharger', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [ev.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };
    module.applyDeviceDetailSectionLayout(ev);

    // Reorder deferred (modes still first) but the limiting surface followed
    // the kind: field inside the Charging card, its old card hidden.
    expect(sectionOrder()[0]).toBe('device-detail-modes-section');
    const field = document.getElementById('device-detail-shed-field');
    expect(field?.closest('#device-detail-charging-section')).not.toBeNull();
    expect((document.getElementById('device-detail-shedding-section') as HTMLElement).hidden).toBe(true);

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
