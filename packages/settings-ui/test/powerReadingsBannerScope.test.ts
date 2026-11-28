import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  homeId: 'main',
  readUsagePower: vi.fn(),
  publishSetupPower: vi.fn(),
}));

vi.mock('../src/ui/homeScope.ts', () => ({
  getShownPanelHomeId: () => mocks.homeId,
  getHomeScope: () => ({ areas: [{ homeId: 'rental', name: 'Rental unit' }, { homeId: 'garage', name: 'Garage' }] }),
  subscribeToHomeScope: () => undefined,
}));
vi.mock('../src/ui/homeyEnergyMeter.ts', () => ({
  getChosenWholeHomeMeterName: () => 'Main meter',
  hasChosenWholeHomeMeter: () => true,
}));
vi.mock('../src/ui/planMeasurementSignal.ts', () => ({ getSilentMeterPass: () => null }));
vi.mock('../src/ui/setupPathFacts.ts', () => ({
  isNoReadingsCarriedBySetupPath: () => false,
  publishSetupPower: mocks.publishSetupPower,
}));
vi.mock('../src/ui/usagePowerRead.ts', () => ({ readUsagePower: mocks.readUsagePower }));

const banner = () => document.querySelector<HTMLElement>('#stale-data-banner')!;
const action = () => document.querySelector<HTMLElement>('#stale-data-action')!;
const received = (ageMs: number) => ({ state: 'received' as const, lastPowerUpdateMs: Date.now() - ageMs });
const served = (ageMs: number) => ({ state: 'served', payload: { readings: received(ageMs) } });

beforeEach(() => {
  vi.resetModules();
  mocks.homeId = 'main';
  mocks.readUsagePower.mockReset();
  mocks.publishSetupPower.mockClear();
  document.body.innerHTML = `
    <div id="stale-data-banner" hidden>
      <span id="stale-data-text"></span><button id="stale-data-action"></button>
    </div>`;
});

describe('the no-readings banner follows the shown home', () => {
  it('shows a silent area while Main is fresh and leaves Main setup and navigation independent', async () => {
    const { refreshAreaPowerReadingsBanner, renderPowerReadingsBanner } = await import('../src/ui/powerReadingsBanner.ts');
    renderPowerReadingsBanner(received(2_000), 'homey_energy', false);
    expect(banner().hidden).toBe(true);

    mocks.homeId = 'rental';
    mocks.readUsagePower.mockResolvedValueOnce(served(75_000));
    await refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Last new power reading 1 min ago.');
    expect(banner().textContent).toContain('Check that the meter for Rental unit');
    expect(banner().textContent).not.toContain('PELS');
    expect(action().dataset.settingsTarget).toBe('homes');
    expect(action().dataset.settingsAnchor).toBeUndefined();
    expect(action().dataset.settingsHomeScope).toBeUndefined();
    expect(mocks.publishSetupPower).toHaveBeenCalledExactlyOnceWith({ state: 'received' });

    mocks.readUsagePower.mockResolvedValueOnce({ state: 'unavailable' });
    await refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(false);

    // Main may become stale independently while the area starts reporting again.
    renderPowerReadingsBanner(received(75_000), 'homey_energy', false);
    mocks.readUsagePower.mockResolvedValueOnce(served(2_000));
    await refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(true);
    mocks.homeId = 'main';
    void refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Main meter');
    expect(action().dataset.settingsTarget).toBe('limits');
    expect(action().dataset.settingsAnchor).toBe('#settings-homey-energy-meter');
    expect(action().dataset.settingsHomeScope).toBe('main');
  });

  it('drops a delayed area result after switching away and back', async () => {
    const { refreshAreaPowerReadingsBanner, renderPowerReadingsBanner } = await import('../src/ui/powerReadingsBanner.ts');
    renderPowerReadingsBanner(received(75_000), 'homey_energy', false);
    expect(banner().hidden).toBe(false);

    let resolveDelayed!: (read: ReturnType<typeof served>) => void;
    const delayed = new Promise<ReturnType<typeof served>>((resolve) => { resolveDelayed = resolve; });
    mocks.homeId = 'rental';
    mocks.readUsagePower.mockReturnValueOnce(delayed);
    const oldRental = refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(true);

    mocks.homeId = 'garage';
    mocks.readUsagePower.mockResolvedValueOnce({ state: 'unavailable' });
    await refreshAreaPowerReadingsBanner();
    expect(banner().hidden).toBe(true);

    mocks.homeId = 'rental';
    mocks.readUsagePower.mockResolvedValueOnce(served(2_000));
    await refreshAreaPowerReadingsBanner();
    resolveDelayed(served(75_000));
    await oldRental;
    expect(banner().hidden).toBe(true);
  });
});
