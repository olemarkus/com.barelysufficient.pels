import { beforeEach, describe, expect, it, vi } from 'vitest';

// The detail panels save price-optimization fields optimistically; a failed
// write rolls back only the fields that save patched, so an overlapping save of
// other fields that landed meanwhile survives the rollback.
const pricePatch = { enabled: true, cheapDelta: 3, expensiveDelta: -3, priceConfigured: true };
const surplusPatch = { surplusWilling: true, surplusDelta: 2 };

const loadPatchSave = async (save: () => Promise<void>) => {
  vi.doMock('../src/ui/priceOptimization.ts', () => ({ savePriceOptimizationSettings: save }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('../src/ui/toast.ts', () => ({ showToastError: vi.fn().mockResolvedValue(undefined) }));
  const { state, defaultPriceOptimizationConfig } = await import('../src/ui/state.ts');
  const { savePriceOptimizationPatch } = await import('../src/ui/deviceDetail/priceOptimizationPatch.ts');
  state.priceOptimizationSettings = {};
  return { state, defaultPriceOptimizationConfig, savePriceOptimizationPatch };
};

describe('savePriceOptimizationPatch rollback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps an overlapping successful edit when a save that created the entry fails', async () => {
    let failFirstWrite: (error: Error) => void = () => undefined;
    const save = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirstWrite = reject; }))
      .mockResolvedValueOnce(undefined);
    const { state, defaultPriceOptimizationConfig, savePriceOptimizationPatch } = await loadPatchSave(save);

    const priceSave = savePriceOptimizationPatch(
      'heater', pricePatch, defaultPriceOptimizationConfig, 'Failed to save price optimization settings', () => undefined,
    );
    expect(await savePriceOptimizationPatch(
      'heater', surplusPatch, defaultPriceOptimizationConfig, 'Failed to save solar surplus settings', () => undefined,
    )).toBe(true);
    failFirstWrite(new Error('write failed'));

    expect(await priceSave).toBe(false);
    expect(state.priceOptimizationSettings.heater).toEqual({ ...defaultPriceOptimizationConfig, ...surplusPatch });
  });

  it('removes an entry the failed save created when nothing else changed it', async () => {
    const save = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('write failed'));
    const { state, defaultPriceOptimizationConfig, savePriceOptimizationPatch } = await loadPatchSave(save);

    expect(await savePriceOptimizationPatch(
      'heater', pricePatch, defaultPriceOptimizationConfig, 'Failed to save price optimization settings', () => undefined,
    )).toBe(false);
    expect(state.priceOptimizationSettings).toEqual({});
  });
});
