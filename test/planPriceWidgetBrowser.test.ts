import {
  renderEmptyState,
  renderWidget,
} from '../widgets/plan_budget/src/public/chart';
import { PREVIEW_TODAY_PAYLOAD } from '../widgets/plan_budget/src/public/previewPayloads';
import {
  createWidgetController,
  installWidget,
  maybeApplyPreviewTheme,
  resolveTarget,
  type WidgetHomey,
  type WidgetWindow,
} from '../widgets/plan_budget/src/public/widgetApp';

const setDocumentMarkup = (): SVGSVGElement => {
  document.body.innerHTML = `
    <main id="widget-root" class="homey-widget widget-root">
      <svg
        id="chart"
        class="chart"
        viewBox="0 0 480 480"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Budget and price chart"
      ></svg>
    </main>
  `;

  return document.getElementById('chart') as SVGSVGElement;
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('plan budget widget browser', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    setDocumentMarkup();
  });

  afterEach(() => {
    jest.useRealTimers();
    document.body.className = '';
    document.body.innerHTML = '';
    jest.restoreAllMocks();
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

  test('renders ready state with bars, labels, and legend', () => {
    const chartEl = setDocumentMarkup();

    renderWidget(chartEl, PREVIEW_TODAY_PAYLOAD);

    expect(chartEl.getAttribute('aria-label')).toBe('Budget and price chart for today');
    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(24);
    expect(chartEl.querySelectorAll('.chart__actual')).toHaveLength(11);
    expect(chartEl.querySelectorAll('.chart__legend-text')).toHaveLength(3);
    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
  });

  test('renders empty fallback and missing-price badge states', () => {
    const chartEl = setDocumentMarkup();
    const payload = {
      ...PREVIEW_TODAY_PAYLOAD,
      hasPriceData: false,
      showActual: false,
      priceSeries: Array.from({ length: 24 }, () => null),
      plannedKwh: [0, ...PREVIEW_TODAY_PAYLOAD.plannedKwh.slice(1)],
    };

    renderWidget(chartEl, null);
    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('No plan data available');

    renderWidget(chartEl, payload);
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

    renderWidget(chartEl, payload);

    expect(chartEl.querySelector('.chart__price')).not.toBeNull();
    expect(chartEl.querySelector('.chart__price-dot')).not.toBeNull();
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
    const chartEl = setDocumentMarkup();
    window.history.replaceState({}, '', '/?preview=1&day=tomorrow');

    const controller = createWidgetController({
      chartEl,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    await controller.loadAndRender();

    expect(chartEl.getAttribute('aria-label')).toBe('Budget and price chart for tomorrow');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();

    expect(chartEl.querySelectorAll('.chart__bar')).toHaveLength(24);

    controller.destroy();
  });

  test('boots with Homey data and calls ready once', async () => {
    const chartEl = setDocumentMarkup();
    const ready = jest.fn();
    const api = jest.fn().mockResolvedValue(PREVIEW_TODAY_PAYLOAD);
    const homey: WidgetHomey = {
      api,
      getSettings: () => ({ day: 'today' }),
      ready,
    };

    const controller = createWidgetController({
      chartEl,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(api).toHaveBeenCalledWith('GET', '/chart?day=today');
    expect(ready).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 1000);
    await flushPromises();

    expect(api).toHaveBeenCalledTimes(2);

    controller.destroy();
  });

  test('renders a load error when the Homey API call fails', async () => {
    const chartEl = setDocumentMarkup();
    const ready = jest.fn();
    const homey: WidgetHomey = {
      api: jest.fn().mockRejectedValue(new Error('boom')),
      ready,
    };

    const controller = createWidgetController({
      chartEl,
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(chartEl.querySelector('.chart__empty-subtitle')?.textContent).toBe('Unable to load widget');
    expect(ready).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  test('installs the widget entrypoint and registers onHomeyReady', async () => {
    setDocumentMarkup();

    const controller = installWidget(window as WidgetWindow, document);

    expect(controller).not.toBeNull();
    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    controller?.destroy();

    jest.resetModules();
    setDocumentMarkup();
    const entryModule = require('../widgets/plan_budget/src/public/index') as {
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
