import { act } from 'preact/test-utils';
import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));
const { setChargingCurrentDevice } = await import('../src/ui/deviceDetail/chargingCurrent.tsx');
const charger: ChargingCurrentRead = { deviceId: 'charger', name: 'Garage',
  setup: { method: 'flow', confirmation: 'single_charger' }, scope: 'installation',
  capabilityWritable: false, sharedInstallation: false, flowCheck: 'clear', flowNames: [] };

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
  expect(document.body.textContent).toContain('Flow control is selected');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('retains the entered key after a failed save and clears it after success', async () => {
  await act(async () => setChargingCurrentDevice('charger'));
  const field = document.querySelector<HTMLElement & { value: string }>('md-filled-text-field');
  if (!field) throw new Error('Missing key field');
  await act(async () => { field.value = 'private-test-key'; field.dispatchEvent(new Event('input')); });
  callApi.mockRejectedValueOnce(new Error('Homey api PUT /ui_charging_access failed: Save failed'));
  await act(async () => button('Save key').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Save failed');
  expect(field.value).toBe('private-test-key');
  await act(async () => button('Save key').click());
  await vi.waitFor(() => expect(field.value).toBe(''));
});

test('ignores a stale failed read after selecting another device', async () => {
  let rejectRead!: (error: Error) => void;
  callApi.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
  await act(async () => setChargingCurrentDevice('old-device'));
  await act(async () => setChargingCurrentDevice('charger'));
  await act(async () => rejectRead(new Error('Old read failed')));
  expect(document.body.textContent).toContain('Flow control is selected');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
