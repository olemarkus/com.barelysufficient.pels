import { h, render } from 'preact';
import { act } from 'preact/test-utils';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/homey.ts')>(),
  callApi: (...args: unknown[]) => callApi(...args),
}));

const { BatteryRecoveryControls } = await import('../src/ui/deviceDetail/batteryRecovery.tsx');

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  callApi.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const renderRecovery = (canRecover: boolean, candidates: readonly { id: string; name: string }[]) => act(() => {
  render(h(BatteryRecoveryControls, {
    deviceId: 'battery-1', canRecover, recovery: { claimedAtMs: 123, candidates },
  }), container);
});

const button = (label: string) => {
  const result = [...container.querySelectorAll<HTMLElement>('md-filled-button, md-outlined-button')]
    .find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
};

test('makes the owner select the original plant even when only one is listed', async () => {
  renderRecovery(true, [{ id: 'plant-1', name: 'Garage plant' }]);
  const select = container.querySelector<HTMLSelectElement>('md-filled-select');
  if (!select) throw new Error('Missing plant selector');
  const restore = button('Restore selected plant');
  expect(restore.hasAttribute('disabled')).toBe(true);

  act(() => {
    select.value = 'plant-1';
    select.dispatchEvent(new Event('change'));
  });
  expect(restore.hasAttribute('disabled')).toBe(false);
  await act(async () => restore.click());

  expect(callApi).toHaveBeenCalledWith('POST', '/ui_battery_recovery/battery-1',
    { action: 'hand_back', targetId: 'plant-1', claimedAtMs: 123 });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Battery restored. Managed by PELS is off.');
});

test('offers manual restoration without a current plant and requires Managed off', async () => {
  renderRecovery(false, []);
  expect(container.querySelector('md-filled-select')).toBeNull();
  expect(container.textContent).toContain('Turn off Managed by PELS');
  expect(button('I restored it manually').hasAttribute('disabled')).toBe(true);

  renderRecovery(true, []);
  expect(container.textContent).toContain('remove both charge and discharge limits');
  await act(async () => button('I restored it manually').click());

  expect(callApi).toHaveBeenCalledWith('POST', '/ui_battery_recovery/battery-1',
    { action: 'acknowledge', claimedAtMs: 123 });
});
