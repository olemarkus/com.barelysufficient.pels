// The second limit — "Limited temperature when cooling" — exists only for a
// device that reports its own heating/cooling mode. These tests drive the real
// editor against stub DOM handles and assert the row shows for exactly that
// device, and that what it persists is the owner's pair.

import type { TargetDeviceSnapshot } from '../../contracts/src/types';

type StubOption = { disabled: boolean; hidden: boolean; removeAttribute: () => void; setAttribute: () => void };

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
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
});

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
  const shedTemp = { value: '', label: '', disabled: false, ...listening('temp') };
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
    getSettingFresh: vi.fn().mockResolvedValue({}),
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

  const show = (device: TargetDeviceSnapshot) => {
    state.managedMap = { [device.id]: true };
    state.controllableMap = { [device.id]: true };
    module.setDeviceDetailShedBehavior({ deviceId: device.id, getDeviceById: () => device, updateSetStepOptionLabel: () => {} });
    module.updateShedFieldVisibility({ currentDetailDeviceId: device.id, getDeviceById: () => device });
  };

  const changeCoolingLimit = async (value: string, device: TargetDeviceSnapshot) => {
    module.initDeviceDetailShedHandlers({ getCurrentDetailDeviceId: () => device.id, getDeviceById: () => device });
    shedCoolingTemp.value = value;
    await listeners['cooling:change']?.();
  };

  return {
    state, shedTemp, shedTempRow, shedTempHint, shedCoolingTemp, shedCoolingTempRow, shedCoolingTempHint,
    setSetting, show, changeCoolingLimit,
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
