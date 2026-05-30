import {
  renderEmptyState,
  renderWidget,
  resolveSummaryText,
} from '../widgets/plan_budget/src/public/chart';
import { PREVIEW_TODAY_PAYLOAD } from '../widgets/plan_budget/src/public/previewPayloads';
import type { PlanPriceWidgetReadyPayload } from '../widgets/plan_budget/src/planPriceWidgetTypes';
import {
  createWidgetController,
  installWidget,
  maybeApplyPreviewTheme,
  resolveInitialHalf,
  resolveTarget,
  type WidgetHomey,
  type WidgetTargets,
  type WidgetWindow,
} from '../widgets/plan_budget/src/public/widgetApp';

const MARKUP = `
  <main id="widget-root" class="homey-widget widget-root">
    <p id="summary" class="summary" data-summary aria-live="polite"></p>
    <div id="tabs" class="tabs" role="tablist" aria-label="Time of day" data-tabs hidden>
      <button type="button" class="tab" role="tab" data-tab="morning" aria-selected="true"></button>
      <button type="button" class="tab" role="tab" data-tab="afternoon" aria-selected="false"></button>
    </div>
    <svg
      id="chart"
      class="chart"
      viewBox="0 0 480 360"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Budget and price chart"
    ></svg>
  </main>
`;

const setDocumentMarkup = (): SVGSVGElement => {
  document.body.innerHTML = MARKUP;
  return document.getElementById('chart') as SVGSVGElement;
};

const resolveTargets = (): WidgetTargets => ({
  chartEl: document.getElementById('chart') as SVGSVGElement,
  summaryEl: document.querySelector('[data-summary]') as HTMLElement,
  tabsEl: document.querySelector('[data-tabs]') as HTMLElement,
  tabButtons: {
    morning: document.querySelector('[data-tab="morning"]') as HTMLButtonElement,
    afternoon: document.querySelector('[data-tab="afternoon"]') as HTMLButtonElement,
  },
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('plan budget widget browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    setDocumentMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.className = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('renders empty state with accessible text', () => {
    const chartEl = setDocumentMarkup();

    renderEmptyState(chartEl, {
      title: 'Budget and Price',
      subtitle: 'Unable to load widget',
    });

    expect(chartEl.getAttribute('aria-label')).toBe('Unable to load widget');
    expect(chartEl.querySelector('.chart__empty-title')?.textContent).toBe('Budget and Price');
    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');
  });

  test('renders only the selected half (12 bars) with axis titles and legend', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'morning');

    expect(chartEl.getAttribute('aria-label')).toBe('Budget and price chart for today');
    // 24-hour day → 12 morning bars (not the full 24-bar wall).
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
    // Actuals run to currentIndex 10, all within the morning half.
    expect(chartEl.querySelectorAll('.chart__actual')).toHaveLength(11);
    expect(chartEl.querySelectorAll('.chart__legend-text')).toHaveLength(3);
    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
    const axisTitles = [...chartEl.querySelectorAll('.chart__axis-title')].map((node) => node.textContent);
    expect(axisTitles).toEqual(['kWh', 'øre/kWh']);
  });

  test('afternoon half drops the now marker and past-day actuals', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'afternoon');

    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
    // currentIndex 10 and all actuals live in the morning half.
    expect(chartEl.querySelectorAll('.chart__actual')).toHaveLength(0);
    expect(chartEl.querySelector('.chart__now')).toBeNull();
  });

  // Build a ready payload whose buckets carry the given LOCAL hour labels, so the
  // AM/PM split can be asserted independently of the array index (the DST case).
  const buildDayPayload = (localHourLabels: number[]): PlanPriceWidgetReadyPayload => {
    const count = localHourLabels.length;
    return {
      ...PREVIEW_TODAY_PAYLOAD,
      bucketLabels: localHourLabels.map((hour) => String(hour).padStart(2, '0')),
      plannedKwh: Array.from({ length: count }, () => 0.5),
      actualKwh: Array.from({ length: count }, () => null),
      priceSeries: Array.from({ length: count }, () => 100),
      showActual: false,
      showNow: false,
      currentIndex: 0,
      maxPlan: 1,
      priceMin: 100,
      priceMax: 100,
    };
  };

  test('splits AM/PM by local hour on a 25-hour fall-back DST day', () => {
    const chartEl = setDocumentMarkup();
    // Europe/Oslo fall-back: local 02:00 repeats → 25 buckets, hours
    // 00,01,02,02,03,...,23. Morning (hour < 12) = 13 buckets, afternoon = 12.
    const labels = [0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload = buildDayPayload(labels);

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(13);

    renderWidget(chartEl, payload, 'afternoon');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
  });

  test('splits AM/PM by local hour on a 23-hour spring-forward DST day', () => {
    const chartEl = setDocumentMarkup();
    // Europe/Oslo spring-forward: local 02:00 skipped → 23 buckets, hours
    // 00,01,03,...,23. Morning (hour < 12) = 11 buckets, afternoon = 12.
    const labels = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload = buildDayPayload(labels);

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(11);

    renderWidget(chartEl, payload, 'afternoon');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);
  });

  test('initial half follows the current bucket local hour on a DST day', () => {
    // Contrived day where bucket index 10 carries local hour 13 (PM). Index 10
    // alone (< HALF_SPLIT_HOUR 12) would have wrongly implied the AM tab.
    const labels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13,
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const payload: PlanPriceWidgetReadyPayload = {
      ...buildDayPayload(labels),
      showNow: true,
      currentIndex: 10,
    };
    expect(resolveInitialHalf(payload)).toBe('afternoon');
  });

  test('uses Budget/Used/Price legend wording', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD, 'morning');

    const labels = [...chartEl.querySelectorAll('.chart__legend-text')].map((node) => node.textContent);
    expect(labels).toEqual(['Budget', 'Used', 'Price']);
  });

  test('builds the projected summary line with kWh, cost, and tone', () => {
    expect(resolveSummaryText(PREVIEW_TODAY_PAYLOAD)).toBe('Projected 16.8 kWh · 19.60 kr · On track');
    expect(resolveSummaryText(null)).toBe('');
    expect(resolveSummaryText({
      ...PREVIEW_TODAY_PAYLOAD,
      summaryTone: 'over',
      projectedCost: null,
      costUnit: '',
    })).toBe('Projected 16.8 kWh · Over budget');
  });

  test('renders empty fallback and missing-price badge states', () => {
    const chartEl = setDocumentMarkup();
    const payload = {
      ...PREVIEW_TODAY_PAYLOAD,
      hasPriceData: false,
      showActual: false,
      priceSeries: Array.from({ length: 24 }, () => null),
      priceAxisUnit: '',
      plannedKwh: [0, ...PREVIEW_TODAY_PAYLOAD.plannedKwh.slice(1)],
    };

    renderWidget(chartEl, null, 'morning');
    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('No plan data available');

    renderWidget(chartEl, payload, 'morning');
    expect(chartEl.querySelector('.chart__badge')?.textContent).toBe('Price data missing');
    expect(chartEl.querySelector('.chart__price')).toBeNull();
  });

  test('renders price series with flat bounds and gaps', () => {
    const chartEl = setDocumentMarkup();
    const payload = {
      ...PREVIEW_TODAY_PAYLOAD,
      priceMin: 100,
      priceMax: 100,
      priceSeries: [
        100, 100, null, 100, 100, 100, 100, 100, 100, 100, 100, 100,
        100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      ],
    };

    renderWidget(chartEl, payload, 'morning');

    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
    expect(chartEl.querySelector('.chart__price-dot')).not.toBeNull();
  });

  test('resolves the initial half from the current hour', () => {
    expect(resolveInitialHalf(PREVIEW_TODAY_PAYLOAD)).toBe('morning');
    expect(resolveInitialHalf({ ...PREVIEW_TODAY_PAYLOAD, currentIndex: 18 })).toBe('afternoon');
    expect(resolveInitialHalf({ ...PREVIEW_TODAY_PAYLOAD, showNow: false })).toBe('morning');
    expect(resolveInitialHalf(null)).toBe('morning');
  });

  test('applies preview themes and resolves targets from query params first', () => {
    const searchParams = new URLSearchParams('theme=dark&day=tomorrow');

    maybeApplyPreviewTheme(document, searchParams);

    expect(document.body.classList.contains('homey-dark-mode')).toBe(true);
    expect(resolveTarget({ day: 'today' }, searchParams)).toBe('tomorrow');

    maybeApplyPreviewTheme(document, new URLSearchParams('theme=light'));
    expect(document.body.classList.contains('homey-dark-mode')).toBe(false);
  });

  test('loads preview data without Homey and refreshes when visible again', async () => {
    setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=tomorrow');

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    await controller.loadAndRender();

    expect(targets.chartEl.getAttribute('aria-label')).toBe('Budget and price chart for tomorrow');
    expect(targets.tabsEl.hidden).toBe(false);
    expect(targets.summaryEl.textContent).toBe('Projected 15.6 kWh · 18.30 kr');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(targets.chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);

    controller.destroy();
  });

  test('switching tabs re-renders the other half and tracks aria-selected', () => {
    setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=tomorrow');

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(null);

    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('true');

    targets.tabButtons.afternoon.click();

    expect(targets.tabButtons.afternoon.getAttribute('aria-selected')).toBe('true');
    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('false');
    expect(targets.chartEl.querySelectorAll('.chart__bar')).toHaveLength(12);

    // Arrow-key navigation moves selection back to morning.
    targets.tabsEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(targets.tabButtons.morning.getAttribute('aria-selected')).toBe('true');

    controller.destroy();
  });

  test('boots with Homey data and calls ready once', async () => {
    setDocumentMarkup();
    const ready = vi.fn();
    const api = vi.fn().mockResolvedValue(PREVIEW_TODAY_PAYLOAD);
    const homey: WidgetHomey = {
      api,
      getSettings: () => ({ day: 'today' }),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(api).toHaveBeenCalledWith('GET', '/chart?day=today');
    expect(ready).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 1000);
    await flushPromises();

    expect(api).toHaveBeenCalledTimes(2);

    controller.destroy();
  });

  test('does not render or call ready() when an in-flight load resolves after destroy()', async () => {
    setDocumentMarkup();
    let resolveApi: (payload: PlanPriceWidgetReadyPayload) => void = () => {};
    const apiPromise = new Promise<PlanPriceWidgetReadyPayload>((resolve) => {
      resolveApi = resolve;
    });
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockReturnValue(apiPromise),
      getSettings: () => ({ day: 'today' }),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey); // starts loadAndRender, suspended on the pending api
    await flushPromises();
    expect(targets.tabsEl.hidden).toBe(true); // nothing rendered yet

    controller.destroy(); // tear down before the load resolves
    resolveApi(PREVIEW_TODAY_PAYLOAD as PlanPriceWidgetReadyPayload);
    await flushPromises();

    // The late resolution must not touch the torn-down DOM, nor call ready().
    expect(targets.tabsEl.hidden).toBe(true);
    expect(ready).not.toHaveBeenCalled();
  });

  test('renders a load error when the Homey API call fails', async () => {
    setDocumentMarkup();
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockRejectedValue(new Error('boom')),
      ready,
    };

    const targets = resolveTargets();
    const controller = createWidgetController({
      targets,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(targets.chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');
    expect(targets.tabsEl.hidden).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  test('installs the widget entrypoint and registers onHomeyReady', async () => {
    setDocumentMarkup();

    const controller = installWidget(window as WidgetWindow, document);

    expect(controller).not.toBeNull();
    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    controller?.destroy();

    vi.resetModules();
    setDocumentMarkup();
    const entryModule = await import('../widgets/plan_budget/src/public/index.ts') as {
      widgetController?: { destroy: () => void } | null;
    };

    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    entryModule.widgetController?.destroy();
  });

  test('returns null when the widget root is missing', () => {
    document.body.innerHTML = '<main></main>';

    expect(installWidget(window as WidgetWindow, document)).toBeNull();
  });
});
