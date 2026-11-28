import { act } from 'preact/test-utils';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({ callApi: (...args: unknown[]) => callApi(...args) }));
const { mountDeyeDischargeHold } = await import('../src/ui/deyeDischargeHold.tsx');

test('shows the saved limit and requires confirmation to acknowledge manual Deye recovery', async () => {
  document.body.innerHTML = '<div id="deye-discharge-hold-root"></div>';
  callApi.mockResolvedValueOnce({
    enabled: true, state: 'recovery_required', originalLimitA: 60, orderId: '123', deviceSn: 'example-inverter',
  }).mockResolvedValueOnce({ enabled: false, state: 'disabled' });

  await act(async () => mountDeyeDischargeHold());
  const root = document.getElementById('deye-discharge-hold-root');
  await vi.waitFor(() => expect(root?.querySelector('summary')?.textContent).toContain('Check discharge limit'));
  expect(root?.textContent).toContain('60 A');
  expect(root?.textContent).toContain('123');
  const button = [...(root?.querySelectorAll<HTMLElement & { disabled: boolean }>('md-filled-button') ?? [])]
    .find((node) => node.textContent === 'Verify restored limit');
  const checkbox = root?.querySelector<HTMLElement & { checked: boolean }>('md-checkbox');
  if (!button || !checkbox) throw new Error('Missing Deye recovery controls');
  expect(button.disabled).toBe(true);

  await act(async () => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
  });
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(callApi).toHaveBeenLastCalledWith('POST', '/ui_charging_access/check?provider=deye', {
    provider: 'deye', action: 'acknowledge', confirmedOrderSettled: true,
  });
});
