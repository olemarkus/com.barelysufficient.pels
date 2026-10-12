import { vi, type Mock } from 'vitest';

type DeviceDetailCollaboratorSpies = {
  showToastError?: Mock;
  logSettingsError?: Mock;
};

/**
 * Stand in for the settings UI modules the device detail panel calls out to
 * but a device detail spec is not about: the device list and priority renders,
 * the price-optimization panel, toasts and error logging. Call it before the
 * spec imports the panel. A spec that asserts on the error toast or the error
 * log passes its own spy.
 */
export const mockDeviceDetailCollaborators = (spies: DeviceDetailCollaboratorSpies = {}): void => {
  vi.doMock('../../src/ui/devices.ts', () => ({
    renderDevices: vi.fn(),
  }));
  vi.doMock('../../src/ui/modes.ts', () => ({
    renderPriorities: vi.fn(),
  }));
  vi.doMock('../../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../../src/ui/toast.ts', () => ({
    showToast: vi.fn().mockResolvedValue(undefined),
    showToastError: spies.showToastError ?? vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../../src/ui/logging.ts', () => ({
    logSettingsError: spies.logSettingsError ?? vi.fn().mockResolvedValue(undefined),
  }));
};
