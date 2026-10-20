import { act } from 'preact/test-utils';
import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCacheForAllHomes: vi.fn(),
}));
const { setChargingCurrentDevice } = await import('../src/ui/deviceDetail/chargingCurrent.tsx');
const charger: ChargingCurrentRead = { deviceId: 'charger', name: 'Garage',
  setup: { method: 'flow', confirmation: 'single_charger' }, scope: 'installation',
  capabilityWritable: false, sharedInstallation: false, flowCheck: 'clear', flowNames: [], currentRoute: 'flow' };

beforeEach(() => {
  document.body.innerHTML = '<div id="device-detail-charging-current"></div>';
  callApi.mockReset();
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [charger] : { configured: false, state: 'not_configured' });
});
afterEach(() => { act(() => setChargingCurrentDevice('')); });

const button = (text: string): HTMLElement => {
  const match = [...document.querySelectorAll<HTMLElement>('md-outlined-button, md-filled-button')]
    .find((element) => element.textContent === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
};

test('shows failed initial reads and retries from the same device page', async () => {
  callApi.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => setChargingCurrentDevice('charger'));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded'));
  await act(async () => button('Try again').click());
  expect(document.body.textContent).toContain('Built-in current control is not enabled');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('retains the entered key after a failed save and clears it after success', async () => {
  await act(async () => setChargingCurrentDevice('charger'));
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

test('ignores a stale failed read after selecting another device', async () => {
  let rejectRead!: (error: Error) => void;
  callApi.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
  await act(async () => setChargingCurrentDevice('old-device'));
  await act(async () => setChargingCurrentDevice('charger'));
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
  await act(async () => setChargingCurrentDevice('charger'));
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
  await act(async () => setChargingCurrentDevice('charger'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field')!;
  await act(async () => { field.value = 'test-key'; field.dispatchEvent(new Event('input')); });
  expect(button('Save key and enable').hasAttribute('disabled')).toBe(true);
  expect(callApi.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
});


test('allows replacing an existing key without enabling control when a Flow conflicts', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, flowCheck: 'conflict' }]
    : { configured: true, state: 'permission_denied' });
  await act(async () => setChargingCurrentDevice('charger'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field')!;
  await act(async () => { field.value = 'replacement-key'; field.dispatchEvent(new Event('input')); });
  expect(button('Replace key').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Replace key').click());
  await vi.waitFor(() => expect(field.value).toBe(''));
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_access', { key: 'replacement-key' });
  expect(callApi.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1);
});


test.each(['conflict', 'unavailable'] as const)('explains blocked activation beside the action even with a verified key: %s', async (flowCheck) => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, scope: 'vehicle', setup: { method: 'flow', confirmation: 'vehicle' }, flowCheck, flowNames: ['Current bridge'] }]
    : { configured: true, state: 'ready' });
  await act(async () => setChargingCurrentDevice('charger'));
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
  await act(async () => setChargingCurrentDevice('charger'));
  expect(document.body.textContent).not.toContain('only one charger');
  expect(document.body.textContent).not.toContain('Control charging through this car');
  await act(async () => button('Use built-in control').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_current/charger', { method: 'built_in', confirmation: 'none' });
});

test('says a selected built-in route is paused while a Flow sets the same current', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => path === '/ui_charging_current'
    ? [{ ...charger, setup: { method: 'built_in', confirmation: 'single_charger' }, flowCheck: 'conflict', flowNames: ['Night charge'], currentRoute: 'flow' }]
    : { configured: true, state: 'ready' });
  await act(async () => setChargingCurrentDevice('charger'));
  expect(document.body.textContent).toContain('Built-in current control is paused.');
  expect(document.body.textContent).toContain('The Flow Night charge sets the same charging current, and PELS cannot stop a Flow.');
  expect(document.body.textContent).toContain('choose “Use a Flow” below');
  expect(document.body.textContent).toContain('resumes on its own');
  expect(document.body.textContent).not.toContain('Remove the current-setting action from your Flow before using built-in control');
});

test('Check again also runs the Flow scan that resumes a paused route', async () => {
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === '/ui_charging_current') return [{ ...charger, setup: { method: 'built_in', confirmation: 'single_charger' }, flowCheck: 'conflict', currentRoute: 'flow' }];
    if (path === '/ui_refresh_flow_conflicts') return { devices: [], evSocReporters: [] };
    return { configured: true, state: 'ready' };
  });
  await act(async () => setChargingCurrentDevice('charger'));
  await act(async () => button('Check again').click());
  await vi.waitFor(() => expect(callApi).toHaveBeenCalledWith('POST', '/ui_refresh_flow_conflicts', {}));
  expect(callApi).toHaveBeenCalledWith('POST', '/ui_charging_access/check');
});
