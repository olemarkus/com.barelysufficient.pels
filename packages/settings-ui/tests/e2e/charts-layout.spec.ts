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
      '#usage-day-readout',
      '#hourly-pattern',
      '#hourly-pattern-readout',
      '#daily-history-readout',
      '#power-list svg',
      '#power-week-readout',
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
    await page.locator('#budget-panel .segmented__option').filter({ hasText: 'Hourly plan' }).click();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    // Each legend swatch must (a) render with an opaque colour, and (b) match
    // the same `--pels-chart-*` token the chart palette uses for the rendered
    // series. The split swatches and the line swatches read from the same
    // single source of truth so future palette tweaks cannot drift them
    // apart.
    const parity = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('#budget-panel');
      if (!panel) return { ok: false, reason: 'no panel' } as const;
      const swatches = Array.from(panel.querySelectorAll<HTMLElement>('.budget-chart-legend__swatch'));
      if (swatches.length === 0) return { ok: false, reason: 'no swatches' } as const;
      const panelStyle = getComputedStyle(panel);
      // Normalise both sides through the browser's colour parser by
      // round-tripping each value through `getComputedStyle.color`, so a
      // hex token (`#60a5fa`) and an rgb computed style (`rgb(96, 165, 250)`)
      // compare as the same colour without us doing the math.
      const probe = document.createElement('span');
      panel.appendChild(probe);
      const normalise = (value: string): string => {
        const v = value.trim();
        if (!v) return '';
        probe.style.color = '';
        probe.style.color = v;
        return getComputedStyle(probe).color;
      };
      const resolveVar = (variable: string): string => normalise(panelStyle.getPropertyValue(variable));
      const expectedByClass: Record<string, { fill?: string; border?: string }> = {
        'budget-chart-legend__swatch--actual': { fill: resolveVar('--pels-chart-actual') },
        'budget-chart-legend__swatch--background': { fill: resolveVar('--pels-chart-background') },
        'budget-chart-legend__swatch--managed': { fill: resolveVar('--pels-chart-managed') },
        'budget-chart-legend__swatch--forecast': { border: resolveVar('--pels-chart-forecast') },
        'budget-chart-legend__swatch--price': { border: resolveVar('--pels-chart-price-line') },
      };
      const isOpaque = (value: string): boolean => {
        const v = value.trim();
        return v.length > 0 && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent';
      };
      const offenders: Array<{ cls: string; reason: string }> = [];
      for (const swatch of swatches) {
        const style = getComputedStyle(swatch);
        const hasFill = isOpaque(style.backgroundColor);
        const hasBorder = style.borderTopWidth !== '0px' && isOpaque(style.borderTopColor);
        if (!hasFill && !hasBorder) {
          offenders.push({ cls: swatch.className, reason: 'no colour' });
          continue;
        }
        const variant = Object.keys(expectedByClass).find((cls) => swatch.classList.contains(cls));
        if (!variant) continue;
        const expected = expectedByClass[variant];
        const fillActual = normalise(style.backgroundColor);
        const borderActual = normalise(style.borderTopColor);
        if (expected.fill !== undefined && expected.fill && fillActual !== expected.fill) {
          offenders.push({ cls: variant, reason: `fill ${fillActual} != ${expected.fill}` });
        }
        if (expected.border !== undefined && expected.border && borderActual !== expected.border) {
          offenders.push({ cls: variant, reason: `border ${borderActual} != ${expected.border}` });
        }
      }
      probe.remove();
      return { ok: offenders.length === 0, offenders, swatchCount: swatches.length } as const;
    });
    expect(parity.ok, `Legend swatches mismatch: ${JSON.stringify(parity)}`).toBe(true);
  });

  test('usage charts have non-zero size on first tab activation', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();

    // Cold-mount path: the Usage panel was hidden during boot, so charts can
    // initialize with the 480 px fallback width. Activate the Usage tab and
    // wait for each ECharts SVG to settle to its real visible size. A
    // 0 × 0 SVG indicates the tab-shown resize handler did not run, and a
    // wider-than-container SVG indicates the resize did not match the panel.
    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();

    const targets = ['#usage-day-bars', '#hourly-pattern', '#daily-list'];
    await page.waitForFunction((selectors) => (
      selectors.every((selector) => {
        const container = document.querySelector<HTMLElement>(selector);
        if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return false;
        const svg = container.querySelector('svg');
        if (!svg) return false;
        const svgWidth = Number.parseFloat(svg.getAttribute('width') ?? '0');
        const svgHeight = Number.parseFloat(svg.getAttribute('height') ?? '0');
        return svgWidth > 0 && svgHeight > 0 && Math.abs(svgWidth - container.clientWidth) <= 1;
      })
    ), targets);
  });

  test('deadline-plan schedule chart labels the price axis with a unit', async ({ page }) => {
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('#deadline-plan-panel');
    await expect(panel.locator('.deadline-schedule-chart svg')).toBeVisible();
    // The SVG element mounts before ECharts paints its first frame, so poll
    // until label text lands instead of reading textContent immediately.
    await page.waitForFunction(() => (
      (document.querySelector('.deadline-schedule-chart svg')?.textContent ?? '').length > 0
    ));
    const axisText = await panel.locator('.deadline-schedule-chart svg').evaluate((svg) => svg.textContent ?? '');
    expect(
      axisText.includes('øre/kWh') || axisText.includes('kr/kWh'),
      `Price axis should display unit, got: ${axisText.slice(0, 200)}`,
    ).toBe(true);
  });

  // Regression (rewritten for the Phase 1B receipt-first redesign): the
  // history-detail trajectory card replaced the wrap-prone 4-entry ECharts
  // legend with a compact 3-item DOM legend row (Measured / Planned /
  // Target {value}) above the chart, plus a "Plan changed HH:MM" marker
  // label inside the chart's 28 px top reserve. At 320 px the legend must
  // wrap cleanly (no horizontal overflow), sit fully above the chart
  // container, and the marker label must render inside the chart bounds.
  test('history-detail trajectory legend and marker label fit at 320 px', async ({ page }) => {
    type HistoryEntryFixture = {
      id: string;
      deviceId: string;
      deviceName: string;
      objectiveKind: 'temperature';
      targetTemperatureC: number;
      targetPercent: null;
      deadlineAtMs: number;
      startedAtMs: number;
      finalizedAtMs: number;
      startProgressC: number;
      startProgressPercent: null;
      finalProgressC: number;
      finalProgressPercent: null;
      initialEnergyNeededKWh: number;
      outcome: 'met';
      metAtMs: number;
      usedDeadlineReserve: boolean;
      observedIntervals: Array<{ fromMs: number; toMs: number }>;
      discoveredFrom: 'observation';
      originalPlan: {
        hours: Array<{ startsAtMs: number; plannedKWh: number }>;
        energyNeededKWh: number;
        planStatus: 'on_track';
        revisedAtMs: number;
        kwhPerUnitMean: number;
      };
      finalPlan: {
        hours: Array<{ startsAtMs: number; plannedKWh: number }>;
        energyNeededKWh: number;
        planStatus: 'on_track';
        revisedAtMs: number;
        kwhPerUnitMean: number;
      };
      revisions: Array<{ atMs: number; reasonId: string; hoursAdded: number; hoursRemoved: number }>;
      revisionCount: number;
      progressSamples: Array<{ atMs: number; valueC: number; valuePercent: null }>;
    };
    const stubHistory = (entriesByDeviceId: Record<string, HistoryEntryFixture[]>) => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        apiHandlers: {
          'GET /ui_deferred_objective_history': () => ({
            version: 1,
            entriesByDeviceId,
          }),
        },
      };
    };
    const T0 = Date.UTC(2026, 4, 16, 4, 0, 0);
    const HOUR = 3_600_000;
    // Both `originalPlan` and `finalPlan` populated (genuinely different
    // schedules) so the revised configuration renders: marker + compare
    // toggle + the full legend row. `progressSamples` switches the producer
    // into trajectory mode.
    const buildPlan = (): HistoryEntryFixture['originalPlan'] => ({
      hours: [
        { startsAtMs: T0, plannedKWh: 1.0 },
        { startsAtMs: T0 + HOUR, plannedKWh: 1.0 },
        { startsAtMs: T0 + 2 * HOUR, plannedKWh: 1.0 },
        { startsAtMs: T0 + 3 * HOUR, plannedKWh: 1.0 },
      ],
      energyNeededKWh: 4.0,
      planStatus: 'on_track',
      revisedAtMs: T0,
      kwhPerUnitMean: 0.5,
    });
    const buildRevisedPlan = (): HistoryEntryFixture['finalPlan'] => ({
      hours: [
        { startsAtMs: T0, plannedKWh: 0.5 },
        { startsAtMs: T0 + HOUR, plannedKWh: 1.5 },
        { startsAtMs: T0 + 2 * HOUR, plannedKWh: 1.5 },
        { startsAtMs: T0 + 3 * HOUR, plannedKWh: 0.5 },
      ],
      energyNeededKWh: 4.0,
      planStatus: 'on_track',
      revisedAtMs: T0 + 30 * 60 * 1000,
      kwhPerUnitMean: 0.5,
    });
    const entry: HistoryEntryFixture = {
      id: 'fixture-legend-wrap-regression',
      deviceId: 'dev_connected300',
      deviceName: 'Connected 300',
      objectiveKind: 'temperature',
      targetTemperatureC: 65,
      targetPercent: null,
      deadlineAtMs: T0 + 4 * HOUR,
      startedAtMs: T0,
      finalizedAtMs: T0 + 4 * HOUR,
      startProgressC: 50,
      startProgressPercent: null,
      finalProgressC: 65,
      finalProgressPercent: null,
      initialEnergyNeededKWh: 4.0,
      outcome: 'met',
      metAtMs: T0 + 3 * HOUR,
      usedDeadlineReserve: false,
      observedIntervals: [{ fromMs: T0, toMs: T0 + 3 * HOUR }],
      discoveredFrom: 'observation',
      originalPlan: buildPlan(),
      finalPlan: buildRevisedPlan(),
      revisions: [
        { atMs: T0 + 30 * 60 * 1000, reasonId: 'prices_revised', hoursAdded: 2, hoursRemoved: 2 },
      ],
      revisionCount: 2,
      progressSamples: [
        { atMs: T0, valueC: 50, valuePercent: null },
        { atMs: T0 + HOUR, valueC: 55, valuePercent: null },
        { atMs: T0 + 2 * HOUR, valueC: 60, valuePercent: null },
        { atMs: T0 + 3 * HOUR, valueC: 65, valuePercent: null },
      ],
    };
    await page.setViewportSize({ width: 320, height: 700 });
    await page.addInitScript(stubHistory, { dev_connected300: [entry] });
    await page.goto(
      `/?page=deadline-plan&deviceId=dev_connected300&historyId=${encodeURIComponent(entry.id)}`,
      { waitUntil: 'domcontentloaded' },
    );
    // Met outcome → chart collapsed by default. Click "View details" so the
    // trajectory chart actually mounts.
    await page.locator('button.pels-button.plan-history-detail__chart-toggle').click();
    const chart = page.locator('.deadline-history-trajectory-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('svg')).toBeVisible();

    // DOM legend: all three items render with the target value, wrap inside
    // the viewport, and finish above the chart container.
    const legend = page.locator('.deadline-history-legend');
    await expect(legend).toBeVisible();
    const items = legend.locator('.deadline-history-legend__item');
    await expect(items).toHaveText(['Measured', 'Planned', 'Target 65.0 °C']);
    const probe = await page.evaluate(() => {
      const legendEl = document.querySelector('.deadline-history-legend');
      const chartEl = document.querySelector('.deadline-history-trajectory-chart');
      if (!legendEl || !chartEl) return { ok: false, reason: 'missing nodes' } as const;
      const legendRect = legendEl.getBoundingClientRect();
      const chartRect = chartEl.getBoundingClientRect();
      // The "Plan changed HH:MM" marker label must render fully inside the
      // chart container (the grid's 28 px top reserve holds it).
      const markerText = [...chartEl.querySelectorAll('svg text')].find((node) => (
        /^Plan changed \d{2}:\d{2}$/.test((node.textContent ?? '').trim())
      ));
      if (!markerText) return { ok: false, reason: 'no marker label' } as const;
      const markerRect = markerText.getBoundingClientRect();
      const legendAboveChart = legendRect.bottom <= chartRect.top + 1;
      const legendInsideViewport = legendRect.right <= window.innerWidth + 1 && legendRect.left >= -1;
      const markerInsideChart = markerRect.top >= chartRect.top - 1
        && markerRect.bottom <= chartRect.bottom + 1
        && markerRect.left >= chartRect.left - 1
        && markerRect.right <= chartRect.right + 1;
      const containerOverflow = chartRect.right > window.innerWidth + 1;
      return {
        ok: legendAboveChart && legendInsideViewport && markerInsideChart && !containerOverflow,
        legendBottom: Number(legendRect.bottom.toFixed(2)),
        chartTop: Number(chartRect.top.toFixed(2)),
        markerTop: Number(markerRect.top.toFixed(2)),
        markerBottom: Number(markerRect.bottom.toFixed(2)),
        chartBottom: Number(chartRect.bottom.toFixed(2)),
        markerRight: Number(markerRect.right.toFixed(2)),
        chartRight: Number(chartRect.right.toFixed(2)),
        viewport: window.innerWidth,
      } as const;
    });
    expect(
      probe.ok,
      `Legend/marker layout broken at 320 px: ${JSON.stringify(probe)}`,
    ).toBe(true);
  });

  // Regression: TODO 573. The unreliable-data legend swatch in `#power-legend`
  // must read from the same `--pels-chart-*` tokens the heatmap cell uses, so
  // a user pattern-matching legend → cell sees a single rectangle, not two
  // different shapes/colours.
  test('usage heatmap unreliable swatch matches the cell tokens', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();
    // The legend swatch lives inside the collapsible "Detailed hourly view"
    // section; expand it so the swatch and its computed style are actually
    // present in the layout tree.
    await page.locator('#usage-detail-section summary').click();
    const swatch = page.locator('.usage-legend__swatch--unreliable');
    await expect(swatch).toBeVisible();
    const parity = await swatch.evaluate((node) => {
      const panel = document.querySelector<HTMLElement>('#usage-panel');
      if (!panel) return { ok: false, reason: 'no panel' } as const;
      const probe = document.createElement('span');
      panel.appendChild(probe);
      const normalise = (value: string): string => {
        probe.style.color = '';
        probe.style.color = value.trim();
        return getComputedStyle(probe).color;
      };
      const root = getComputedStyle(panel);
      const expectedFill = normalise(root.getPropertyValue('--pels-chart-unreliable-cell'));
      const expectedBorder = normalise(root.getPropertyValue('--pels-chart-heatmap-border'));
      const style = getComputedStyle(node);
      const actualFill = normalise(style.backgroundColor);
      const actualBorder = normalise(style.borderTopColor);
      probe.remove();
      return {
        ok: actualFill === expectedFill && actualBorder === expectedBorder,
        actualFill,
        expectedFill,
        actualBorder,
        expectedBorder,
      } as const;
    });
    expect(parity.ok, `Unreliable swatch tokens drifted: ${JSON.stringify(parity)}`).toBe(true);
  });
});
