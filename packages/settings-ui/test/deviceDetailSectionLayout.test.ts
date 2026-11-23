// Per-kind section layout: the device page composes by reparenting singleton
// section nodes. These tests assert the visible order per kind, the EV row
// relocations, idempotence, and the unmanaged-page Setup auto-expand.

import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';

const SURPLUS_ROW_ORDER = [
  'device-detail-surplus-opt-row',
  'device-detail-dump-load-row',
  'device-detail-surplus-track-row',
  'device-detail-solar-charging-setup',
  'device-detail-solar-pending-hint',
];

const SHEDDING_ROW_ORDER = [
  'device-detail-controllable-row',
  'device-detail-start-policy-row',
  'device-detail-shed-field',
  'device-detail-overshoot-temp-row',
  'device-detail-overshoot-step-row',
  'device-detail-respect-external-off-row',
];

const SETUP_ROW_ORDER = [
  'device-detail-managed-row',
  'device-detail-budget-exempt-row',
];

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
  'device-detail-power-setup',
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
  // As in index.html: each switch heads the card it governs.
  addRows(document.querySelector('#device-detail-modes-section .collapse-content')!, [
    'device-detail-temperature-control-disabled-row',
  ]);
  addRows(document.querySelector('#device-detail-delta-section .collapse-content')!, [
    'device-detail-price-opt-row',
  ]);
  addRows(document.querySelector('#device-detail-surplus-section .collapse-content')!, SURPLUS_ROW_ORDER);
  addRows(document.querySelector('#device-detail-shedding-section .collapse-content')!, SHEDDING_ROW_ORDER);
  addRows(document.querySelector('#device-detail-setup-section .collapse-content')!, SETUP_ROW_ORDER);
};

const childIds = (sectionId: string): string[] => Array.from(
  document.querySelector(`#${sectionId} .collapse-content`)!.children,
).map((el) => el.id);


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
    // "Leave off until turned on again" closes the card, after the limited
    // step that belongs to the limiting choice.
    expect(childIds('device-detail-shedding-section')).toEqual([
      'device-detail-controllable-row',
      'device-detail-start-policy-row',
      'device-detail-shed-field',
      'device-detail-overshoot-temp-row',
      'device-detail-overshoot-step-row',
      'device-detail-respect-external-off-row',
    ]);
    // Charge on solar surplus is a charging rule, and the note that stands in
    // for it while solar is on its way goes with it: the charger's page places
    // no Solar surplus card.
    expect(childIds('device-detail-charging-section')).toEqual([
      'device-detail-surplus-track-row',
      'device-detail-solar-charging-setup',
      'device-detail-solar-pending-hint',
    ]);
    expect(childIds('device-detail-surplus-section')).toEqual([
      'device-detail-surplus-opt-row',
      'device-detail-dump-load-row',
    ]);
    // Activity log, then the rarely needed External sensors, then advanced diagnostics.
    const order = sectionOrder();
    expect(order.indexOf('device-detail-activity-log-section'))
      .toBeLessThan(order.indexOf('device-detail-power-setup'));
    expect(order.indexOf('device-detail-power-setup') + 1).toBe(order.indexOf('device-detail-diagnostics-section'));
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
    const { module } = await loadLayout();
    const device = buildDevice({
      deviceClass: 'heater',
      deviceType: 'onoff',
      steppedLoadProfile: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 3000 }],
      },
    });

    module.applyDeviceDetailSectionLayout(device);

    expect(sectionOrder().slice(0, 3)).toEqual([
      'device-detail-stepped-section',
      'device-detail-shedding-section',
      'device-detail-surplus-section',
    ]);
  });

  it('keeps every switch of a temperature page in the card it governs', async () => {
    const { module } = await loadLayout();
    module.applyDeviceDetailSectionLayout(buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    }));

    expect(childIds('device-detail-modes-section')).toEqual(['device-detail-temperature-control-disabled-row']);
    expect(childIds('device-detail-delta-section')).toEqual(['device-detail-price-opt-row']);
    expect(childIds('device-detail-surplus-section')).toEqual(SURPLUS_ROW_ORDER);
    expect(childIds('device-detail-shedding-section')).toEqual(SHEDDING_ROW_ORDER);
    expect(childIds('device-detail-setup-section')).toEqual(SETUP_ROW_ORDER);
  });

  it('puts the activity log right after Setup', async () => {
    const { module } = await loadLayout();
    module.applyDeviceDetailSectionLayout(buildDevice());
    const order = sectionOrder();
    expect(order.indexOf('device-detail-activity-log-section')).toBe(order.indexOf('device-detail-setup-section') + 1);
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

  it('returns Charge on solar surplus to the Solar surplus card on the way back from EV', async () => {
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

    expect(childIds('device-detail-surplus-section')).toEqual(SURPLUS_ROW_ORDER);
    expect(childIds('device-detail-shedding-section')).toEqual(SHEDDING_ROW_ORDER);
    expect(childIds('device-detail-setup-section')).toEqual(SETUP_ROW_ORDER);
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

describe('autoExpandSetupWhenUnmanaged', () => {
  it('expands Setup once for an unmanaged device', async () => {
    const { module } = await loadLayout();
    const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement;
    disclosure.open = false;

    module.autoExpandSetupWhenUnmanaged({ deviceId: 'device-1', isManaged: false });
    expect(disclosure.open).toBe(true);

    // Re-closing sticks: the once-per-device guard stops refresh loops from
    // fighting the user.
    disclosure.open = false;
    module.autoExpandSetupWhenUnmanaged({ deviceId: 'device-1', isManaged: false });
    expect(disclosure.open).toBe(false);
  });

  it('leaves Setup collapsed for a managed device, whose switches sit in their own cards', async () => {
    const { module } = await loadLayout();
    const disclosure = document.getElementById('device-detail-setup-disclosure') as HTMLDetailsElement;
    disclosure.open = false;

    module.autoExpandSetupWhenUnmanaged({ deviceId: 'device-1', isManaged: true });
    expect(disclosure.open).toBe(false);
  });
});

describe('electrical connection row placement', () => {
  it('moves into the battery page control settings and back', async () => {
    buildDom();
    const list = document.createElement('div');
    list.id = 'device-detail-battery-list';
    document.body.appendChild(list);
    const row = document.createElement('div');
    row.id = 'device-detail-electrical-connection-row';
    document.querySelector('#device-detail-shedding-section .collapse-content')!.appendChild(row);
    const { applyDeviceDetailSectionLayout } = await import('../src/ui/deviceDetail/sectionLayout.ts');
    applyDeviceDetailSectionLayout(withDescriptorIdentity({ id: 'b', deviceClass: 'battery' } as never) as never);
    expect(row.parentElement?.id).toBe('device-detail-battery-list');
    applyDeviceDetailSectionLayout(withDescriptorIdentity({ id: 'h', deviceClass: 'heater' } as never) as never);
    expect(row.parentElement?.closest('section')?.id).toBe('device-detail-shedding-section');
  });
});
