import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPriceAwareDevicesView } from '../src/ui/views/PriceAwareDevicesView.tsx';

afterEach(() => {
  document.body.replaceChildren();
});

describe('PriceAwareDevicesView', () => {
  it('shows each delta as the magnitude the planner applies, whatever sign was stored', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const onDeviceExpensiveDeltaChange = vi.fn();

    // An older save stored both signs backwards. The planner applies 3 and 2;
    // clamping them to zero showed a number that does not take effect.
    renderPriceAwareDevicesView(mount, {
      priceSetupStatus: { state: 'unavailable' },
      optimizationEnabled: true,
      devices: [{ id: 'hp', name: 'Heat pump', cheapDelta: -3, expensiveDelta: 2 }],
      handlers: {
        onOptimizationToggle: vi.fn(),
        onDeviceCheapDeltaChange: vi.fn(),
        onDeviceExpensiveDeltaChange,
      },
    });

    const values = Array.from(mount.querySelectorAll('.value-adjuster__value')).map((node) => node.textContent);
    expect(values).toEqual(['↑3 °C', '↓2 °C']);

    // Stepping from the shown magnitude stores the normalized sign.
    const increaseReduction = mount.querySelector<HTMLElement>('[aria-label="Increase expensive-hour reduction for Heat pump"]');
    increaseReduction?.click();
    expect(onDeviceExpensiveDeltaChange).toHaveBeenCalledWith('hp', -2.5);
  });

  describe('Prices from', () => {
    const mountWith = (priceSetupStatus: Parameters<typeof renderPriceAwareDevicesView>[1]['priceSetupStatus']) => {
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderPriceAwareDevicesView(mount, {
        priceSetupStatus,
        optimizationEnabled: true,
        devices: [],
        handlers: {
          onOptimizationToggle: vi.fn(),
          onDeviceCheapDeltaChange: vi.fn(),
          onDeviceExpensiveDeltaChange: vi.fn(),
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
