import { expect, test, type Page } from './fixtures/test';

const SWITCH_NAME = 'Avoid paying to export with Roof inverter';

const openSettings = async (page: Page) => {
  await page.addInitScript(() => {
    const win = window as unknown as { __PELS_HOMEY_STUB__: {
      settings: Record<string, unknown>; apiHandlers: Record<string, () => unknown>;
    } };
    win.__PELS_HOMEY_STUB__ = {
      settings: { export_price_enabled: true },
      apiHandlers: { 'GET /ui_devices': () => ({
        devices: [], inverterDevices: [{ id: 'pv', name: 'Roof inverter' }],
        chargerPhasePresets: { state: 'resolved', presets: {} }, hasManagedSolarDevice: true,
      }) },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="electricity-prices"]').click();
  await expect(page.getByRole('heading', { name: 'Avoid paying to export' })).toBeVisible();
};

const selection = (page: Page) => page.evaluate(() => new Promise<unknown>((resolve, reject) => {
  const homey = (window as unknown as { Homey: {
    get(key: string, callback: (error: Error | null, value?: unknown) => void): void;
  } }).Homey;
  homey.get('inverter_curtailment_devices', (error, value) => error ? reject(error) : resolve(value));
}));

test('native curtailment is opt-in and persists the selected inverter', async ({ page }) => {
  await openSettings(page);
  const toggle = page.getByRole('switch', { name: SWITCH_NAME });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => selection(page)).toEqual({ pv: true });
  await expect(toggle).toBeChecked();
  await page.evaluate(() => {
    const stub = (window as unknown as { Homey: { __stub: {
      setSetting(key: string, value: unknown): void; emitSettingsSet(key: string): void;
    } } }).Homey.__stub;
    stub.setSetting('inverter_curtailment_devices', { pv: false });
    stub.emitSettingsSet('inverter_curtailment_devices');
  });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => selection(page)).toEqual({ pv: true });
  await toggle.click();
  await expect.poll(() => selection(page)).toEqual({ pv: false });
});
