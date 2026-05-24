import { expect, test, type Page } from './fixtures/test';

const openApp = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
};

const openTopTab = async (page: Page, name: string) => {
  await page.getByRole('tab', { name }).click();
};

const openSettingsSection = async (page: Page, target: string) => {
  await openTopTab(page, 'Settings');
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator(`.settings-nav-card[data-settings-target="${target}"]`).click();
};

const expectNoHorizontalOverflow = async (page: Page, label: string) => {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const viewportWidth = root.clientWidth;
    const scrollWidth = root.scrollWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .filter((el) => {
        if (el instanceof SVGElement) return false;
        if (el.hidden || getComputedStyle(el).display === 'none') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right > viewportWidth + 1;
      })
      .slice(0, 5)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        className: el.className.toString(),
        right: Math.round(el.getBoundingClientRect().right),
      }));
    return {
      viewportWidth,
      scrollWidth,
      delta: scrollWidth - viewportWidth,
      offenders,
    };
  });
  expect(overflow.delta, `${label} overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1);
};

test.describe('settings shell layout regressions', () => {
  // Lock in the a11y-tree invariant: each top destination must be reachable
  // exactly once. The TODO entry (~line 1899) suspected a hidden mobile-nav
  // surface duplicated tabs at narrow widths; a CDP / getByRole audit at
  // 320 px and 480 px found a single `md-tabs` shell and zero duplicates, so
  // this test pins that contract in case a future mobile-nav redesign adds a
  // second surface without hiding the inactive one from assistive tech.
  const TAB_DESTINATIONS = ['Overview', 'Budget', 'Usage', 'Smart tasks', 'Settings'] as const;
  for (const width of [320, 480] as const) {
    test(`exposes each top-nav destination exactly once in the a11y tree at ${width}px`, async ({ page }) => {
      await openApp(page, width);
      await expect(page.getByRole('tablist', { name: 'PELS settings sections' })).toBeVisible();
      for (const name of TAB_DESTINATIONS) {
        await expect(
          page.getByRole('tab', { name, exact: true }),
          `tab "${name}" must appear exactly once at ${width}px`,
        ).toHaveCount(1);
      }
    });
  }

  test('keeps redesigned shell navigation compact at 320px', async ({ page }) => {
    await openApp(page, 320);
    const tabMetrics = await page.getByRole('tablist', { name: 'PELS settings sections' }).locator('[role="tab"]')
      .evaluateAll((tabs) => tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        const renderedText = tab.textContent?.trim() ?? '';
        return {
          text: renderedText,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          // Scroll width > client width signals the label is being clipped
          // by overflow:hidden; the 320 px shell must not truncate labels.
          scrollWidth: tab.scrollWidth,
          clientWidth: tab.clientWidth,
        };
      }));

    expect(tabMetrics.map((tab) => tab.text)).toEqual(['Overview', 'Budget', 'Usage', 'Smart tasks', 'Settings']);
    // Width bound is unchanged. Height bound rises to 72 px because
    // "Smart tasks" wraps to two lines at 320 px — the wrap is the explicit
    // remedy for the previous ellipsis-truncation regression. Touch target
    // still ≥ 48 px via the tab container token.
    expect(
      tabMetrics.every((tab) => tab.width <= 116 && tab.height <= 72 && tab.height >= 48),
      JSON.stringify(tabMetrics),
    ).toBe(true);
    expect(
      tabMetrics.every((tab) => tab.scrollWidth <= tab.clientWidth + 1),
      `tab labels must not be horizontally clipped: ${JSON.stringify(tabMetrics)}`,
    ).toBe(true);
    await expectNoHorizontalOverflow(page, '320px shell nav');
  });

  const appPages: Array<{ label: string; open: (page: Page) => Promise<void> }> = [
    { label: 'Overview', open: (page) => openTopTab(page, 'Overview') },
    { label: 'Budget', open: (page) => openTopTab(page, 'Budget') },
    { label: 'Usage', open: (page) => openTopTab(page, 'Usage') },
    { label: 'Settings', open: (page) => openTopTab(page, 'Settings') },
    { label: 'Devices', open: (page) => openSettingsSection(page, 'devices') },
    { label: 'Prices', open: (page) => openSettingsSection(page, 'electricity-prices') },
    { label: 'Advanced', open: (page) => openSettingsSection(page, 'advanced') },
  ];

  for (const appPage of appPages) {
    test(`keeps ${appPage.label} within 320px without horizontal overflow`, async ({ page }) => {
      await openApp(page, 320);
      await appPage.open(page);
      await expectNoHorizontalOverflow(page, appPage.label);
    });
  }

  test('keeps the deadline-plan close button within the viewport at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('#deadline-plan-panel');
    await expect(panel.locator('[data-deadline-plan-close]')).toBeVisible();
    const box = await page.evaluate(() => {
      const close = document.querySelector<HTMLElement>('[data-deadline-plan-close]')?.getBoundingClientRect();
      return close ? { left: close.left, right: close.right, top: close.top, bottom: close.bottom } : null;
    });
    expect(box).not.toBeNull();
    expect(box!.left).toBeGreaterThanOrEqual(0);
    expect(box!.right).toBeLessThanOrEqual(320);
    expect(box!.top).toBeGreaterThanOrEqual(0);
    await expectNoHorizontalOverflow(page, 'Deadline plan');
  });

  test('keeps banned planner terminology out of normal redesigned UI copy', async ({ page }) => {
    await openApp(page, 480);
    const surfaces: Array<{ label: string; open: (page: Page) => Promise<void>; selector: string }> = [
      { label: 'Overview', open: (p) => openTopTab(p, 'Overview'), selector: '#overview-panel' },
      { label: 'Budget', open: (p) => openTopTab(p, 'Budget'), selector: '#budget-panel' },
      { label: 'Usage', open: (p) => openTopTab(p, 'Usage'), selector: '#usage-panel' },
      { label: 'Devices', open: (p) => openSettingsSection(p, 'devices'), selector: '#devices-panel' },
      { label: 'Prices', open: (p) => openSettingsSection(p, 'electricity-prices'), selector: '#electricity-prices-panel' },
    ];
    const banned = /\b(headroom|shed|restore|soft limit|controlled|uncontrolled|shortfall|backoff|invariant)\b/i;
    const findings: Array<{ label: string; match: string }> = [];

    for (const surface of surfaces) {
      await surface.open(page);
      const surfaceLocator = page.locator(surface.selector);
      await expect(surfaceLocator).toBeVisible();
      const text = await surfaceLocator.innerText();
      const match = text.match(banned)?.[0];
      if (match) findings.push({ label: surface.label, match });
    }

    expect(findings).toEqual([]);
  });
});
