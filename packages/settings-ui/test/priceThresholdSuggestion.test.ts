import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// The priceConfig orchestrator end to end, with the Homey bridge mocked: a fresh
// module per test (`vi.resetModules`) and hoisted mocks that keep their identity.
const homeyMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  callApi: vi.fn(),
  getApiReadModel: vi.fn(),
  invalidateApiCache: vi.fn(),
  primeApiCache: vi.fn(),
  getHomeyTimezone: vi.fn(() => 'UTC'),
}));
vi.mock('../src/ui/homey.ts', () => homeyMocks);
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));
vi.mock('../src/ui/materialWeb.ts', () => ({}));

import { SETTINGS_UI_PRICES_PATH } from '../../contracts/src/settingsUiApi.ts';

const summaryAt = (threshold: number) => ({
  state: 'ready',
  lines: threshold === 25
    ? { average: 75.3, cheapAtOrBelow: 56.5, expensiveFrom: 94.2 }
    : { average: 75.3, cheapAtOrBelow: 68.5, expensiveFrom: 82.1 },
  lowest: 68,
  highest: 79,
  hasCheap: threshold !== 25,
  hasExpensive: false,
  priceUnit: 'øre/kWh',
  suggestion: threshold === 25 ? { kind: 'lower_threshold', percent: 9, cheapUpTo: 68 } : { kind: 'none' },
});

describe('Use the suggested threshold', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('saves it and shows the field and the lines as they are with it', async () => {
    const stored: Record<string, unknown> = { price_scheme: 'norway', price_threshold_percent: 25 };
    (homeyMocks.getSetting as Mock).mockImplementation(async (key: string) => stored[key]);
    (homeyMocks.setSetting as Mock).mockImplementation(async (key: string, value: unknown) => { stored[key] = value; });
    (homeyMocks.getApiReadModel as Mock).mockImplementation(async (path: string) => (
      path === SETTINGS_UI_PRICES_PATH
        ? { combinedPrices: null, priceLevelSummary: summaryAt(stored.price_threshold_percent as number) }
        : null
    ));
    const { initElectricityPricesView } = await import('../src/ui/priceConfig.ts');
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    await initElectricityPricesView(surface);

    const use = Array.from(surface.querySelectorAll('md-outlined-button'))
      .find((button) => button.textContent === 'Use 9 %') as HTMLElement | undefined;
    expect(use).toBeDefined();
    use?.click();

    await vi.waitFor(() => expect(surface.querySelector('#electricity-prices-level-lines')?.textContent)
      .toBe('Cheap at or below 68.50 øre · expensive from 82.10 øre. No expensive prices: the highest is 79.00 øre.'));
    expect(homeyMocks.setSetting).toHaveBeenCalledWith('price_threshold_percent', 9);
    const field = surface.querySelector('[aria-labelledby="electricity-prices-threshold-label"]') as
      (HTMLElement & { value?: string }) | null;
    expect(field?.value ?? field?.getAttribute('value')).toBe('9');
    expect(surface.textContent).not.toContain('Use 9 %');
  });

  it('saves a suggested minimum difference through the same field', async () => {
    // The owner's Norgespris days at 10 % and 10 øre; at 9 øre the nights are cheap.
    const stored: Record<string, unknown> = {
      price_scheme: 'norway', price_threshold_percent: 10, price_min_diff_ore: 10,
    };
    const ownerSummary = (minDiff: number) => ({
      state: 'ready',
      lines: { average: 83.17, cheapAtOrBelow: minDiff === 10 ? 73.17 : 74.17, expensiveFrom: minDiff === 10 ? 93.17 : 92.17 },
      lowest: 73.84,
      highest: 87.84,
      hasCheap: minDiff !== 10,
      hasExpensive: false,
      priceUnit: 'øre/kWh',
      suggestion: minDiff === 10
        ? { kind: 'lower_min_difference', minDifference: 9, cheapUpTo: 73.84 }
        : { kind: 'none' },
    });
    (homeyMocks.getSetting as Mock).mockImplementation(async (key: string) => stored[key]);
    (homeyMocks.setSetting as Mock).mockImplementation(async (key: string, value: unknown) => { stored[key] = value; });
    (homeyMocks.getApiReadModel as Mock).mockImplementation(async (path: string) => (
      path === SETTINGS_UI_PRICES_PATH
        ? { combinedPrices: null, priceLevelSummary: ownerSummary(stored.price_min_diff_ore as number) }
        : null
    ));
    const { initElectricityPricesView } = await import('../src/ui/priceConfig.ts');
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    await initElectricityPricesView(surface);

    const use = Array.from(surface.querySelectorAll('md-outlined-button'))
      .find((button) => button.textContent === 'Use 9 øre') as HTMLElement | undefined;
    expect(use).toBeDefined();
    use?.click();

    await vi.waitFor(() => expect(surface.querySelector('#electricity-prices-level-lines')?.textContent)
      .toBe('Cheap at or below 74.17 øre · expensive from 92.17 øre. No expensive prices: the highest is 87.84 øre.'));
    expect(homeyMocks.setSetting).toHaveBeenCalledWith('price_min_diff_ore', 9);
    expect(homeyMocks.setSetting).not.toHaveBeenCalledWith('price_threshold_percent', expect.anything());
    expect(surface.textContent).not.toContain('Use 9 øre');
  });
});
