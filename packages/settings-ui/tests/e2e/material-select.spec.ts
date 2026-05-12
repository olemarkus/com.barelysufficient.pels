import { expect, test, type Page } from './fixtures/test';
import type { Locator } from '@playwright/test';

const openSettingsSection = async (page: Page, target: string) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator(`[data-settings-target="${target}"]`).click();
};

const isSelectOpen = async (select: Locator): Promise<boolean> => (
  select.evaluate((el) => Boolean((el as HTMLElement & { open?: boolean }).open))
);

const readNormalizedSelectTheme = async (select: Locator) => (
  select.evaluate((el) => {
    const normalizeColor = (value: string, fallback: string) => {
      const probe = document.createElement('div');
      probe.style.color = value || fallback;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color.replace(/\s+/g, '');
      probe.remove();
      return color;
    };

    const styles = getComputedStyle(el);
    const rootStyles = getComputedStyle(document.documentElement);
    const menu = styles.getPropertyValue('--md-menu-container-color').trim();
    const container = styles.getPropertyValue('--md-menu-item-container-color').trim();
    const text = styles.getPropertyValue('--md-menu-item-label-text-color').trim();
    const selected = styles.getPropertyValue('--md-menu-item-selected-container-color').trim();
    return {
      hasMenuOverride: menu.length > 0,
      hasContainerOverride: container.length > 0,
      hasTextOverride: text.length > 0,
      hasSelectedOverride: selected.length > 0,
      menu: normalizeColor(menu, rootStyles.getPropertyValue('--pels-surface-container-highest').trim()),
      container: normalizeColor(container, rootStyles.getPropertyValue('--pels-surface-container-highest').trim()),
      text: normalizeColor(text, rootStyles.getPropertyValue('--text').trim()),
      selected: normalizeColor(selected, rootStyles.getPropertyValue('--color-surface-3').trim()),
      expectedMenu: normalizeColor(
        rootStyles.getPropertyValue('--pels-surface-container-highest').trim(),
        'rgba(255, 255, 255, 0.12)',
      ),
      expectedText: normalizeColor(
        rootStyles.getPropertyValue('--text').trim(),
        '#e6ecf5',
      ),
      expectedSelected: normalizeColor(
        rootStyles.getPropertyValue('--color-surface-3').trim(),
        'rgba(255, 255, 255, 0.06)',
      ),
    };
  })
);

test.describe('Material select menus', () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test('keeps settings dropdown open and readable on desktop', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await openSettingsSection(page, 'electricity-prices');

    const sourceSelect = page.locator('#price-source-select');
    await expect(sourceSelect).toBeVisible();

    await sourceSelect.click();
    await expect.poll(() => isSelectOpen(sourceSelect)).toBe(true);
    await page.waitForTimeout(300);
    await expect.poll(() => isSelectOpen(sourceSelect)).toBe(true);

    const optionTheme = await readNormalizedSelectTheme(sourceSelect);

    expect(optionTheme).toEqual({
      menu: optionTheme.expectedMenu,
      container: optionTheme.expectedMenu,
      text: optionTheme.expectedText,
      selected: optionTheme.expectedSelected,
      hasMenuOverride: true,
      hasContainerOverride: true,
      hasTextOverride: true,
      hasSelectedOverride: true,
      expectedMenu: optionTheme.expectedMenu,
      expectedText: optionTheme.expectedText,
      expectedSelected: optionTheme.expectedSelected,
    });
  });
});
