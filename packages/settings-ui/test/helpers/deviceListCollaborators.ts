import { vi } from 'vitest';

/**
 * Stand in for the settings UI modules the device list calls out to but a
 * device list spec is not about: the priority render, the price-optimization
 * panel, the plan refresh, toasts and logging. Call it before the spec imports
 * the list.
 */
export const mockDeviceListCollaborators = (): void => {
  vi.doMock('../../src/ui/modes.ts', () => ({
    renderPriorities: vi.fn(),
  }));
  vi.doMock('../../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../../src/ui/plan.ts', () => ({
    refreshPlan: vi.fn(),
  }));
  vi.doMock('../../src/ui/toast.ts', () => ({
    showToast: vi.fn().mockResolvedValue(undefined),
    showToastError: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../../src/ui/logging.ts', () => ({
    logSettingsError: vi.fn().mockResolvedValue(undefined),
    logSettingsWarn: vi.fn().mockResolvedValue(undefined),
  }));
};
