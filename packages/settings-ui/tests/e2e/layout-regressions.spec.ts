import { expect, loadSpaceGrotesk, test, type Page } from './fixtures/test';

// A computed `background-color` reads as transparent in two forms across
// engines: the keyword `transparent` and an `rgba(...)` with zero alpha
// (Chromium emits `rgba(0, 0, 0, 0)`; other engines can return `transparent`).
// Normalize both so the app-bar "un-carded" and phantom-pill assertions don't
// flake across chromium / firefox.
const isTransparent = (bg: string): boolean => {
  const value = bg.trim().toLowerCase();
  if (value === 'transparent') return true;
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(',').map((part) => part.trim());
    if (parts.length === 4) return Number.parseFloat(parts[3]) === 0;
  }
  return false;
};

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
    // Measure against the real Space Grotesk (see `loadSpaceGrotesk`): the app
    // ships no @font-face, so the CI fallback sans is narrower than what users
    // see. Loading it makes the "no clipped label" assertion faithful to the
    // widest realistic case.
    await loadSpaceGrotesk(page);
    const tabMetrics = await page.getByRole('tablist', { name: 'PELS settings sections' }).locator('[role="tab"]')
      .evaluateAll((tabs) => tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        const renderedText = tab.textContent?.trim() ?? '';
        return {
          text: renderedText,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          // Scroll width > client width signals the label is being clipped
          // by overflow:hidden; the 320 px shell must not truncate labels.
          scrollWidth: tab.scrollWidth,
          clientWidth: tab.clientWidth,
        };
      }));

    expect(tabMetrics.map((tab) => tab.text)).toEqual(['Overview', 'Budget', 'Usage', 'Smart tasks', 'Settings']);
    // Every label sits on a SINGLE line at one shared baseline: tabs size to
    // their label (`flex: 1 1 auto`) instead of the equal-width split that
    // used to starve "Smart tasks" into a two-line wrap. Height stays at the
    // 48 px touch-target token (a wrapped label would exceed 56 px), all tabs
    // share one top edge, and no label is clipped (scrollWidth beyond
    // clientWidth = hidden ellipsis).
    expect(
      tabMetrics.every((tab) => tab.width <= 116 && tab.height <= 56 && tab.height >= 48),
      JSON.stringify(tabMetrics),
    ).toBe(true);
    expect(
      new Set(tabMetrics.map((tab) => tab.top)).size,
      `all tabs must share one baseline: ${JSON.stringify(tabMetrics)}`,
    ).toBe(1);
    expect(
      new Set(tabMetrics.map((tab) => tab.height)).size,
      `all tabs must share one height: ${JSON.stringify(tabMetrics)}`,
    ).toBe(1);
    expect(
      tabMetrics.every((tab) => tab.scrollWidth <= tab.clientWidth + 1),
      `tab labels must not be horizontally clipped: ${JSON.stringify(tabMetrics)}`,
    ).toBe(true);
    await expectNoHorizontalOverflow(page, '320px shell nav');
  });

  test('marks the active tab with exactly one treatment — the M3 underline, no pill fill', async ({ browser, browserName, baseURL }) => {
    // The phantom pill was the Material shadow-DOM state layer, not a host
    // background: a tap on touch hardware left the tab in a sticky `:hover`
    // state and the active-hover state layer painted a filled pill. It only
    // exists under `@media (hover: none)` (touch), which the `.tabs` rule
    // zeroes via `--md-primary-tab-active-hover-state-layer-opacity: 0`. So the
    // guard must run in a touch context (mobile Chromium reports `hover: none`)
    // and assert the resolved opacity token is `0` — reading a host
    // `background-color` in a desktop `hover:hover` context (as this test used
    // to) can never observe the regression.
    test.skip(browserName !== 'chromium', 'Touch emulation needs chromium isMobile.');
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 480, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
      await openTopTab(page, 'Usage');
      const activeTab = page.locator('#shell-nav md-primary-tab[data-tab="usage"]');
      await expect(activeTab).toHaveClass(/active/);
      // The active-hover state-layer opacity token (inherited from the `.tabs`
      // host onto the tab) must resolve to `0` under `hover: none`. Reverting
      // the hover-gating `@media (hover: none)` block leaves the token unset in
      // the light DOM (its default lives in the component's shadow root), so
      // this reads `''` and the assertion fails — which is the point.
      const activeHoverOpacity = await activeTab.evaluate((el) => (
        getComputedStyle(el).getPropertyValue('--md-primary-tab-active-hover-state-layer-opacity').trim()
      ));
      expect(activeHoverOpacity).toBe('0');
      // The host background also stays transparent — only the underline
      // indicator marks the selection.
      const bg = await activeTab.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(isTransparent(bg), `active tab background must be transparent, got "${bg}"`).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('renders the identical app-bar back row on every sub-page', async ({ page }) => {
    await openApp(page, 480);
    const readAppbar = async () => {
      const raw = await page.evaluate(() => {
        const visiblePanel = [...document.querySelectorAll<HTMLElement>('.panel:not(.hidden)')]
          .find((panel) => panel.querySelector('.pels-appbar'));
        const bar = visiblePanel?.querySelector<HTMLElement>('.pels-appbar');
        const back = bar?.querySelector<HTMLElement>('.pels-appbar__back');
        const title = bar?.querySelector<HTMLElement>('.pels-appbar__title');
        if (!bar || !back || !title) return null;
        const barRect = bar.getBoundingClientRect();
        const backRect = back.getBoundingClientRect();
        const titleStyle = getComputedStyle(title);
        return {
          barLeft: Math.round(barRect.left),
          barHeight: Math.round(barRect.height),
          backWidth: Math.round(backRect.width),
          backHeight: Math.round(backRect.height),
          titleOffset: Math.round(title.getBoundingClientRect().left - barRect.left),
          titleFontSize: titleStyle.fontSize,
          titleFontWeight: titleStyle.fontWeight,
          barBackground: getComputedStyle(bar).backgroundColor,
        };
      });
      if (raw === null) return null;
      // Normalize the transparency check in Node (both `rgba(0, 0, 0, 0)` and
      // `transparent` mean un-carded — see `isTransparent`) so the cross-engine
      // string difference can't wrongly flag an un-carded bar as carded.
      const { barBackground, ...rest } = raw;
      return { ...rest, carded: !isTransparent(barBackground) };
    };

    // Three different sub-page families: a static settings section, a
    // Preact-rendered settings section, and the smart-task detail panel.
    await openSettingsSection(page, 'limits');
    const limits = await readAppbar();
    await openSettingsSection(page, 'electricity-prices');
    const prices = await readAppbar();
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#deadline-plan-panel .pels-appbar')).toBeVisible();
    const smartTask = await readAppbar();

    expect(limits, 'limits app bar must render').not.toBeNull();
    // One geometry everywhere: same bar height, same un-carded chrome, same
    // 48 px back control, same title slot and type.
    expect(prices).toEqual(limits);
    expect(smartTask).toEqual(limits);
    expect(limits!.backWidth).toBeGreaterThanOrEqual(48);
    expect(limits!.backHeight).toBeGreaterThanOrEqual(48);
    expect(limits!.carded).toBe(false);
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
      // Segment labels are `white-space: nowrap` + `text-overflow: ellipsis`,
      // so a too-long label no longer wraps mid-word — it clips silently.
      // Pin the invariant that no visible segment label is actually clipped
      // at 320 px (scrollWidth beyond clientWidth = hidden ellipsis).
      const clippedSegments = await page.evaluate(() => (
        [...document.querySelectorAll<HTMLElement>('.segmented__option')]
          .filter((opt) => opt.getBoundingClientRect().width > 0)
          .filter((opt) => opt.scrollWidth > opt.clientWidth + 1)
          .map((opt) => ({ label: opt.textContent?.trim(), scrollWidth: opt.scrollWidth, clientWidth: opt.clientWidth }))
      ));
      expect(clippedSegments, `${appPage.label}: segment labels must not clip at 320px`).toEqual([]);
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

  test('removes the Overview first-paint skeleton once real plan cards render', async ({ page }) => {
    await openApp(page, 480);
    await openTopTab(page, 'Overview');
    // Real cards come from the stub plan payload; once they exist the static
    // index.html placeholder must be gone from the DOM entirely — it used to
    // survive Preact's first render and trail the list as two ghost cards.
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('[data-overview-cards-placeholder]')).toHaveCount(0);
    // The device list must also end with visible content, not an empty shell.
    const lastCardText = await page.locator('#plan-cards > :last-child').innerText();
    expect(lastCardText.trim().length).toBeGreaterThan(0);
  });

  test('stacks the smart-task detail back button one gap below the banner on deep-link entry', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 2400 });
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    const back = page.locator('#deadline-plan-panel [data-deadline-plan-close]');
    await expect(back).toBeVisible();
    const banner = page.locator('#dry-run-banner');
    await expect(banner).toBeVisible();
    const gap = await page.evaluate(() => {
      const bannerRect = document.getElementById('dry-run-banner')!.getBoundingClientRect();
      const backRect = document.querySelector('[data-deadline-plan-close]')!.getBoundingClientRect();
      return backRect.top - bannerRect.bottom;
    });
    // One `main.screen` grid gap (16 px) separates the banner from the panel;
    // the panel itself must not add its own top inset (the old mobile-chrome
    // padding rendered a dead ~80 px band here).
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
  });

  test('renders the simulation banner as one slim warning-tinted row, content rising up', async ({ page }) => {
    for (const width of [480, 320] as const) {
      await openApp(page, width);
      await openTopTab(page, 'Overview');
      const banner = page.locator('#dry-run-banner');
      await expect(banner).toBeVisible();
      const metrics = await page.evaluate(() => {
        const b = document.getElementById('dry-run-banner')!.getBoundingClientRect();
        const hero = document.querySelector('#plan-redesign-surface .plan-hero')!.getBoundingClientRect();
        return {
          bannerHeight: Math.round(b.height),
          heroFollowGap: Math.round(hero.top - b.bottom),
        };
      });
      // A slim M3 banner: the 48 px text-button (a11y touch target) defines a
      // single ~50 px row, not the old ~130 px three-row card. 320 px may wrap
      // the message to two lines, still far under the old block.
      const cap = width === 320 ? 78 : 54;
      expect(metrics.bannerHeight, `banner height @ ${width}px`).toBeLessThanOrEqual(cap);
      // Content rises right up under the slim banner — the hero follows within
      // one `main.screen` grid gap, no dead band. (Robust to tab-height chrome
      // changes: it measures the banner→hero relationship, not an absolute top.)
      expect(metrics.heroFollowGap, `hero follow gap @ ${width}px`).toBeGreaterThanOrEqual(0);
      expect(metrics.heroFollowGap, `hero follow gap @ ${width}px`).toBeLessThanOrEqual(24);
    }
  });

  test('suppresses the global simulation banner on the Simulation-mode settings page', async ({ page }) => {
    await openApp(page, 480);
    await openTopTab(page, 'Overview');
    await expect(page.locator('#dry-run-banner')).toBeVisible();
    await openSettingsSection(page, 'simulation');
    await expect(page.locator('#simulation-panel')).toBeVisible();
    // The page's own toggle is the single control here — the global banner hides
    // so simulation is not stated twice on one screen.
    await expect(page.locator('#dry-run-banner')).toBeHidden();
    // Leaving the page restores the global banner (simulation is still on).
    await openTopTab(page, 'Budget');
    await expect(page.locator('#dry-run-banner')).toBeVisible();
  });

  test('turning simulation off from the banner hides it everywhere and flips device-card copy at once', async ({ page }) => {
    await openApp(page, 480);
    await openTopTab(page, 'Overview');
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    const cards = page.locator('#plan-cards');
    // Simulation ON: the flagship card + its reason line read hypothetically.
    await expect(cards).toContainText('(simulation)');
    await expect(page.locator('#dry-run-banner')).toBeVisible();
    // Turn simulation off from the banner's inline action.
    await page.locator('#simulation-disable-button').click();
    await expect(page.locator('#toast')).toContainText('Simulation mode updated.');
    // Banner + overview flip together — not on the next realtime push.
    await expect(page.locator('#dry-run-banner')).toBeHidden();
    await expect(cards).not.toContainText('(simulation)');
    // Simulation-OFF: the global banner stays hidden across tabs.
    await openTopTab(page, 'Settings');
    await expect(page.locator('#dry-run-banner')).toBeHidden();
  });

  test('keeps the device-detail app-bar header and sections content-sized on a tall viewport', async ({ page }) => {
    // Tall viewport so the slide panel's grid body has free space — the
    // regression was `align-content: stretch` distributing that free space
    // into every row (hero void + huge inter-section gaps).
    await page.setViewportSize({ width: 480, height: 2400 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await openSettingsSection(page, 'devices');
    const row = page.locator('#devices-panel [data-device-id="dev_heatpump"]').first();
    await expect(row).toBeVisible();
    await row.locator('.pels-device-card__detail-button').click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    const metrics = await page.evaluate(() => {
      // The identity hero card is gone — the device name now lives in the
      // slide panel's app-bar header. The header must stay a compact chrome
      // strip, and the sections below must stay content-sized.
      const header = document.querySelector('#device-detail-panel .slide-panel__header.pels-appbar')!;
      const sections = [...document.querySelectorAll<HTMLElement>('#device-detail-panel .detail-section')]
        .filter((s) => s.getBoundingClientRect().height > 0);
      const sectionSlack = sections.map((s) => {
        const child = s.firstElementChild!.getBoundingClientRect();
        return Math.round(s.getBoundingClientRect().height - child.height);
      });
      const gaps: number[] = [];
      for (let i = 1; i < sections.length; i += 1) {
        gaps.push(Math.round(sections[i].getBoundingClientRect().top - sections[i - 1].getBoundingClientRect().bottom));
      }
      return {
        headerHeight: Math.round(header.getBoundingClientRect().height),
        hasTitle: Boolean(header.querySelector('#device-detail-title.pels-appbar__title')),
        sectionSlack,
        maxGap: Math.max(...gaps),
      };
    });
    // App-bar header stays one compact row (48 px control + padding).
    expect(metrics.hasTitle).toBe(true);
    expect(metrics.headerHeight).toBeLessThanOrEqual(72);
    // Each section wraps its collapsible exactly — no stretched dead space.
    for (const slack of metrics.sectionSlack) expect(slack).toBeLessThanOrEqual(2);
    // Adjacent sections sit at the standard grid gap.
    expect(metrics.maxGap).toBeLessThanOrEqual(16);
  });

  test('does not strand a tooltip after tapping through to device detail on touch', async ({ browser, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'Touch emulation needs chromium isMobile.');
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 480, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
      await openSettingsSection(page, 'devices');
      const row = page.locator('#devices-panel [data-device-id="dev_heatpump"]').first();
      await expect(row).toBeVisible();
      await row.locator('.pels-device-card__detail-button').click();
      await expect(page.locator('#device-detail-overlay')).toBeVisible();
      // The tap must only navigate — no click-triggered tooltip may float
      // over the detail overlay (it had no dismiss path on touch).
      await expect(page.locator('.tippy-box')).toHaveCount(0);
    } finally {
      await context.close();
    }
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
