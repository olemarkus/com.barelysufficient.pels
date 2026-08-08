// The limiting card renders a statement instead of a radiogroup whenever the
// action resolution leaves nothing to choose (single option, limiting switched
// off, or no power reading at all). These tests drive the real
// setDeviceDetailShedBehavior against stub DOM handles and assert which of the
// two presentations wins and with which sentence.

import type { TargetDeviceSnapshot } from '../../contracts/src/types';

type StubOption = { disabled: boolean; hidden: boolean };

const buildDevice = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  powerKw: 1.5,
  ...overrides,
});

const loadShedStatementHarness = async () => {
  vi.resetModules();

  const options: Record<string, StubOption & { removeAttribute: () => void; setAttribute: () => void }> = {
    turn_off: { disabled: false, hidden: false, removeAttribute: () => {}, setAttribute: () => {} },
    set_temperature: { disabled: false, hidden: false, removeAttribute: () => {}, setAttribute: () => {} },
    set_step: { disabled: false, hidden: false, removeAttribute: () => {}, setAttribute: () => {} },
  };
  const shedAction = {
    value: '',
    disabled: false,
    querySelector: (selector: string) => {
      const match = /value="([^"]+)"/u.exec(selector);
      return match ? options[match[1]] : null;
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
  };
  const statement = { textContent: '', hidden: true };
  const segmented = { hidden: false };
  const segmentedLabel = { hidden: false };
  const hint = { hidden: false };
  const shedTemp = { value: '', disabled: false };
  const shedTempRow = { hidden: true };
  const shedStepRow = { hidden: true };
  const shedStep = { innerHTML: '', disabled: false, addEventListener: () => {} };

  vi.doMock('../src/ui/dom.ts', () => ({
    deviceDetailShedAction: shedAction,
    deviceDetailShedStatement: statement,
    deviceDetailShedSegmented: segmented,
    deviceDetailShedSegmentedLabel: segmentedLabel,
    deviceDetailShedHint: hint,
    deviceDetailShedTemp: shedTemp,
    deviceDetailShedTempRow: shedTempRow,
    deviceDetailShedStep: shedStep,
    deviceDetailShedStepRow: shedStepRow,
  }));
  vi.doMock('../src/ui/homey.ts', () => ({
    getSettingFresh: vi.fn(),
    getSetting: vi.fn().mockResolvedValue({}),
    setSetting: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));
  vi.doMock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined), showToastError: vi.fn() }));

  const module = await import('../src/ui/deviceDetail/shedBehavior.ts');
  const { state } = await import('../src/ui/state.ts');
  state.shedBehaviors = {};
  state.controllableMap = {};
  state.managedMap = {};
  state.temperatureControlDisabledMap = {};
  state.deviceTargetPowerConfigs = {};
  state.deviceControlProfiles = {};

  const render = (device: TargetDeviceSnapshot) => {
    module.setDeviceDetailShedBehavior({
      deviceId: device.id,
      getDeviceById: () => device,
      updateSetStepOptionLabel: () => {},
    });
  };

  return { state, statement, segmented, segmentedLabel, hint, render };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('limiting card statement vs radiogroup', () => {
  it('renders the pause statement for an EV-preset charger', async () => {
    const { state, statement, segmented, hint, render } = await loadShedStatementHarness();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360, step: 460 },
    };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe(
      'When limiting this charger, PELS pauses charging and resumes it when power allows.',
    );
    expect(segmented.hidden).toBe(true);
    expect(hint.hidden).toBe(true);
  });

  it('keeps the radiogroup for a thermostat with a genuine choice', async () => {
    const { state, statement, segmented, hint, render } = await loadShedStatementHarness();
    const device = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };

    render(device);

    expect(statement.hidden).toBe(true);
    expect(segmented.hidden).toBe(false);
    expect(hint.hidden).toBe(false);
  });

  it('states that PELS will not limit when Power-limit control is off', async () => {
    const { state, statement, render } = await loadShedStatementHarness();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: false };
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 22080, step: 1380 },
    };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe('Power-limit control is off — PELS will not limit this charger.');
  });

  it('renders the turn-off statement for a plain binary device', async () => {
    const { state, statement, segmented, render } = await loadShedStatementHarness();
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe(
      'When limiting this device, PELS turns it off and turns it back on when power allows.',
    );
    expect(segmented.hidden).toBe(true);
  });

  it('names disabled temperature control when it forced the single option', async () => {
    const { state, statement, render } = await loadShedStatementHarness();
    const device = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    state.temperatureControlDisabledMap = { [device.id]: true };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe(
      'Temperature control is off for this device. '
      + 'When limiting it, PELS turns it off and turns it back on when power allows.',
    );
  });

  it('states that PELS does not limit a device without power support', async () => {
    const { state, statement, render } = await loadShedStatementHarness();
    const device = buildDevice({
      deviceClass: 'sensor',
      deviceType: 'onoff',
      capabilities: [],
      powerKw: undefined,
    });
    state.managedMap = { [device.id]: true };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe('PELS does not limit this device.');
  });
});
