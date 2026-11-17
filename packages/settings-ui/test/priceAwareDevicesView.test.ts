import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderPriceAwareDevicesView } from '../src/ui/views/PriceAwareDevicesView.tsx';

let showDialog: MockInstance;
beforeEach(() => {
  // jsdom has no native dialog.showModal or animations. Keep this test on
  // controller-owned open state and close events, as the Modes tests do.
  const dialog = customElements.get('md-dialog')!;
  showDialog = vi.spyOn(dialog.prototype, 'show').mockResolvedValue(undefined);
});
afterEach(() => {
  document.body.replaceChildren();
  showDialog.mockRestore();
});

describe('PriceAwareDevicesView', () => {
  it('shows each delta as the magnitude the planner applies, whatever sign was stored', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const onDevicePriceAdjustmentChange = vi.fn();

    // An older save stored both signs backwards. The planner applies 3 and 2;
    // clamping them to zero showed a number that does not take effect.
    renderPriceAwareDevicesView(mount, {
      priceSetupStatus: { state: 'unavailable' },
      optimizationEnabled: true,
      optimizationBusy: false,
      optimizationOffArmed: false,
      devices: [{ id: 'hp', name: 'Heat pump', cheapDelta: -3, expensiveDelta: 2 }],
      handlers: {
        onOptimizationToggle: vi.fn(),
        onOptimizationOffConfirm: vi.fn(),
        onOptimizationOffDismiss: vi.fn(),
        onDevicePriceAdjustmentChange,
      },
    });

    const values = Array.from(mount.querySelectorAll('.value-adjuster__value')).map((node) => node.textContent);
    expect(values).toEqual(['↑3 °C', '↓2 °C']);

    // The view sends the shown magnitude and its meaning to the controller.
    const increaseReduction = mount.querySelector<HTMLElement>('[aria-label="Increase expensive-hour reduction for Heat pump"]');
    increaseReduction?.click();
    expect(onDevicePriceAdjustmentChange).toHaveBeenCalledWith('hp', 'expensive_hour_reduction', 2.5);
  });

  describe('Prices from', () => {
    const mountWith = (priceSetupStatus: Parameters<typeof renderPriceAwareDevicesView>[1]['priceSetupStatus']) => {
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderPriceAwareDevicesView(mount, {
        priceSetupStatus,
        optimizationEnabled: true,
        optimizationBusy: false,
        optimizationOffArmed: false,
        devices: [],
        handlers: {
          onOptimizationToggle: vi.fn(),
          onOptimizationOffConfirm: vi.fn(),
          onOptimizationOffDismiss: vi.fn(),
          onDevicePriceAdjustmentChange: vi.fn(),
        },
      });
      return mount.querySelector<HTMLElement>('#price-aware-devices-source');
    };

    it('leads with prices that are not set up, and the way to set them up', () => {
      const card = mountWith({
        state: 'open',
        summary: 'Norway, without your grid tariff. PELS uses NO1 and Strømstøtte until you choose.',
      });

      expect(card?.querySelector('.plan-chip--warn')?.textContent).toBe('Not set up');
      expect(card?.textContent).toContain('Norway, without your grid tariff.');
      const action = card?.querySelector('[data-settings-target="electricity-prices"]');
      expect(action?.textContent?.trim()).toBe('Set up prices');
      expect(action?.getAttribute('data-settings-anchor')).toBe('#price-source-select');
    });

    it('names the source of prices that are set up', () => {
      const card = mountWith({ state: 'complete', summary: 'Norway · ARVA AS · NO4 · Norgespris' });

      expect(card?.querySelector('.plan-chip')).toBeNull();
      expect(card?.textContent).toContain('Norway · ARVA AS · NO4 · Norgespris');
      expect(card?.querySelector('[data-settings-target="electricity-prices"]')?.textContent?.trim()).toBe('Change');
    });

    it('claims nothing without the read', () => {
      expect(mountWith({ state: 'unavailable' })).toBeNull();
    });
  });
});

describe('Respond to prices confirmation view', () => {
  const mountView = (armed = false, busy = false) => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const handlers = {
      onOptimizationToggle: vi.fn(),
      onOptimizationOffConfirm: vi.fn(),
      onOptimizationOffDismiss: vi.fn(),
      onDevicePriceAdjustmentChange: vi.fn(),
    };
    renderPriceAwareDevicesView(mount, {
      priceSetupStatus: { state: 'unavailable' },
      optimizationEnabled: true,
      optimizationBusy: busy,
      optimizationOffArmed: armed,
      devices: [],
      handlers,
    });
    return { mount, handlers };
  };

  it('restores Material and native checked state so a cancelled toggle can be requested again', async () => {
    const { mount, handlers } = mountView();
    const control = mount.querySelector<HTMLElement & { selected: boolean; updateComplete: Promise<boolean> }>('md-switch')!;
    await control.updateComplete;
    const input = control.shadowRoot!.querySelector<HTMLInputElement>('input')!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      input.checked = false;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      expect(control.selected).toBe(true);
      expect(input.checked).toBe(true);
      expect(handlers.onOptimizationToggle).toHaveBeenLastCalledWith(false);
    }
    expect(handlers.onOptimizationToggle).toHaveBeenCalledTimes(2);
    expect(mount.textContent).toContain('Smart tasks also need this setting to plan when to run.');
  });

  it('routes Material dialog dismissal to the armed request', () => {
    const { mount, handlers } = mountView(true);
    const dialog = mount.querySelector<HTMLElement & { open: boolean }>('md-dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.dispatchEvent(new Event('close', { cancelable: true }))).toBe(false);
    expect(handlers.onOptimizationOffDismiss).toHaveBeenCalledOnce();
  });

  it('ignores a close event after confirmation has already disarmed the dialog', () => {
    const { mount, handlers } = mountView();
    mount.querySelector('md-dialog')!.dispatchEvent(new Event('close'));
    expect(handlers.onOptimizationOffDismiss).not.toHaveBeenCalled();
  });

  it('disables the Material switch while saving', () => {
    const { mount } = mountView(false, true);
    expect(mount.querySelector<HTMLElement & { disabled: boolean }>('md-switch')!.disabled).toBe(true);
  });

  it('sets boolean false when closing and saving instead of clearing Material properties to empty strings', async () => {
    const { mount, handlers } = mountView(true);
    const control = mount.querySelector<HTMLElement & {
      selected: boolean; disabled: boolean; updateComplete: Promise<boolean>;
    }>('md-switch')!;
    await control.updateComplete;
    const input = control.shadowRoot!.querySelector<HTMLInputElement>('input')!;
    input.checked = false;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    expect(input.checked).toBe(true);
    renderPriceAwareDevicesView(mount, {
      priceSetupStatus: { state: 'unavailable' },
      optimizationEnabled: false,
      optimizationBusy: false,
      optimizationOffArmed: false,
      devices: [],
      handlers,
    });
    await control.updateComplete;
    expect(control.selected).toBe(false);
    expect(input.checked).toBe(false);
    expect(control.disabled).toBe(false);
    expect(mount.querySelector<HTMLElement & { open: boolean }>('md-dialog')!.open).toBe(false);
  });
});
