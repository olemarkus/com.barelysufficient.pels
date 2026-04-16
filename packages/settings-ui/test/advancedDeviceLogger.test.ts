const setupDom = () => {
  document.body.innerHTML = [
    '<select id="advanced-device-select"></select>',
    '<button id="advanced-device-clear"></button>',
    '<button id="advanced-device-clear-unknown"></button>',
    '<select id="advanced-api-device-select"></select>',
    '<button id="advanced-api-device-refresh"></button>',
    '<button id="advanced-api-device-log"></button>',
  ].join('');
};

const flushPromises = async () => new Promise<void>((resolve) => {
  const queueMicrotaskFn = (globalThis as any).queueMicrotask as ((cb: () => void) => void) | undefined;
  if (typeof queueMicrotaskFn === 'function') {
    queueMicrotaskFn(() => resolve());
    return;
  }
  if (typeof setImmediate === 'function') {
    setImmediate(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});

vi.mock('../src/ui/homey.ts', () => ({
  callApi: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../src/ui/devices.ts', () => ({
  renderDevices: vi.fn(),
}));

vi.mock('../src/ui/modes.ts', () => ({
  renderPriorities: vi.fn(),
}));

vi.mock('../src/ui/priceOptimization.ts', () => ({
  renderPriceOptimization: vi.fn(),
}));

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

describe('advanced device logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setupDom();
  });

  it('loads Homey devices into the logger select', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    homey.callApi.mockResolvedValue([
      { id: 'dev-1', name: 'Pump', class: 'pump' },
    ]);

    const advanced = await import('../src/ui/advanced.ts');
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

  it('filters out invalid Homey API devices without a name', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    homey.callApi.mockResolvedValue([
      { id: 'dev-1', name: 'Pump', class: 'pump' },
      { id: 'dev-2' },
      { name: 'No id' },
    ]);

    const advanced = await import('../src/ui/advanced.ts');
    await advanced.refreshAdvancedDeviceLogger();

    const select = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;

    expect(select.options.length).toBe(2);
    expect(select.options[1].value).toBe('dev-1');
    expect(select.options[1].textContent).toContain('Pump');
  });

  it('warns when no device is selected', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    homey.callApi.mockResolvedValue([{ id: 'dev-1', name: 'Pump' }]);

    const advanced = await import('../src/ui/advanced.ts');
    advanced.initAdvancedDeviceLoggerHandlers();
    await advanced.refreshAdvancedDeviceLogger();

    const logButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;
    logButton.click();
    await flushPromises();

    expect(toast.showToast).toHaveBeenCalledWith('Select a device first.', 'warn');
    expect(homey.callApi).not.toHaveBeenCalledWith('POST', '/log_homey_device', expect.anything());
  });

  it('warns when device is missing from cache', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    homey.callApi.mockResolvedValue([{ id: 'dev-1', name: 'Pump' }]);

    const advanced = await import('../src/ui/advanced.ts');
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
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    homey.callApi.mockImplementation((method: string) => {
      if (method === 'GET') {
        return Promise.resolve([{ id: 'dev-1', name: 'Pump' }]);
      }
      if (method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });

    const advanced = await import('../src/ui/advanced.ts');
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
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    homey.callApi.mockImplementation((method: string) => {
      if (method === 'GET') {
        return Promise.resolve([{ id: 'dev-1', name: 'Pump' }]);
      }
      if (method === 'POST') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(null);
    });

    const advanced = await import('../src/ui/advanced.ts');
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
    vi.resetModules();
    vi.clearAllMocks();
    setupDom();
  });

  const seedState = async () => {
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [
      { id: 'dev-1', name: 'Device One' } as typeof state.latestDevices[number],
    ];
    state.controllableMap = { 'dev-1': true, 'dev-2': true };
    state.managedMap = { 'dev-1': true, 'dev-2': true };
    state.deviceControlProfiles = {
      'dev-1': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
        ],
      },
      'dev-2': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    };
    state.shedBehaviors = {
      'dev-1': { action: 'set_step', stepId: 'low' },
      'dev-2': { action: 'turn_off' },
    };
    state.priceOptimizationSettings = { 'dev-1': { enabled: true, cheapDelta: 5, expensiveDelta: -5 } };
    state.capacityPriorities = { Home: { 'dev-1': 1, 'dev-2': 2 } };
    state.modeTargets = { Home: { 'dev-1': 21, 'dev-2': 19 } };
    return state;
  };

  it('clears selected device settings after confirmation', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    await seedState();

    const advanced = await import('../src/ui/advanced.ts');
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
    expect(homey.setSetting).toHaveBeenCalledWith('device_control_profiles', {
      'dev-2': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
    expect(homey.setSetting).toHaveBeenCalledWith('overshoot_behaviors', { 'dev-2': { action: 'turn_off' } });
    expect(toast.showToast).toHaveBeenCalledWith('Cleared PELS data for Device One.', 'ok');
  });

  it('includes the device id when the selected device is no longer in the live list', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    const toast = await import('../src/ui/toast.ts') as unknown as { showToast: ReturnType<typeof vi.fn>; showToastError: ReturnType<typeof vi.fn> };
    await seedState();

    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [];

    const advanced = await import('../src/ui/advanced.ts');
    advanced.initAdvancedDeviceCleanupHandlers();
    advanced.refreshAdvancedDeviceCleanup();

    const select = document.querySelector('#advanced-device-select') as HTMLSelectElement;
    const clearButton = document.querySelector('#advanced-device-clear') as HTMLButtonElement;
    select.value = 'dev-1';

    clearButton.click();
    await flushPromises();
    clearButton.click();
    await flushPromises();

    expect(homey.setSetting).toHaveBeenCalledWith('controllable_devices', { 'dev-2': true });
    expect(toast.showToast).toHaveBeenCalledWith('Cleared PELS data for device dev-1.', 'ok');
  });

  it('clears unknown devices after confirmation', async () => {
    const homey = await import('../src/ui/homey.ts') as unknown as { callApi: ReturnType<typeof vi.fn>; setSetting: ReturnType<typeof vi.fn> };
    await seedState();

    const advanced = await import('../src/ui/advanced.ts');
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
    expect(homey.setSetting).toHaveBeenCalledWith('device_control_profiles', {
      'dev-1': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
        ],
      },
    });
    expect(homey.setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      'dev-1': { action: 'set_step', stepId: 'low' },
    });
  });
});
