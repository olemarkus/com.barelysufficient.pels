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
      optimizationEnabled: true,
      devices: [{ id: 'hp', name: 'Heat pump', cheapDelta: -3, expensiveDelta: 2 }],
      onOptimizationToggle: vi.fn(),
      onDeviceCheapDeltaChange: vi.fn(),
      onDeviceExpensiveDeltaChange,
    });

    const values = Array.from(mount.querySelectorAll('.value-adjuster__value')).map((node) => node.textContent);
    expect(values).toEqual(['↑3 °C', '↓2 °C']);

    // Stepping from the shown magnitude stores the normalized sign.
    const increaseReduction = mount.querySelector<HTMLElement>('[aria-label="Increase expensive-hour reduction for Heat pump"]');
    increaseReduction?.click();
    expect(onDeviceExpensiveDeltaChange).toHaveBeenCalledWith('hp', -2.5);
  });
});
