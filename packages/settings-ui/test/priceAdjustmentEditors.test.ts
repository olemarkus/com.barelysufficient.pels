import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceAwareDevicesViewProps } from '../src/ui/views/PriceAwareDevicesView.tsx';

const mocks = vi.hoisted(() => ({
  write: vi.fn<() => Promise<void>>(),
  render: vi.fn<(surface: HTMLElement, props: PriceAwareDevicesViewProps) => void>(),
  savePatch: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/ui/priceConfigSettingsIo.ts', () => ({
  readPriceConfigSettings: async () => ({}),
  writePriceOptimizationSettings: mocks.write,
  validateAndSavePriceSettings: vi.fn(),
}));
vi.mock('../src/ui/views/PriceAwareDevicesView.tsx', () => ({ renderPriceAwareDevicesView: mocks.render }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/devices.ts', () => ({ renderDevices: vi.fn() }));
vi.mock('../src/ui/deviceDetail/temperaturePolicy.ts', () => ({
  supportsTemperatureAdjustments: () => true,
  temperatureAdjustmentGateHint: () => '',
}));
vi.mock('../src/ui/deviceDetail/priceOptimizationPatch.ts', () => ({ savePriceOptimizationPatch: mocks.savePatch }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.write.mockReset().mockResolvedValue(undefined);
  document.body.replaceChildren();
});

const loadPrices = async () => {
  const { state, defaultPriceOptimizationConfig } = await import('../src/ui/state.ts');
  state.priceOptimizationSettings = { heater: { ...defaultPriceOptimizationConfig, priceConfigured: true } };
  const { initPriceAwareDevicesView } = await import('../src/ui/priceConfig.ts');
  await initPriceAwareDevicesView(document.createElement('div'));
  const props = mocks.render.mock.calls.at(-1)?.[1];
  if (!props) throw new Error('Expected price editor to render');
  return { state, change: props.handlers.onDevicePriceAdjustmentChange };
};

describe('Prices adjustment writes', () => {
  it.each([0, 0.5, 20])('encodes both adjustment kinds at magnitude %s', async (size) => {
    const { state, change } = await loadPrices();
    await change('heater', 'cheap_hour_boost', size);
    await change('heater', 'expensive_hour_reduction', size);
    expect(state.priceOptimizationSettings.heater.cheapDelta).toBe(size);
    expect(state.priceOptimizationSettings.heater.expensiveDelta).toBe(size === 0 ? 0 : -size);
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 20.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid magnitude %s without saving', async (size) => {
    const { state, change } = await loadPrices();
    const before = { ...state.priceOptimizationSettings.heater };
    await change('heater', 'expensive_hour_reduction', size);
    expect(state.priceOptimizationSettings.heater).toEqual(before);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each(['same field', 'other field'] as const)('keeps a newer successful %s edit when an older save fails', async (overlap) => {
    const { state, change } = await loadPrices();
    let rejectFirst!: (error: Error) => void;
    mocks.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    const first = change('heater', 'expensive_hour_reduction', 2);
    await change('heater', overlap === 'same field' ? 'expensive_hour_reduction' : 'cheap_hour_boost', 3);
    rejectFirst(new Error('failed'));
    await first;
    expect(state.priceOptimizationSettings.heater).toMatchObject({
      cheapDelta: overlap === 'other field' ? 3 : 5,
      expensiveDelta: overlap === 'same field' ? -3 : -5,
      priceConfigured: true,
    });
  });
});

describe('detail adjustment input boundary', () => {
  it.each([
    ['-3', 3, -3], ['0', 0, 0], ['0.5', 0.5, -0.5], ['20', 20, -20],
    ['21', 5, -5], ['-21', 5, -5], ['', 5, -5], ['invalid', 5, -5],
  ])('encodes input %s using magnitudes and the existing invalid-input fallback', async (input, cheap, expensive) => {
    document.body.innerHTML = '<input id="device-detail-cheap-delta"><input id="device-detail-expensive-delta">';
    const cheapInput = document.querySelector<HTMLInputElement>('#device-detail-cheap-delta')!;
    const expensiveInput = document.querySelector<HTMLInputElement>('#device-detail-expensive-delta')!;
    const { initDeviceDetailPriceOptHandlers } = await import('../src/ui/deviceDetail/priceOpt.ts');
    initDeviceDetailPriceOptHandlers({ getCurrentDetailDeviceId: () => 'heater' });
    cheapInput.value = String(input);
    expensiveInput.value = String(input);
    cheapInput.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(mocks.savePatch).toHaveBeenCalledWith('heater', expect.objectContaining({
      cheapDelta: cheap, expensiveDelta: expensive,
    }), expect.anything(), expect.any(String), expect.any(Function));
  });
});
