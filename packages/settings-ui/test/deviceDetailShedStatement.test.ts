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
  available: true,
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  // The producer stamps this for every device it parses; `supportsPowerDevice`
  // reads it and no longer infers power capability from `expectedPowerKw`, which
  // is now present on every snapshot and so says nothing about capability.
  powerCapable: true,
  expectedPowerKw: 1.5, expectedPowerSource: 'default',
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

  return { state, statement, segmented, segmentedLabel, hint, shedAction, options, render };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('limiting card statement vs radiogroup', () => {
  // The preset's amp ladder is exactly what the planner parks at an intermediate
  // charging level, so a bare pause sentence here would contradict the Overview
  // card reading `Limited to 16 A` for the same charger.
  it('renders the lower-the-level statement for an EV-preset charger', async () => {
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
      'When limiting this charger, PELS lowers the charging level, '
      + 'and pauses charging only if lowering is not enough. It resumes when power allows.',
    );
    expect(segmented.hidden).toBe(true);
    expect(hint.hidden).toBe(true);
  });

  // No preset means no charging levels to lower, so pausing really is the whole
  // of it and the older sentence stays true.
  it('keeps the pause statement for a charger with no level preset', async () => {
    const { state, statement, segmented, hint, render } = await loadShedStatementHarness();
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };

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

  // The segmented control must show an action the device actually offers. A
  // saved action whose option is hidden used to be written to `.value` anyway,
  // leaving the control with NEITHER visible option checked while the runtime
  // turned the device off — a state that is neither what is saved nor what
  // happens.
  it('shows turn off for a stepped device whose saved set_temperature option is hidden', async () => {
    const {
      state, statement, segmented, shedAction, options, render,
    } = await loadShedStatementHarness();
    const device = buildDevice({
      deviceClass: 'boiler',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
    });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    // A stepped water heater whose setpoint another Flow owns: the ladder stays,
    // the setpoint arm goes.
    state.deviceControlProfiles = {
      [device.id]: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }] },
    };
    state.temperatureControlDisabledMap = { [device.id]: true };
    state.shedBehaviors = { [device.id]: { action: 'set_temperature', temperature: 45 } };

    render(device);

    // Two real options, so the owner gets the chooser rather than a statement.
    expect(statement.hidden).toBe(true);
    expect(segmented.hidden).toBe(false);
    expect(options.turn_off.hidden).toBe(false);
    expect(options.set_step.hidden).toBe(false);
    expect(options.set_temperature.hidden).toBe(true);
    expect(shedAction.value).toBe('turn_off');
  });

  it('shows turn off for a device whose saved set_step option is hidden', async () => {
    const { state, shedAction, options, render } = await loadShedStatementHarness();
    // The mirror case: a plain binary device carrying a saved step action, e.g.
    // one whose stepped control model was switched back off.
    const device = buildDevice({ deviceClass: 'kettle', deviceType: 'onoff' });
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    state.shedBehaviors = { [device.id]: { action: 'set_step' } };

    render(device);

    expect(options.set_step.hidden).toBe(true);
    expect(shedAction.value).toBe('turn_off');
  });

  it('states that PELS does not limit a device without power support', async () => {
    const { state, statement, render } = await loadShedStatementHarness();
    const device = buildDevice({
      deviceClass: 'sensor',
      deviceType: 'onoff',
      capabilities: [],
      // `powerCapable: false` is the producer's own answer, and the only one that
      // means "no power support" now — `expectedPowerKw` is resolved for every
      // device, so its presence stopped carrying that signal.
      powerCapable: false,
    });
    state.managedMap = { [device.id]: true };

    render(device);

    expect(statement.hidden).toBe(false);
    expect(statement.textContent).toBe('PELS does not limit this device.');
  });
});
