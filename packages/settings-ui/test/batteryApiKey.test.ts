import { act } from 'preact/test-utils';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import type { SettingsUiDeviceDetailItem } from '../src/ui/deviceUtils.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCacheForAllHomes: vi.fn(),
}));
const { setBatteryApiKeyDevice } = await import('../src/ui/deviceDetail/batteryApiKey.tsx');

const battery = (fields: Pick<SettingsUiDeviceDetailItem, 'batteryControl' | 'batteryUsesHomeyApiKey'>) => ({
  ...withDescriptorIdentity<TargetDeviceSnapshot>({
    id: 'venus', name: 'Marstek Venus', deviceClass: 'battery', available: true, targets: [],
    capabilities: ['measure_power'], expectedPowerKw: 0, expectedPowerSource: 'default',
  }),
  ...fields,
}) as unknown as SettingsUiDeviceDetailItem;

let access = { configured: false, state: 'not_configured' };

beforeEach(() => {
  document.body.innerHTML = '<div id="device-detail-battery-api-key"></div>';
  access = { configured: false, state: 'not_configured' };
  callApi.mockReset();
  callApi.mockImplementation(async (method: string, path: string, body?: { key?: string }) => {
    if (method === 'PUT' && path === '/ui_charging_access') access = body?.key ? { configured: true, state: 'ready' } : access;
    if (method === 'DELETE') access = { configured: false, state: 'not_configured' };
    return access;
  });
});
afterEach(() => { act(() => setBatteryApiKeyDevice(null)); });

const container = (): HTMLElement => document.getElementById('device-detail-battery-api-key') as HTMLElement;
const button = (text: string): HTMLElement => {
  const match = [...container().querySelectorAll<HTMLElement>('md-outlined-button, md-filled-button')]
    .find((element) => element.textContent === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
};

test('offers the shared Homey API key on a battery that needs one, and saves it on the existing route', async () => {
  const changed = vi.fn();
  document.addEventListener('charging-control-changed', changed);
  await act(async () => setBatteryApiKeyDevice(battery({
    batteryControl: 'needs_homey_api_key', batteryUsesHomeyApiKey: true,
  })));
  await vi.waitFor(() => expect(container().textContent).toContain('A Homey API key is needed for PELS to control this battery.'));
  expect(container().textContent).toContain('One key works for all supported batteries, cars and chargers.');
  const field = container().querySelector<HTMLElement & { value: string }>('md-filled-text-field');
  if (!field) throw new Error('Missing key field');
  await act(async () => { field.value = 'private-test-key'; field.dispatchEvent(new Event('input')); });
  await act(async () => button('Save key').click());

  await vi.waitFor(() => expect(container().querySelector('summary')?.textContent).toBe('Manage API key'));
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_charging_access', { key: 'private-test-key' });
  expect(container().querySelector<HTMLElement & { value: string }>('md-filled-text-field')?.value).toBe('');
  expect(changed).toHaveBeenCalled();
  document.removeEventListener('charging-control-changed', changed);
});

test('keeps the key manageable on a battery PELS drives with it, and offers to remove it', async () => {
  access = { configured: true, state: 'ready' };
  await act(async () => setBatteryApiKeyDevice(battery({ batteryControl: 'drivable', batteryUsesHomeyApiKey: true })));
  await vi.waitFor(() => expect(container().textContent).toContain('API key verified.'));
  await act(async () => button('Remove key').click());
  await vi.waitFor(() => expect(container().textContent).toContain('A Homey API key is needed'));
  expect(callApi).toHaveBeenCalledWith('DELETE', '/ui_charging_access');
});

test('offers a check for a saved key Homey could not confirm', async () => {
  access = { configured: true, state: 'unavailable' };
  await act(async () => setBatteryApiKeyDevice(battery({
    batteryControl: 'drivable', batteryUsesHomeyApiKey: true,
  })));
  await vi.waitFor(() => expect(container().textContent).toContain('Check the key and try again.'));
  await act(async () => button('Check again').click());
  expect(callApi).toHaveBeenCalledWith('POST', '/ui_charging_access/check');
});

test('shows nothing for a battery that needs no key', async () => {
  await act(async () => setBatteryApiKeyDevice(battery({ batteryControl: 'drivable', batteryUsesHomeyApiKey: false })));
  expect(container().textContent).toBe('');
  expect(callApi).not.toHaveBeenCalled();
});
