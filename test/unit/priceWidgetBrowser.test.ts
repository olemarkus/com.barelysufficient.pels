// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderWidget, type RenderTargets } from '../../widgets/price/src/public/render';
import { resolvePriceWidgetPreviewPayload } from '../../widgets/price/src/public/previewPayloads';
import {
  createWidgetController,
  installWidget,
  type WidgetHomey,
  type WidgetWindow,
} from '../../widgets/price/src/public/widgetApp';
import type { PriceWidgetReadyPayload } from '../../widgets/price/src/priceWidgetTypes';
import { declaredValue, readCssRuleBlocks, registerFixedHeightFrameSuite } from '../cssTestUtils';

// The shipped markup, so the tests wire up exactly as the Homey webview does.
const shippedMarkup = (): string => {
  const html = readFileSync(resolve(process.cwd(), 'widgets/price/public/index.html'), 'utf8');
  const { body } = new DOMParser().parseFromString(html, 'text/html');
  body.querySelectorAll('script').forEach((script) => script.remove());
  return body.innerHTML;
};

const resolveTargets = (): RenderTargets => ({
  root: document.getElementById('widget-root') as HTMLElement,
  summaryEl: document.querySelector('[data-summary]') as HTMLElement,
  priceEl: document.querySelector('[data-price]') as HTMLElement,
  levelEl: document.querySelector('[data-level]') as HTMLElement,
  sublineEl: document.querySelector('[data-subline]') as HTMLElement,
  captionEl: document.querySelector('[data-caption]') as HTMLElement,
  chartSvg: document.querySelector('[data-chart-svg]') as SVGSVGElement,
  legendEl: document.querySelector('[data-legend]') as HTMLElement,
  emptyEl: document.querySelector('[data-empty]') as HTMLElement,
  emptyTitleEl: document.querySelector('[data-empty-title]') as HTMLElement,
  emptySubtitleEl: document.querySelector('[data-empty-subtitle]') as HTMLElement,
});

const readyPreview = (show: 'import' | 'export' | 'both', state: string | null = null): PriceWidgetReadyPayload => {
  const payload = resolvePriceWidgetPreviewPayload(state, show);
  if (payload.state !== 'ready') throw new Error('expected ready');
  return payload;
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = shippedMarkup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Homey clipped this widget at its old 260 px manifest height because the
// runtime `setHeight` self-sizing never took effect. It now shares the Budget
// and Price frame: a fixed header and a chart that fills what is left.
registerFixedHeightFrameSuite({ name: 'price widget frame', widget: 'price' });

describe('price widget layout', () => {
  const ruleBlocks = readCssRuleBlocks('widgets/price/public/index.css');

  test('the header keeps its height and wraps; the chart panel takes the rest', () => {
    expect(declaredValue(ruleBlocks, '.summary', 'flex')).toBe('0 0 auto');
    expect(declaredValue(ruleBlocks, '.summary', 'overflow-wrap')).toBe('anywhere');
    expect(declaredValue(ruleBlocks, '.chart', 'flex')).toBe('1 1 auto');
    expect(declaredValue(ruleBlocks, '.chart', 'min-height')).toBe('0');
    expect(declaredValue(ruleBlocks, '.chart__svg', 'flex')).toBe('1 1 auto');
  });

  test('the chart reuses the Budget and Price furniture', () => {
    for (const selector of ['.chart__grid', '.chart__axis-label', '.chart__now', '.chart__price', '.chart__price-dot']) {
      expect(ruleBlocks.some((block) => block.selectors.split(',').some((m) => m.trim() === selector)))
        .toBe(true);
    }
  });
});

describe('price widget renderer', () => {
  it('renders the headline, level shades, both lines and the caption', () => {
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('both'));
    expect(targets.root.dataset.state).toBe('ready');
    expect(targets.priceEl.textContent).toMatch(/øre$/);
    expect(targets.levelEl.hidden).toBe(false);
    expect(targets.sublineEl.textContent).toBe('Cheap at or below 24.60 øre · expensive from 40.90 øre');
    expect(targets.chartSvg.querySelectorAll('.chart__shade--cheap').length).toBeGreaterThan(0);
    expect(targets.chartSvg.querySelectorAll('.chart__shade--expensive').length).toBeGreaterThan(0);
    expect(targets.chartSvg.querySelector('.chart__import')).not.toBeNull();
    expect(targets.chartSvg.querySelector('.chart__price')).not.toBeNull();
    expect(targets.chartSvg.querySelector('.chart__now')).not.toBeNull();
    expect(targets.chartSvg.querySelector('.chart__import-dot')).not.toBeNull();
    expect([...targets.legendEl.querySelectorAll('.chart__legend-item')].map((item) => item.textContent))
      .toEqual(['Import', 'Export', 'Price low', 'Price high']);
    expect(targets.legendEl.querySelector('.chart__legend-unit')?.textContent).toBe('øre/kWh');
    expect(targets.captionEl.hidden).toBe(false);
    expect(targets.emptyEl.hidden).toBe(true);
  });

  it('draws the cheap and expensive lines inside the plot when no price reaches either', () => {
    const targets = resolveTargets();
    const payload = readyPreview('import', 'flat');
    renderWidget(targets, payload);
    expect(payload.chart.shades).toEqual([]);
    const lines = [...targets.chartSvg.querySelectorAll('.chart__level-line')];
    expect(lines.map((line) => line.getAttribute('class'))).toEqual([
      'chart__level-line chart__level-line--cheap',
      'chart__level-line chart__level-line--expensive',
    ]);
    // Both lines sit inside the plot, the expensive one above the cheap one.
    const [cheapY, expensiveY] = lines.map((line) => Number(line.getAttribute('y1')));
    const gridYs = [...targets.chartSvg.querySelectorAll('.chart__grid')].map((line) => Number(line.getAttribute('y1')));
    expect(expensiveY).toBeLessThan(cheapY);
    expect(expensiveY).toBeGreaterThanOrEqual(Math.min(...gridYs));
    expect(cheapY).toBeLessThanOrEqual(Math.max(...gridYs));
    expect(targets.sublineEl.textContent).toBe('Cheap at or below 73.17 øre · expensive from 93.17 øre. '
      + 'No cheap or expensive prices: they stay between 73.84 and 87.84 øre.');
  });

  it('draws the tomorrow divider with its label', () => {
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('both', 'flat'));
    expect(targets.chartSvg.querySelector('.chart__divider')).not.toBeNull();
    expect([...targets.chartSvg.querySelectorAll('text')].map((node) => node.textContent)).toContain('Tomorrow');
  });

  it('draws at the measured size, so chart text stays at the token size', () => {
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 344, height: 210, top: 0, left: 0, right: 344, bottom: 210, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('import'));
    expect(targets.chartSvg.getAttribute('viewBox')).toBe('0 0 344 210');
    // The plot reaches the measured right edge, less its inset.
    const gridline = targets.chartSvg.querySelector('.chart__grid')!;
    expect(Number(gridline.getAttribute('x2'))).toBe(332);
  });

  it('shows a normal level as a neutral chip and a low or high one as a toned chip', () => {
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('import'));
    expect(targets.summaryEl.classList.contains('summary--success')).toBe(false);
    expect(targets.summaryEl.classList.contains('summary--danger')).toBe(false);
    renderWidget(targets, { ...readyPreview('import'), level: { label: 'Price high', tone: 'expensive' } });
    expect(targets.summaryEl.classList.contains('summary--danger')).toBe(true);
    renderWidget(targets, { ...readyPreview('import'), level: { label: 'Price low', tone: 'cheap' } });
    expect(targets.summaryEl.classList.contains('summary--success')).toBe(true);
    expect(targets.summaryEl.classList.contains('summary--danger')).toBe(false);
  });

  it('hides the level in the export view and puts the dot on the export line', () => {
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('export'));
    expect(targets.levelEl.hidden).toBe(true);
    expect(targets.chartSvg.querySelector('.chart__import')).toBeNull();
    expect(targets.chartSvg.querySelectorAll('.chart__shade').length).toBe(0);
    expect(targets.chartSvg.querySelector('.chart__price-dot')).not.toBeNull();
  });

  it('moves an empty state into the chart panel and steps the header aside', () => {
    const targets = resolveTargets();
    renderWidget(targets, readyPreview('import'));
    renderWidget(targets, resolvePriceWidgetPreviewPayload('empty', 'import'));
    expect(targets.root.dataset.state).toBe('empty');
    expect(targets.summaryEl.hidden).toBe(true);
    expect(targets.chartSvg.hasAttribute('hidden')).toBe(true);
    expect(targets.chartSvg.childElementCount).toBe(0);
    expect(targets.legendEl.hidden).toBe(true);
    expect(targets.emptyEl.hidden).toBe(false);
    expect(targets.emptyTitleEl.textContent).toBe('No prices yet');
  });
});

describe('price widget controller', () => {
  it('asks the API for the series the owner chose to show', async () => {
    const api = vi.fn(async () => resolvePriceWidgetPreviewPayload(null, 'both'));
    const homey: WidgetHomey = { api, getSettings: () => ({ show: 'both' }) };
    const controller = createWidgetController(resolveTargets(), document, window as WidgetWindow);
    controller.bootstrap(homey);
    await flushPromises();
    expect(api).toHaveBeenCalledWith('GET', '/timeline?show=both');
    controller.destroy();
  });

  it('never asks Homey to resize the widget', async () => {
    const setHeight = vi.fn();
    const ready = vi.fn();
    const homey = { api: vi.fn(async () => resolvePriceWidgetPreviewPayload(null, 'both')), ready, setHeight };
    (window as WidgetWindow).Homey = {};
    const controller = installWidget(window as WidgetWindow, document);
    (window as WidgetWindow).onHomeyReady!(homey as never);
    await flushPromises();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(setHeight).not.toHaveBeenCalled();
    controller?.destroy();
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
  });

  it('renders the load-error state when the API rejects', async () => {
    const homey: WidgetHomey = { api: vi.fn(async () => { throw new Error('boom'); }) };
    const targets = resolveTargets();
    const controller = createWidgetController(targets, document, window as WidgetWindow);
    controller.bootstrap(homey);
    await flushPromises();
    expect(targets.root.dataset.state).toBe('empty');
    expect(targets.emptySubtitleEl.textContent).toBe('Could not load. Reopen the dashboard.');
    controller.destroy();
  });
});
