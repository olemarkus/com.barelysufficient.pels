import { expect, test, type Page } from './fixtures/test';

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
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();

    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#budget-redesign-chart')).toBeVisible();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    const budgetIssues = await collectLayoutIssues(page, '#budget-panel', [
      '#budget-redesign-chart',
      '#budget-plan-summary',
      '#budget-redesign-chart svg',
    ]);
    expect(
      budgetIssues,
      `Budget chart layout overflow: ${JSON.stringify(budgetIssues)}`,
    ).toEqual([]);

    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();
    await expect(page.locator('#usage-day-chart')).toBeVisible();
    await expect(page.locator('#usage-day-bars svg').first()).toBeVisible();
    await expect(page.locator('#hourly-pattern svg').first()).toBeVisible();

    await expect(page.locator('#daily-list svg').first()).toBeVisible();

    // Detailed hourly view is collapsed by default per the spec; expand it before
    // asserting the inner chart renders and stays within panel width.
    await page.locator('#usage-detail-section summary').click();
    await expect(page.locator('#power-list svg').first()).toBeVisible();

    const usageIssues = await collectLayoutIssues(page, '#usage-panel', [
      '#usage-day-chart',
      '#usage-day-bars',
      '#usage-day-labels',
      '#hourly-pattern',
      '#power-list svg',
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

  test('budget chart SVG matches container width after tab switch', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();

    // Prime the budget chart so it has been rendered once at hidden width.
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    // Switch away and back so the panel toggles `display:none` → visible.
    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    // Allow the tab-shown handler's rAF + ECharts resize to flush.
    await page.waitForFunction(() => {
      const container = document.querySelector('#budget-redesign-chart');
      const svg = container?.querySelector('svg');
      if (!container || !svg) return false;
      const containerWidth = (container as HTMLElement).clientWidth;
      const svgWidth = Number.parseFloat(svg.getAttribute('width') ?? '0');
      return containerWidth > 0 && Math.abs(svgWidth - containerWidth) <= 1;
    });
  });

  test('budget legend swatches match rendered series fills', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    // The Background/Managed split swatches only render in the hourly-plan
    // view; the default `progress` view renders a single combined Plan
    // series. Switch to Hourly plan so the parity check actually exercises
    // the split colours this PR introduces.
    await page.locator('#budget-panel .day-view-toggle__button').filter({ hasText: 'Hourly plan' }).click();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    // The legend swatches above the chart are CSS-token-driven. They must
    // resolve to the same colour values that the chart palette resolves to
    // from `--day-view-color-background-usage`, `--day-view-color-managed-usage`,
    // and `--pels-chart-plan`. We compare via CSS variable lookups on the
    // budget panel so we never reintroduce a hex fallback contract.
    const parity = await page.evaluate(() => {
      const panel = document.querySelector('#budget-panel');
      if (!panel) return { ok: false, reason: 'no panel' } as const;
      const swatches = Array.from(panel.querySelectorAll<HTMLElement>('.budget-chart-legend__swatch'));
      if (swatches.length === 0) return { ok: false, reason: 'no swatches' } as const;
      // Every swatch must show *some* colour, either via `background-color`
      // (filled markers like Plan/Actual/Background/Managed) or via
      // `border-top-color` (line markers like Projection/Price). Empty values
      // are the regression we are guarding against — the legend would
      // otherwise render invisible while the series renders with real colour.
      const isOpaque = (value: string): boolean => {
        const v = value.trim();
        return v.length > 0 && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent';
      };
      const offenders: string[] = [];
      for (const swatch of swatches) {
        const style = getComputedStyle(swatch);
        const hasFill = isOpaque(style.backgroundColor);
        const hasBorder = style.borderTopWidth !== '0px' && isOpaque(style.borderTopColor);
        if (!hasFill && !hasBorder) offenders.push(swatch.className);
      }
      return { ok: offenders.length === 0, offenders, swatchCount: swatches.length } as const;
    });
    expect(parity.ok, `Legend swatches missing colour: ${JSON.stringify(parity)}`).toBe(true);
  });

  test('deadline-plan horizon chart labels the price axis with a unit', async ({ page }) => {
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('#deadline-plan-panel');
    await expect(panel.locator('.deadline-horizon-chart svg')).toBeVisible();
    const axisText = await panel.locator('.deadline-horizon-chart svg').evaluate((svg) => svg.textContent ?? '');
    expect(
      axisText.includes('øre/kWh') || axisText.includes('kr/kWh'),
      `Price axis should display unit, got: ${axisText.slice(0, 200)}`,
    ).toBe(true);
  });
});
