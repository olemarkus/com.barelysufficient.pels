import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceAwareDevicesViewProps } from '../src/ui/views/PriceAwareDevicesView.tsx';
import type { ElectricityPricesViewProps } from '../src/ui/views/ElectricityPricesView.tsx';
import { PRICE_OPTIMIZATION_ENABLED } from '../../shared-domain/src/settings/settingsKeys.ts';

const mocks = vi.hoisted(() => ({
  setSetting: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  readSettings: vi.fn(),
  render: vi.fn<(surface: HTMLElement, props: PriceAwareDevicesViewProps) => void>(),
  renderElectricity: vi.fn<(surface: HTMLElement, props: ElectricityPricesViewProps) => void>(),
  savePriceSettings: vi.fn<() => Promise<void>>(),
  showToast: vi.fn(),
  showToastError: vi.fn(),
}));
vi.mock('../src/ui/homey.ts', async (original) => ({
  ...await original<typeof import('../src/ui/homey.ts')>(),
  setSetting: mocks.setSetting,
}));
vi.mock('../src/ui/priceConfigSettingsIo.ts', () => ({
  readPriceConfigSettings: mocks.readSettings,
  writePriceOptimizationSettings: vi.fn(),
  validateAndSavePriceSettings: mocks.savePriceSettings,
}));
vi.mock('../src/ui/views/PriceAwareDevicesView.tsx', () => ({ renderPriceAwareDevicesView: mocks.render }));
vi.mock('../src/ui/views/ElectricityPricesView.tsx', () => ({ renderElectricityPricesView: mocks.renderElectricity }));
vi.mock('../src/ui/prices.ts', async (original) => ({
  ...await original<typeof import('../src/ui/prices.ts')>(),
  getPricesReadModel: vi.fn().mockRejectedValue(new Error('Price status unavailable')),
}));
vi.mock('../src/ui/recommendations.ts', () => ({ refreshAfterSetupRecommendations: mocks.refresh }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: mocks.showToast, showToastError: mocks.showToastError }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.setSetting.mockReset().mockResolvedValue(undefined);
  mocks.savePriceSettings.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.readSettings.mockReset().mockResolvedValue({ optimizationEnabled: true });
});

const latest = () => {
  const props = mocks.render.mock.calls.at(-1)?.[1];
  if (!props) throw new Error('Expected price settings view');
  return props;
};
const load = async (enabled = true) => {
  mocks.readSettings.mockResolvedValue({ optimizationEnabled: enabled });
  const controller = await import('../src/ui/priceConfig.ts');
  await controller.initPriceAwareDevicesView(document.createElement('div'));
  return controller;
};

describe('Respond to prices saves', () => {
  it('warns before disabling, and cancellation leaves the saved value on', async () => {
    await load();
    await latest().handlers.onOptimizationToggle(false);
    expect(latest()).toMatchObject({ optimizationEnabled: true, optimizationOffArmed: true });
    expect(mocks.setSetting).not.toHaveBeenCalled();
    latest().handlers.onOptimizationOffDismiss();
    expect(latest()).toMatchObject({ optimizationEnabled: true, optimizationOffArmed: false });
    await latest().handlers.onOptimizationOffConfirm();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('confirms once, holds the saved state during the write, and blocks overlapping input', async () => {
    await load();
    let finish!: () => void;
    mocks.setSetting.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await latest().handlers.onOptimizationToggle(false);
    const saving = latest().handlers.onOptimizationOffConfirm();
    expect(latest()).toMatchObject({ optimizationEnabled: true, optimizationBusy: true, optimizationOffArmed: false });
    await latest().handlers.onOptimizationOffConfirm();
    await latest().handlers.onOptimizationToggle(true);
    expect(mocks.setSetting).toHaveBeenCalledExactlyOnceWith(PRICE_OPTIMIZATION_ENABLED, false);
    finish();
    await saving;
    expect(latest()).toMatchObject({ optimizationEnabled: false, optimizationBusy: false });
    expect(mocks.showToast).toHaveBeenCalledWith('Respond to prices turned off.', 'ok');
    // A later request must be armed again; no prior confirmation is retained.
    await latest().handlers.onOptimizationToggle(true);
    await latest().handlers.onOptimizationOffConfirm();
    expect(latest().optimizationEnabled).toBe(true);
    expect(mocks.setSetting).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('preserves the saved state %s when the write fails', async (enabled) => {
    await load(enabled);
    mocks.setSetting.mockRejectedValueOnce(new Error('offline'));
    await latest().handlers.onOptimizationToggle(!enabled);
    if (enabled) await latest().handlers.onOptimizationOffConfirm();
    expect(latest()).toMatchObject({ optimizationEnabled: enabled, optimizationBusy: false, optimizationOffArmed: false });
    expect(mocks.showToastError).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('keeps a successful save when its follow-up refresh fails', async () => {
    await load();
    mocks.refresh.mockRejectedValueOnce(new Error('refresh unavailable'));
    await latest().handlers.onOptimizationToggle(false);
    await latest().handlers.onOptimizationOffConfirm();
    expect(latest()).toMatchObject({ optimizationEnabled: false, optimizationBusy: false });
    expect(mocks.showToastError).not.toHaveBeenCalled();
  });

  it('enables without confirmation', async () => {
    await load(false);
    await latest().handlers.onOptimizationToggle(true);
    expect(mocks.setSetting).toHaveBeenCalledExactlyOnceWith(PRICE_OPTIMIZATION_ENABLED, true);
    expect(latest()).toMatchObject({ optimizationEnabled: true, optimizationOffArmed: false });
    expect(mocks.showToast).toHaveBeenCalledWith('Respond to prices turned on.', 'ok');
  });

  it('merges unrelated settings from an earlier read without reverting a successful toggle save', async () => {
    const controller = await load();
    await controller.initElectricityPricesView(document.createElement('div'));
    let finishRead!: (patch: { optimizationEnabled: boolean; providerSurcharge: number }) => void;
    mocks.readSettings.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const reloading = controller.reloadPriceConfigSettings();
    await latest().handlers.onOptimizationToggle(false);
    await latest().handlers.onOptimizationOffConfirm();
    finishRead({ optimizationEnabled: true, providerSurcharge: 7 });
    await reloading;

    expect(latest().optimizationEnabled).toBe(false);
    const prices = mocks.renderElectricity.mock.calls.at(-1)![1];
    expect(prices.config.providerSurcharge).toBe(7);
    await prices.handlers.onMinDiffChange(5);
    expect(mocks.savePriceSettings).toHaveBeenCalledWith(expect.objectContaining({
      optimizationEnabled: false, providerSurcharge: 7, minDiffOre: 5,
    }));
  });

  it('keeps latest-read ordering when overlapping reads straddle a successful toggle save', async () => {
    const controller = await load();
    await controller.initElectricityPricesView(document.createElement('div'));
    let finishOlder!: (patch: { optimizationEnabled: boolean; providerSurcharge: number }) => void;
    let finishNewest!: (patch: { optimizationEnabled: boolean; providerSurcharge: number }) => void;
    mocks.readSettings
      .mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewest = resolve; }));
    const older = controller.reloadPriceConfigSettings();
    await latest().handlers.onOptimizationToggle(false);
    await latest().handlers.onOptimizationOffConfirm();
    const newest = controller.reloadPriceConfigSettings();
    finishNewest({ optimizationEnabled: false, providerSurcharge: 9 });
    await newest;
    finishOlder({ optimizationEnabled: true, providerSurcharge: 3 });
    await older;

    expect(latest().optimizationEnabled).toBe(false);
    const prices = mocks.renderElectricity.mock.calls.at(-1)![1];
    expect(prices.config.providerSurcharge).toBe(9);
    await prices.handlers.onMinDiffChange(6);
    expect(mocks.savePriceSettings).toHaveBeenCalledWith(expect.objectContaining({
      optimizationEnabled: false, providerSurcharge: 9, minDiffOre: 6,
    }));
  });

  it('keeps confirmation armed when the page repaints in the background', async () => {
    const controller = await load();
    await latest().handlers.onOptimizationToggle(false);
    controller.renderPriceConfigDevices();
    expect(latest()).toMatchObject({ optimizationEnabled: true, optimizationOffArmed: true });
  });
});
