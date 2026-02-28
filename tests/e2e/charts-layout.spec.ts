import { expect, test, type Page } from '@playwright/test';

type LayoutIssue = {
  selector: string;
  index: number;
  left: number;
  right: number;
  panelLeft: number;
  panelRight: number;
  viewportWidth: number;
  scrollWidth: number;
  clientWidth: number;
};

const collectLayoutIssues = async (
  page: Page,
  panelSelector: string,
  selectors: string[],
): Promise<LayoutIssue[]> => (
  page.evaluate(({ panelSelector: targetPanel, selectors: targetSelectors }) => {
    const panel = document.querySelector(targetPanel);
    if (!(panel instanceof HTMLElement)) return [];

    const panelRect = panel.getBoundingClientRect();
    const minLeft = Math.max(0, panelRect.left);
    const maxRight = Math.min(window.innerWidth, panelRect.right);
    return targetSelectors.flatMap((selector) => (
      Array.from(document.querySelectorAll(selector)).flatMap((node, index) => {
        if (!(node instanceof HTMLElement)) return [];
        const style = getComputedStyle(node);
        const hidden = node.hidden || style.display === 'none' || style.visibility === 'hidden';
        if (hidden || node.getClientRects().length === 0) return [];

        const rect = node.getBoundingClientRect();
        const spillsOutsidePanel = rect.left < (minLeft - 1) || rect.right > (maxRight + 1);
        const overflowX = style.overflowX;
        const overflow = style.overflow;
        const ignoreInternalOverflow = (
          overflowX === 'hidden'
          || overflowX === 'clip'
          || overflow === 'hidden'
          || overflow === 'clip'
        );
        const hasInternalOverflow = !ignoreInternalOverflow && node.scrollWidth > (node.clientWidth + 1);
        if (!spillsOutsidePanel && !hasInternalOverflow) return [];

        return [{
          selector,
          index,
          left: Number(rect.left.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          panelLeft: Number(minLeft.toFixed(2)),
          panelRight: Number(maxRight.toFixed(2)),
          viewportWidth: window.innerWidth,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        }];
      })
    ));
  }, { panelSelector, selectors })
);

test.describe('Settings UI chart layout', () => {
  const assertChartsWithinPanel = async (page: Page) => {
    await page.goto('/settings/index.html', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Control center' })).toBeVisible();

    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#daily-budget-chart')).toBeVisible();
    await expect(page.locator('#daily-budget-bars')).toBeVisible();

    const budgetIssues = await collectLayoutIssues(page, '#budget-panel', [
      '#daily-budget-chart',
      '#daily-budget-bars',
      '#daily-budget-labels',
    ]);
    expect(
      budgetIssues,
      `Budget chart layout overflow: ${JSON.stringify(budgetIssues)}`,
    ).toEqual([]);

    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();
    await expect(page.locator('#usage-day-chart')).toBeVisible();
    await expect(page.locator('#usage-day-bars svg').first()).toBeVisible();
    await expect(page.locator('#hourly-pattern-toggle-all')).toBeVisible();
    await expect(page.locator('#hourly-pattern-toggle-weekday')).toBeVisible();
    await expect(page.locator('#hourly-pattern-toggle-weekend')).toBeVisible();
    await expect(page.locator('#hourly-pattern svg').first()).toBeVisible();
    await page.locator('#hourly-pattern-toggle-weekday').click();
    await expect(page.locator('#hourly-pattern svg').first()).toBeVisible();
    await page.locator('#hourly-pattern-toggle-weekend').click();
    await expect(page.locator('#hourly-pattern svg').first()).toBeVisible();
    await page.locator('#hourly-pattern-toggle-all').click();
    await expect(page.locator('#hourly-pattern svg').first()).toBeVisible();

    const dailyHistoryDetail = page.locator('details:has(#daily-list)');
    await dailyHistoryDetail.locator('summary').click();
    await expect(dailyHistoryDetail).toHaveAttribute('open', '');
    await expect(page.locator('#daily-history-range-7')).toBeVisible();
    await expect(page.locator('#daily-history-range-14')).toBeVisible();
    await page.locator('#daily-history-range-7').click();
    await expect(page.locator('#daily-list svg').first()).toBeVisible();
    await page.locator('#daily-history-range-14').click();
    await expect(page.locator('#daily-list svg').first()).toBeVisible();

    const hourlyDetail = page.locator('details:has(#power-list)');
    await hourlyDetail.locator('summary').click();
    await expect(hourlyDetail).toHaveAttribute('open', '');
    await expect(page.locator('#power-list .usage-row').first()).toBeVisible();

    const usageIssues = await collectLayoutIssues(page, '#usage-panel', [
      '#usage-day-chart',
      '#usage-day-bars',
      '#usage-day-labels',
      '#hourly-pattern',
      '#power-list .usage-row',
      '#power-list .usage-row__bar',
      '#power-list .usage-bar',
    ]);
    expect(
      usageIssues,
      `Usage chart layout overflow: ${JSON.stringify(usageIssues)}`,
    ).toEqual([]);
  };

  test('keeps budget and usage graphs inside panel width at 480px', async ({ page }) => {
    await assertChartsWithinPanel(page);
  });

  test('keeps budget and usage graphs inside panel width at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await assertChartsWithinPanel(page);
  });
});
