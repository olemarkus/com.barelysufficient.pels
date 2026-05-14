import { expect, test, type Page } from './fixtures/test';

const openSettingsSection = async (page: Page, target: string) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const sectionButton = page.locator(`[data-settings-target="${target}"]`);
  await expect(sectionButton).toBeVisible();
  await sectionButton.scrollIntoViewIfNeeded();
  await sectionButton.click();
};

const readAccessibleName = async (page: Page, selector: string): Promise<string> => {
  await expect(page.locator(selector)).toHaveCount(1);
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return '';
    const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
    if (ariaLabel.length > 0) return ariaLabel;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter((value) => value.length > 0)
        .join(' ');
      if (text.length > 0) return text;
    }
    const internalLabel = (el as HTMLElement & { label?: string }).label;
    if (typeof internalLabel === 'string' && internalLabel.trim().length > 0) {
      return internalLabel.trim();
    }
    return '';
  }, selector);
};

const expectAccessibleName = async (page: Page, selector: string) => {
  const name = await readAccessibleName(page, selector);
  expect(name, `expected an accessible name for ${selector}`).not.toBe('');
};

test.describe('Settings form controls expose accessible names', () => {
  test('every visible settings input resolves a non-empty accessible name', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('#settings-panel')).toBeVisible();

    await expectAccessibleName(page, '#active-mode-select');

    await openSettingsSection(page, 'limits');
    await expect(page.locator('#limits-panel')).toBeVisible();
    await expectAccessibleName(page, '#settings-capacity-limit');
    await expectAccessibleName(page, '#settings-capacity-margin');
    await expectAccessibleName(page, '#settings-power-source');

    await openSettingsSection(page, 'simulation');
    await expect(page.locator('#simulation-panel')).toBeVisible();
    await expectAccessibleName(page, '#settings-simulation-mode');

    await openSettingsSection(page, 'advanced');
    await expect(page.locator('#advanced-panel')).toBeVisible();
    const dailyBudgetSection = page.locator('details:has(#daily-budget-controlled-weight)');
    await dailyBudgetSection.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await expectAccessibleName(page, '#daily-budget-controlled-weight');
    await expectAccessibleName(page, '#daily-budget-price-flex-share');
    await expectAccessibleName(page, '#daily-budget-breakdown');

    const deviceCleanupSection = page.locator('details:has(#advanced-device-select)');
    await deviceCleanupSection.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await expectAccessibleName(page, '#advanced-device-select');

    const deviceLogSection = page.locator('details:has(#advanced-api-device-select)');
    await deviceLogSection.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await expectAccessibleName(page, '#advanced-api-device-select');
  });
});
