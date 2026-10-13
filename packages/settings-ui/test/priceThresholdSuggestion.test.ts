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
      .toBe('High from 82.10 øre, highest 79.00 øre · low up to 68.50 øre'));
    expect(homeyMocks.setSetting).toHaveBeenCalledWith('price_threshold_percent', 9);
    const field = surface.querySelector('[aria-labelledby="electricity-prices-threshold-label"]') as
      (HTMLElement & { value?: string }) | null;
    expect(field?.value ?? field?.getAttribute('value')).toBe('9');
    expect(surface.textContent).not.toContain('Use 9 %');
  });
});
