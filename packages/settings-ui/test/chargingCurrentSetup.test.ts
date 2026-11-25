import { act } from 'preact/test-utils';
import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCacheForAllHomes: vi.fn(),
}));
const { setChargingCurrentDevice, requestChargingControlFocus, cancelChargingControlFocus, refreshChargingSetupForControlSettings }
  = await import('../src/ui/deviceDetail/chargingCurrent.tsx');
const charger: ChargingCurrentRead = { deviceId: 'charger', name: 'Garage',
  setup: { method: 'flow', confirmation: 'single_charger' }, scope: 'installation',
  supportsAppAction: true, capabilityWritable: false, sharedInstallation: false, flowCheck: 'clear', flowNames: [], currentRoute: 'flow', missingCompanion: 'none' };

beforeEach(() => {
  document.body.innerHTML = '<div id="device-detail-charging-current"></div>';
  callApi.mockReset();
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [charger] : { configured: false, state: 'not_configured' });
});
afterEach(() => { act(() => setChargingCurrentDevice('', false)); });

const button = (text: string): HTMLElement => {
  const match = [...document.querySelectorAll<HTMLElement>('md-outlined-button, md-filled-button, md-text-button')]
    .find((element) => element.textContent === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
};

test('a device that is not a charger shows nothing when the read fails', async () => {
  callApi.mockRejectedValue(new Error('Unavailable'));
  await act(async () => setChargingCurrentDevice('heater', false));
  await vi.waitFor(() => expect(callApi).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(document.getElementById('device-detail-charging-current')?.textContent).toBe('');
});

test('shows failed initial reads and retries from the same device page', async () => {
  callApi.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded'));
  await act(async () => button('Try again').click());
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.body.textContent).toContain('Built-in current control is not enabled');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('retains the entered key after a failed save and clears it after success', async () => {
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field');
  if (!field) throw new Error('Missing key field');
  await act(async () => { field.value = 'private-test-key'; field.dispatchEvent(new Event('input')); });
  callApi.mockRejectedValueOnce(new Error('Homey api PUT /ui_charging_access failed: Save failed'));
  await act(async () => button('Save key and enable').click());
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Save failed'));
  expect(field.value).toBe('private-test-key');
  await act(async () => button('Save key and enable').click());
  await vi.waitFor(() => expect(field.value).toBe(''));
});

test.each([
  { role: 'secondary', mainName: 'Driveway', automaticWatts: false },
  { role: 'main', mainName: 'Garage', automaticWatts: true },
] as const)('shows a save error after moving to short installation setup: %o', async (chargingInstallation) => {
  let device = charger;
  callApi.mockImplementation(async (method: string, path: string) => {
    if (method === 'PUT' && path === '/ui_charging_current/charger') {
      device = { ...charger, chargingInstallation };
      throw new Error('Charging setup changed. Check the new setup.');
    }
    return path === '/ui_charging_current' ? [device] : { configured: true, state: 'ready' };
  });

  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(button('Use built-in control')).toBeTruthy());
  await act(async () => button('Use built-in control').click());
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
    .toBe('Charging setup changed. Check the new setup.'));
  expect(document.body.textContent).toContain('The chargers share that current');
  expect(document.body.textContent).not.toContain('Use built-in control');
});

test('ignores a stale failed read after selecting another device', async () => {
  let rejectRead!: (error: Error) => void;
  callApi.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
  await act(async () => setChargingCurrentDevice('old-device', true));
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  await act(async () => rejectRead(new Error('Old read failed')));
  expect(document.body.textContent).toContain('Built-in current control is not enabled');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

function savedSetup(failEnable = false) {
  let configured = false;
  let device = charger;
  callApi.mockImplementation(async (method: string, path: string, body: unknown) => {
    if (method === 'PUT' && path === '/ui_charging_access') configured = true;
    if (method === 'PUT' && path === '/ui_charging_current/charger') {
      if (failEnable) throw new Error('Could not enable control');
      const setup = body as ChargingCurrentRead['setup'];
      device = { ...charger, setup, currentRoute: setup.method };
    }
    return path === '/ui_charging_current' ? [device]
      : { configured, state: configured ? 'ready' : 'not_configured' };
  });
}

async function enterKeyAndEnable() {
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field')!;
  await act(async () => { field.value = 'test-key'; field.dispatchEvent(new Event('input')); });
  await act(async () => button('Save key and enable').click());
}

test('saving the key through the primary setup action also enables built-in control', async () => {
  savedSetup();
  await enterKeyAndEnable();
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_current/charger', {
    method: 'built_in', confirmation: 'single_charger',
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Built-in current control is selected.'));
  expect(document.body.textContent).not.toContain('Select “Use built-in control” to finish setup');
});

test('a failed activation shows the saved key and offers activation again without resaving it', async () => {
  savedSetup(true);
  const changed = vi.fn();
  document.addEventListener('charging-control-changed', changed, { once: true });
  await enterKeyAndEnable();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not enable control'));
  expect(document.body.textContent).toContain('Your key is ready.');
  expect(document.body.textContent).toContain('Built-in current control is not enabled.');
  expect(button('Use built-in control')).toBeTruthy();
  expect(changed).toHaveBeenCalledOnce();
});

test.each(['conflict', 'unavailable'] as const)('does not enable built-in control while Flow checks are %s', async (flowCheck) => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, flowCheck }] : { configured: false, state: 'not_configured' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field')!;
  await act(async () => { field.value = 'test-key'; field.dispatchEvent(new Event('input')); });
  expect(button('Save key and enable').hasAttribute('disabled')).toBe(true);
  expect(callApi.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
});


test('allows replacing an existing key without enabling control when a Flow conflicts', async () => {
  const changed = vi.fn();
  document.addEventListener('homey-api-key-changed', changed);
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, flowCheck: 'conflict' }]
    : { configured: true, state: 'permission_denied' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field')!;
  await act(async () => { field.value = 'replacement-key'; field.dispatchEvent(new Event('input')); });
  expect(button('Replace key').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Replace key').click());
  await vi.waitFor(() => expect(field.value).toBe(''));
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_access', { key: 'replacement-key' });
  expect(callApi.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1);
  expect(changed).toHaveBeenCalledTimes(1);
  document.removeEventListener('homey-api-key-changed', changed);
});


test.each(['conflict', 'unavailable'] as const)('explains blocked activation beside the action even with a verified key: %s', async (flowCheck) => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, scope: 'vehicle', setup: { method: 'flow', confirmation: 'vehicle' }, flowCheck, flowNames: ['Current bridge'] }]
    : { configured: true, state: 'ready' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  const action = button('Use built-in control');
  expect(action.hasAttribute('disabled')).toBe(true);
  const guidance = action.parentElement?.previousElementSibling;
  expect(guidance?.textContent).toContain(flowCheck === 'conflict' ? 'Current bridge' : 'could not check');
  expect(guidance?.textContent).toContain('Check again');
  expect(document.body.textContent).not.toContain('Your key is ready. Select');
  expect(document.body.textContent).toContain('This switch allows control through the car.');
});

test('a charger-scoped device enables built-in control without a scope confirmation', async () => {
  let device: ChargingCurrentRead = { ...charger, scope: 'charger', setup: { method: 'flow', confirmation: 'none' } };
  callApi.mockImplementation(async (method: string, path: string, body: unknown) => {
    if (method === 'PUT' && path === '/ui_charging_current/charger') {
      device = { ...device, setup: body as ChargingCurrentRead['setup'] };
    }
    return path === '/ui_charging_current' ? [device] : { configured: true, state: 'ready' };
  });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.body.textContent).not.toContain('only one charger');
  expect(document.body.textContent).not.toContain('Control charging through this car');
  await act(async () => button('Use built-in control').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_current/charger', { method: 'built_in', confirmation: 'none' });
});

test('a charger nothing controls is offered built-in control and no Flow', async () => {
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.body.textContent).toContain('Until you enable it below, nothing changes the charging current.');
  expect(document.body.textContent).not.toContain('Use a Flow');
  expect(document.body.textContent).not.toContain('Stepped device target changed');
});

test.each([
  { flowCheck: 'conflict', sharedInstallation: false },
  { flowCheck: 'clear', sharedInstallation: true },
] as const)('keeps the Flow choice for an owner who has a Flow or a shared installation: %o', async (facts) => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, ...facts }] : { configured: false, state: 'not_configured' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(button('Use a Flow')).toBeDefined();
  expect(document.body.textContent).not.toContain('nothing changes the charging current');
});

test('opens a shared charger’s start-policy setting and refreshes requirements after a settings change', async () => {
  let device: ChargingCurrentRead = {
    ...charger,
    setup: { method: 'built_in', confirmation: 'none' },
    sharedInstallation: true,
    sharedInstallationStartPolicyRequiredBy: [
      { id: 'charger', name: 'Garage' },
      { id: 'driveway', name: 'Driveway' },
    ],
  };
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [device] : { configured: false, state: 'not_configured' });
  const openDeviceDetail = vi.fn();
  document.addEventListener('open-device-detail', openDeviceDetail, { once: true });
  await act(async () => setChargingCurrentDevice('charger', false, undefined, true));
  const action = (name: string) => document.querySelector<HTMLElement>(`[aria-label="Open Power limiting for ${name}"]`);
  await vi.waitFor(() => expect(action('Garage')).toBeTruthy());
  expect(document.body.textContent).toContain('Built-in current control is paused.');
  expect(document.body.textContent).not.toContain('A Homey Flow sets the same charging current');
  await act(async () => action('Driveway')?.click());
  expect(openDeviceDetail).toHaveBeenCalledWith(expect.objectContaining({
    detail: { deviceId: 'driveway', focus: 'start-policy' },
  }));

  device = { ...device, sharedInstallationStartPolicyRequiredBy: [{ id: 'driveway', name: 'Driveway' }] };
  await act(async () => refreshChargingSetupForControlSettings());
  await vi.waitFor(() => expect(action('Garage')).toBeNull());
  expect(action('Driveway')).toBeTruthy();
});

test('says a selected built-in route is paused while a Flow sets the same current', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, setup: { method: 'built_in', confirmation: 'single_charger' }, flowCheck: 'conflict', flowNames: ['Night charge'], currentRoute: 'flow' }]
    : { configured: true, state: 'ready' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.body.textContent).toContain('Built-in current control is paused.');
  expect(document.body.textContent).toContain('The Flow Night charge sets the same charging current, and PELS cannot stop a Flow.');
  expect(document.body.textContent).toContain('choose “Use a Flow” below');
  expect(document.body.textContent).toContain('resumes on its own');
  expect(document.body.textContent).not.toContain('Remove the current-setting action from your Flow before using built-in control');
});

test('Check again also runs the Flow scan that resumes a paused route', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === '/ui_charging_current') return [{ ...charger, setup: { method: 'built_in', confirmation: 'single_charger' }, flowCheck: 'conflict', currentRoute: 'flow' }];
    if (path === '/ui_refresh_flow_conflicts') return { devices: [], evSocReporters: [], ignoredPowerUsageFlows: { state: 'none' } };
    return { configured: true, state: 'ready' };
  });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  await act(async () => button('Check again').click());
  await vi.waitFor(() => expect(callApi).toHaveBeenCalledWith('POST', '/ui_refresh_flow_conflicts', {}));
  expect(callApi).toHaveBeenCalledWith('POST', '/ui_charging_access/check');
});


test('lands on the consent switch once after a delayed charging read', async () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  const container = document.getElementById('device-detail-charging-current')!;
  const disclosure = document.createElement('details');
  container.replaceWith(disclosure);
  disclosure.append(container);
  let finish!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finish = resolve; }));
  act(() => setChargingCurrentDevice('charger', true));
  requestChargingControlFocus();
  await act(async () => finish([{ ...charger, scope: 'vehicle', setup: { method: 'built_in', confirmation: 'none' } }]));
  await vi.waitFor(() => expect(scroll.mock.contexts.includes(document.getElementById('device-detail-vehicle-control-row'))).toBe(true));
  expect(disclosure.open).toBe(true);
  disclosure.open = false;
  await act(async () => button('Check again').click());
  expect(disclosure.open).toBe(false);
});

test('does not steal focus when a pending charging destination was closed', async () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  let finish!: (devices: ChargingCurrentRead[]) => void;
  callApi.mockReturnValueOnce(new Promise<ChargingCurrentRead[]>((resolve) => { finish = resolve; }));
  act(() => setChargingCurrentDevice('charger', true));
  requestChargingControlFocus();
  cancelChargingControlFocus();
  await act(async () => finish([{ ...charger, scope: 'vehicle' }]));
  await vi.waitFor(() => expect(document.getElementById('device-detail-vehicle-control')).not.toBeNull());
  expect(scroll).not.toHaveBeenCalled();
});

test.each(['built_in', 'flow'] as const)('clears the prerequisite only after saving vehicle consent through %s', async (method) => {
  const { vehicleChargingConsentMissing } = await import('../src/ui/chargingSetupFacts.ts');
  // A Flow is offered only to an owner whose Flow already sets the current.
  let current: ChargingCurrentRead = { ...charger, scope: 'vehicle', setup: { method, confirmation: 'none' },
    flowCheck: method === 'flow' ? 'conflict' : 'clear' };
  callApi.mockImplementation(async (verb: string, path: string, body: ChargingCurrentRead['setup']) => {
    if (verb === 'PUT' && path === '/ui_charging_current/charger') current = { ...current, setup: body };
    return path === '/ui_charging_current' ? [current] : { configured: true, state: 'ready' };
  });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.getElementById('device-detail-vehicle-control')).not.toBeNull());
  expect(vehicleChargingConsentMissing('charger')).toBe(true);
  const toggle = document.getElementById('device-detail-vehicle-control') as HTMLElement & { selected: boolean };
  await act(async () => { toggle.selected = true; toggle.dispatchEvent(new Event('change')); });
  expect(vehicleChargingConsentMissing('charger')).toBe(true);
  await act(async () => button(method === 'built_in' ? 'Save car control' : 'Use a Flow').click());
  await vi.waitFor(() => expect(vehicleChargingConsentMissing('charger')).toBe(false));
});

async function openVehicleControl() {
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === '/ui_refresh_flow_conflicts') return { devices: [], evSocReporters: [], ignoredPowerUsageFlows: { state: 'none' } };
    return path === '/ui_charging_current'
      ? [{ ...charger, scope: 'vehicle', setup: { method: 'built_in', confirmation: 'none' } }]
      : { configured: true, state: 'ready' };
  });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.getElementById('device-detail-vehicle-control')).not.toBeNull());
  HTMLElement.prototype.scrollIntoView = vi.fn();
  return document.getElementById('device-detail-vehicle-control')!;
}

test.each([false, true])('waits for the Material switch render and respects cancellation: %s', async (cancel) => {
  const control = await openVehicleControl();
  let finish!: (ready: boolean) => void;
  Object.defineProperties(control, {
    hasUpdated: { configurable: true, value: false },
    isUpdatePending: { configurable: true, value: true },
    updateComplete: { configurable: true, value: new Promise<boolean>((resolve) => { finish = resolve; }) },
  });
  const focus = vi.spyOn(control, 'focus');
  requestChargingControlFocus();
  expect(focus).not.toHaveBeenCalled();
  if (cancel) cancelChargingControlFocus();
  await act(async () => finish(true));
  await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(cancel ? 0 : 1));
});

test('keeps a request made during Check again until the switch becomes enabled', async () => {
  const control = await openVehicleControl();
  let finish!: () => void;
  callApi.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const focus = vi.spyOn(control, 'focus');
  act(() => button('Check again').click());
  await vi.waitFor(() => expect((control as HTMLElement & { disabled: boolean }).disabled).toBe(true));
  requestChargingControlFocus();
  await act(async () => { await Promise.resolve(); });
  expect(focus).not.toHaveBeenCalled();
  await act(async () => finish());
  await vi.waitFor(() => expect((control as HTMLElement & { disabled: boolean }).disabled).toBe(false));
  expect(control.isConnected).toBe(true);
  await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
});

test.each([false, true])('capability-only current control only offers key removal when saved (%s)', async (configured) => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, supportsAppAction: false }]
    : { configured, state: configured ? 'ready' : 'not_configured' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.querySelector('md-filled-text-field')).toBeNull();
  expect(document.body.textContent?.includes('Remove saved API key')).toBe(configured);
  if (configured) {
    await act(async () => button('Remove key').click());
    await act(async () => button('Confirm removal').click());
    expect(callApi).toHaveBeenCalledWith('DELETE', '/ui_charging_access');
  }
  expect(document.body.textContent).toContain('Update the charger’s app');
  expect(button('Use built-in control').hasAttribute('disabled')).toBe(true);
  await act(async () => button('Use a Flow').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_current/charger', {
    method: 'flow', confirmation: 'single_charger',
  });
});

test('a retired read-only built-in route offers an app update and explicit Flow selection', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, supportsAppAction: false, setup: { method: 'built_in', confirmation: 'single_charger' },
      currentRoute: 'built_in' }]
    : { configured: true, state: 'ready' });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.body.textContent).toContain('Built-in current control needs a charger app update.');
  expect(document.body.textContent).toContain('Update the charger’s app');
  expect(document.body.textContent).not.toContain('Your key is ready');
  expect(button('Use a Flow')).toBeTruthy();
});

test('writable capability-only current control ignores key status and refreshes Flow checks', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === '/ui_refresh_flow_conflicts') return { devices: [], evSocReporters: [], ignoredPowerUsageFlows: { state: 'none' } };
    return path === '/ui_charging_current'
      ? [{ ...charger, supportsAppAction: false, capabilityWritable: true }]
      : { configured: true, state: 'permission_denied' };
  });
  await act(async () => setChargingCurrentDevice('charger', true));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Loading charging setup…'));
  expect(document.querySelector('md-filled-text-field')).toBeNull();
  expect(button('Use built-in control').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Check again').click());
  expect(callApi).toHaveBeenCalledWith('POST', '/ui_refresh_flow_conflicts', {});
  expect(callApi).not.toHaveBeenCalledWith('POST', '/ui_charging_access/check');
  await act(async () => button('Use built-in control').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_current/charger', {
    method: 'built_in', confirmation: 'single_charger',
  });
});
