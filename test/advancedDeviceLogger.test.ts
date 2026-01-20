const setupDom = () => {
  document.body.innerHTML = `
    <select id="advanced-device-select"></select>
    <button id="advanced-device-clear"></button>
    <button id="advanced-device-clear-unknown"></button>
    <select id="advanced-api-device-select"></select>
    <button id="advanced-api-device-refresh"></button>
    <button id="advanced-api-device-log"></button>
  `;
};

const flushPromises = async () => new Promise((resolve) => setTimeout(resolve, 0));

jest.mock('../settings/src/ui/homey', () => ({
  callApi: jest.fn(),
  setSetting: jest.fn(),
}));

jest.mock('../settings/src/ui/devices', () => ({
  renderDevices: jest.fn(),
}));

jest.mock('../settings/src/ui/modes', () => ({
  renderPriorities: jest.fn(),
}));

jest.mock('../settings/src/ui/priceOptimization', () => ({
  renderPriceOptimization: jest.fn(),
}));

jest.mock('../settings/src/ui/toast', () => ({
  showToast: jest.fn().mockResolvedValue(undefined),
  showToastError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../settings/src/ui/logging', () => ({
  logSettingsError: jest.fn().mockResolvedValue(undefined),
}));

const getMocks = () => ({
  homey: jest.requireMock('../settings/src/ui/homey') as {
    callApi: jest.Mock;
    setSetting: jest.Mock;
  },
  toast: jest.requireMock('../settings/src/ui/toast') as {
    showToast: jest.Mock;
    showToastError: jest.Mock;
  },
});

describe('advanced device logger', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupDom();
  });

  it('loads Homey devices into the logger select', async () => {
    const { homey, toast } = getMocks();
    homey.callApi.mockResolvedValue([
      { id: 'dev-1', name: 'Pump', class: 'pump' },
    ]);

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    await advanced.refreshAdvancedDeviceLogger();

    const select = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;
    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;

    expect(homey.callApi).toHaveBeenCalledWith('GET', '/homey_devices');
    expect(select.options.length).toBe(2);
    expect(select.options[1].value).toBe('dev-1');
    expect(select.options[1].textContent).toContain('Pump');
    expect(logButton.disabled).toBe(false);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('warns when no device is selected', async () => {
    const { homey, toast } = getMocks();
    homey.callApi.mockResolvedValue([{ id: 'dev-1', name: 'Pump' }]);

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceLoggerHandlers();
    await advanced.refreshAdvancedDeviceLogger();

    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;
    logButton.click();
    await flushPromises();

    expect(toast.showToast).toHaveBeenCalledWith('Select a device first.', 'warn');
    expect(homey.callApi).not.toHaveBeenCalledWith('POST', '/log_homey_device', expect.anything());
  });

  it('warns when device is missing from cache', async () => {
    const { homey, toast } = getMocks();
    homey.callApi.mockResolvedValue([{ id: 'dev-1', name: 'Pump' }]);

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceLoggerHandlers();
    await advanced.refreshAdvancedDeviceLogger();

    const select = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;
    const staleOption = document.createElement('option');
    staleOption.value = 'dev-2';
    staleOption.textContent = 'Stale device';
    select.appendChild(staleOption);
    select.value = 'dev-2';

    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;
    logButton.click();
    await flushPromises();

    expect(toast.showToast).toHaveBeenCalledWith('Device not found. Refresh the list and try again.', 'warn');
  });

  it('logs the selected Homey device', async () => {
    const { homey, toast } = getMocks();
    homey.callApi.mockImplementation((method: string) => {
      if (method === 'GET') {
        return Promise.resolve([{ id: 'dev-1', name: 'Pump' }]);
      }
      if (method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceLoggerHandlers();
    await advanced.refreshAdvancedDeviceLogger();

    const select = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;
    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;
    select.value = 'dev-1';

    logButton.click();
    await flushPromises();

    expect(homey.callApi).toHaveBeenCalledWith('POST', '/log_homey_device', { id: 'dev-1' });
    expect(toast.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Device payload written to logs'),
      'ok',
    );
  });

  it('shows an error when the API call fails', async () => {
    const { homey, toast } = getMocks();
    homey.callApi.mockImplementation((method: string) => {
      if (method === 'GET') {
        return Promise.resolve([{ id: 'dev-1', name: 'Pump' }]);
      }
      if (method === 'POST') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(null);
    });

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceLoggerHandlers();
    await advanced.refreshAdvancedDeviceLogger();

    const select = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;
    select.value = 'dev-1';
    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;
    logButton.click();
    await flushPromises();

    expect(toast.showToastError).toHaveBeenCalled();
  });
});

describe('advanced device cleanup', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupDom();
  });

  const seedState = () => {
    const { state } = require('../settings/src/ui/state') as typeof import('../settings/src/ui/state');
    state.latestDevices = [
      { id: 'dev-1', name: 'Device One' } as typeof state.latestDevices[number],
    ];
    state.controllableMap = { 'dev-1': true, 'dev-2': true };
    state.managedMap = { 'dev-1': true, 'dev-2': true };
    state.shedBehaviors = { 'dev-1': { action: 'turn_off' }, 'dev-2': { action: 'turn_off' } };
    state.priceOptimizationSettings = { 'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 } };
    state.capacityPriorities = { Home: { 'dev-1': 1, 'dev-2': 2 } };
    state.modeTargets = { Home: { 'dev-1': 21, 'dev-2': 19 } };
    return state;
  };

  it('clears selected device settings after confirmation', async () => {
    const { homey } = getMocks();
    seedState();

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceCleanupHandlers();
    advanced.refreshAdvancedDeviceCleanup();

    const select = document.querySelector('#advanced-device-select') as HTMLSelectElement;
    const clearButton = document.querySelector('#advanced-device-clear') as HTMLButtonElement;
    select.value = 'dev-1';

    clearButton.click();
    await flushPromises();
    expect(clearButton.classList.contains('confirming')).toBe(true);

    clearButton.click();
    await flushPromises();

    expect(homey.setSetting).toHaveBeenCalledWith('controllable_devices', { 'dev-2': true });
    expect(homey.setSetting).toHaveBeenCalledWith('managed_devices', { 'dev-2': true });
    expect(homey.setSetting).toHaveBeenCalledWith('overshoot_behaviors', { 'dev-2': { action: 'turn_off' } });
  });

  it('clears unknown devices after confirmation', async () => {
    const { homey } = getMocks();
    seedState();

    const advanced = require('../settings/src/ui/advanced') as typeof import('../settings/src/ui/advanced');
    advanced.initAdvancedDeviceCleanupHandlers();
    advanced.refreshAdvancedDeviceCleanup();

    const clearUnknownButton = document.querySelector('#advanced-device-clear-unknown') as HTMLButtonElement;
    clearUnknownButton.click();
    await flushPromises();
    expect(clearUnknownButton.classList.contains('confirming')).toBe(true);

    clearUnknownButton.click();
    await flushPromises();

    expect(homey.setSetting).toHaveBeenCalledWith('controllable_devices', { 'dev-1': true });
    expect(homey.setSetting).toHaveBeenCalledWith('managed_devices', { 'dev-1': true });
  });
});
