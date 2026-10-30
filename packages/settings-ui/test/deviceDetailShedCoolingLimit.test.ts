// The second limit — "Limited temperature when cooling" — exists only for a
// device that reports its own heating/cooling mode. These tests drive the real
// editor against stub DOM handles and assert the row shows for exactly that
// device, and that what it persists is the owner's pair.

import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';

type StubOption = { disabled: boolean; hidden: boolean; removeAttribute: () => void; setAttribute: () => void };

const buildDevice = (overrides: Partial<SettingsUiDeviceSnapshot> = {}): SettingsUiDeviceSnapshot => (withDescriptorIdentity<SettingsUiDeviceSnapshot>({
  available: true,
  id: 'device-1',
  name: 'Device',
  deviceClass: 'thermostat',
  deviceType: 'temperature',
  targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff', 'measure_temperature', 'target_temperature'],
  powerCapable: true,
  expectedPowerKw: 1.5, expectedPowerSource: 'default',
  ...overrides,
}));

const loadHarness = async () => {
  vi.resetModules();
  const option = (): StubOption => ({ disabled: false, hidden: false, removeAttribute: () => {}, setAttribute: () => {} });
  const options: Record<string, StubOption> = { turn_off: option(), set_temperature: option(), set_step: option() };
  const shedAction = {
    value: 'set_temperature',
    disabled: false,
    querySelector: (selector: string) => {
      const match = /value="([^"]+)"/u.exec(selector);
      return match ? options[match[1]] : null;
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
  };
  // The editor auto-saves from the fields' `change` listeners; the stubs record
  // them so a test can fire the real save path rather than a private function.
  const listeners: Record<string, () => Promise<void> | void> = {};
  const listening = (name: string) => ({
    addEventListener: (type: string, fn: () => Promise<void> | void) => { listeners[`${name}:${type}`] = fn; },
  });
  const shedTemp = { value: '', label: '', disabled: false, validity: { badInput: false }, reportValidity: vi.fn(), ...listening('temp') };
  const shedTempRow = { hidden: true };
  const shedTempHint = { textContent: '' };
  const shedCoolingTemp = { value: '', disabled: false, ...listening('cooling') };
  const shedCoolingTempRow = { hidden: true };
  const shedCoolingTempHint = { textContent: '' };
  const shedStep = { innerHTML: '', disabled: false, addEventListener: () => {} };
  const setSetting = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../src/ui/dom.ts', () => ({
    deviceDetailShedAction: shedAction,
    deviceDetailShedStatement: { textContent: '', hidden: true },
    deviceDetailShedSegmented: { hidden: false },
    deviceDetailShedSegmentedLabel: { hidden: false },
    deviceDetailShedHint: { hidden: false },
    deviceDetailShedTemp: shedTemp,
    deviceDetailShedTempRow: shedTempRow,
    deviceDetailShedTempHint: shedTempHint,
    deviceDetailShedCoolingTemp: shedCoolingTemp,
    deviceDetailShedCoolingTempRow: shedCoolingTempRow,
    deviceDetailShedCoolingTempHint: shedCoolingTempHint,
    deviceDetailShedStep: shedStep,
    deviceDetailShedStepRow: { hidden: true },
  }));
  vi.doMock('../src/ui/homey.ts', () => ({
    getSettingFresh: vi.fn(async () => state.shedBehaviors),
    getSetting: vi.fn().mockResolvedValue({}),
    setSetting,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));
  vi.doMock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined), showToastError: vi.fn() }));

  const module = await import('../src/ui/deviceDetail/shedBehavior.ts');
  const { state } = await import('../src/ui/state.ts');
  state.shedBehaviors = {};
  state.controllableMap = {};
  state.managedMap = {};
  state.temperatureControlDisabledMap = {};
  state.temperatureControlModes = {};
  state.deviceTargetPowerConfigs = {};
  state.deviceControlProfiles = {};

  const show = (device: SettingsUiDeviceSnapshot) => {
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    module.setDeviceDetailShedBehavior(device.id, device, () => {});
    module.updateShedFieldVisibility(device);
  };

  const changeCoolingLimit = async (value: string, device: SettingsUiDeviceSnapshot) => {
    // The save reads the open device from the device list, as on the real page.
    state.latestDevices = [device];
    module.initDeviceDetailShedHandlers({ getCurrentDetailDeviceId: () => device.id });
    shedCoolingTemp.value = value;
    await listeners['cooling:change']?.();
  };

  const changeHeatingLimit = async (value: string, device: SettingsUiDeviceSnapshot) => {
    state.latestDevices = [device];
    module.initDeviceDetailShedHandlers({ getCurrentDetailDeviceId: () => device.id });
    shedTemp.value = value;
    await listeners['temp:change']?.();
  };

  return {
    state, shedTemp, shedTempRow, shedTempHint, shedCoolingTemp, shedCoolingTempRow, shedCoolingTempHint,
    setSetting, show, changeCoolingLimit, changeHeatingLimit,
  };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('limited temperature when cooling', () => {
  it('shows the cooling limit only for a device that reports a heating/cooling mode', async () => {
    const { state, shedTempRow, shedCoolingTempRow, show } = await loadHarness();
    state.shedBehaviors = { 'device-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 } };

    show(buildDevice());
    expect(shedTempRow.hidden).toBe(false);
    expect(shedCoolingTempRow.hidden).toBe(true);

    show(buildDevice({
      deviceClass: 'heatpump',
      capabilities: ['measure_power', 'onoff', 'measure_temperature', 'target_temperature', 'thermostat_mode'],
    }));
    expect(shedTempRow.hidden).toBe(false);
    expect(shedCoolingTempRow.hidden).toBe(false);
  });

  it('words both limits for a reversible unit, and starts the cooling limit at the default', async () => {
    const { state, shedTemp, shedTempHint, shedCoolingTemp, shedCoolingTempHint, show } = await loadHarness();
    state.shedBehaviors = { 'device-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 } };

    // A plain heater: one limit, the familiar label.
    show(buildDevice());
    expect(shedTemp.label).toBe('Limited temperature');

    // A reversible unit: both fields name their direction, and an entry saved
    // before the cooling limit existed shows the default rather than nothing.
    show(buildDevice({
      deviceClass: 'heatpump',
      capabilities: ['measure_power', 'onoff', 'measure_temperature', 'target_temperature', 'thermostat_mode'],
    }));
    expect(shedTemp.label).toBe('Limited temperature when heating');
    expect(shedTempHint.textContent).toContain('While heating');
    expect(shedCoolingTempHint.textContent).toContain('While cooling, PELS raises');
    expect(shedCoolingTemp.value).toBe('28');
  });

  it('populates the cooling limit from the saved pair and persists both back', async () => {
    const { state, shedTemp, shedCoolingTemp, setSetting, show, changeCoolingLimit } = await loadHarness();
    const device = buildDevice({
      id: 'hp',
      deviceClass: 'heatpump',
      capabilities: ['measure_power', 'onoff', 'measure_temperature', 'target_temperature', 'thermostat_mode'],
    });
    state.shedBehaviors = { hp: { action: 'set_temperature', temperature: 16, coolingTemperature: 27 } };

    show(device);
    expect(shedTemp.value).toBe('16');
    expect(shedCoolingTemp.value).toBe('27');

    await changeCoolingLimit('28', device);
    expect(setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      hp: { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
    });
  });

  it('never reads the hidden cooling field for a device that cannot say it is cooling', async () => {
    const { state, setSetting, show, changeCoolingLimit } = await loadHarness();
    const device = buildDevice({ id: 'heater' });
    state.shedBehaviors = { heater: { action: 'set_temperature', temperature: 16, coolingTemperature: 28 } };

    show(device);
    // A stray value in the hidden field is not the owner's choice; the entry
    // carries the default instead, which a heater never reads.
    await changeCoolingLimit('27', device);
    expect(setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      heater: { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
    });
  });
});

const setpointOnlyDevice = () => buildDevice({
  targets: [{ id: 'target_temperature', value: 70, unit: '°C', min: 20, max: 85 }],
  binaryControl: undefined,
  capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
});

describe('limited temperature for a device with no on/off', () => {
  it('starts the field at the device minimum without saving it', async () => {
    const { state, shedTemp, shedTempHint, setSetting, show } = await loadHarness();
    const device = setpointOnlyDevice();
    // The mode temperature plays no part: the limit is the device's minimum.
    state.modeTargets = { [state.activeMode]: { 'device-1': 70 } };
    show(device);
    expect(shedTemp.value).toBe('20');
    expect(shedTempHint.textContent).toBe('PELS lowers the target to this while it limits the device. '
      + 'Keep it below each mode\'s temperature, or PELS cannot limit the device in that mode.');
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('starts at PELS\'s fallback when the device reports no minimum', async () => {
    const { shedTemp, show } = await loadHarness();
    show({ ...setpointOnlyDevice(), targets: [{ id: 'target_temperature', value: 70, unit: '°C' }] });
    expect(shedTemp.value).toBe('10');
  });

  it('saves a raised limit as a number, and an emptied field goes back to the device minimum', async () => {
    const { state, shedTemp, show, changeHeatingLimit } = await loadHarness();
    const device = setpointOnlyDevice();
    state.shedBehaviors = { other: { action: 'turn_off' } };
    show(device);
    await changeHeatingLimit('25', device);
    expect(state.shedBehaviors).toEqual({
      other: { action: 'turn_off' },
      [device.id]: { action: 'set_temperature', temperature: 25, coolingTemperature: 28 },
    });
    await changeHeatingLimit('', device);
    expect(state.shedBehaviors[device.id]).toEqual({ action: 'set_temperature', temperature: 20, coolingTemperature: 28 });
    expect(shedTemp.value).toBe('20');
  });

  it('saves the device minimum as the heating limit when only the cooling limit changes', async () => {
    const { state, shedTemp, show, changeCoolingLimit } = await loadHarness();
    const device = setpointOnlyDevice();
    device.capabilities?.push('thermostat_mode');
    show(device);
    expect(shedTemp.value).toBe('20');
    await changeCoolingLimit('26', device);
    expect(state.shedBehaviors[device.id]).toEqual({ action: 'set_temperature', temperature: 20, coolingTemperature: 26 });
  });

  it('does not mistake a partial number for a cleared field', async () => {
    const { state, shedTemp, setSetting, show, changeHeatingLimit } = await loadHarness();
    const device = setpointOnlyDevice();
    state.shedBehaviors = { [device.id]: { action: 'set_temperature', temperature: 55, coolingTemperature: 28 } };
    show(device);
    // A number field reads empty while it holds '-'.
    shedTemp.validity.badInput = true;
    await changeHeatingLimit('', device);
    expect(setSetting).not.toHaveBeenCalled();
    expect(shedTemp.reportValidity).toHaveBeenCalled();
    expect(state.shedBehaviors[device.id]).toMatchObject({ temperature: 55 });
  });

  it('keeps a newer limit visible when an earlier save fails', async () => {
    const { state, shedTemp, setSetting, show, changeHeatingLimit } = await loadHarness();
    const device = setpointOnlyDevice();
    state.shedBehaviors = { [device.id]: { action: 'set_temperature', temperature: 25, coolingTemperature: 28 } };
    show(device);
    let failWrite: (error: Error) => void = () => { throw new Error('Write has not started'); };
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    setSetting.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failWrite = reject;
      markStarted();
    }));
    const firstSave = changeHeatingLimit('30', device);
    await started;
    const secondSave = changeHeatingLimit('35', device);
    failWrite(new Error('earlier write failed'));
    await Promise.all([firstSave, secondSave]);
    expect(state.shedBehaviors[device.id]).toMatchObject({ temperature: 35 });
    expect(shedTemp.value).toBe('35');
  });

  it('restores the saved limit if a save fails', async () => {
    const { state, shedTemp, setSetting, show, changeHeatingLimit } = await loadHarness();
    const device = setpointOnlyDevice();
    state.shedBehaviors = { [device.id]: { action: 'set_temperature', temperature: 25, coolingTemperature: 28 } };
    show(device);
    setSetting.mockRejectedValueOnce(new Error('write failed'));
    await changeHeatingLimit('30', device);
    expect(shedTemp.value).toBe('25');
    expect(state.shedBehaviors[device.id]).toMatchObject({ temperature: 25 });
  });
});
