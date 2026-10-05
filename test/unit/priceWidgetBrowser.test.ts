// @vitest-environment jsdom
import { renderWidget, type RenderTargets } from '../../widgets/price/src/public/render';
import { resolvePriceWidgetPreviewPayload } from '../../widgets/price/src/public/previewPayloads';
import {
  createWidgetController,
  type WidgetHomey,
  type WidgetWindow,
} from '../../widgets/price/src/public/widgetApp';

const MARKUP = `
  <main id="widget-root" class="widget-root" data-state="loading">
    <div class="headline">
      <span class="headline__price" data-price>—</span>
      <span class="headline__level" data-level hidden></span>
    </div>
    <p class="subline" data-subline></p>
    <div class="chart" data-chart></div>
    <div class="legend" data-legend></div>
    <p class="caption" data-caption hidden></p>
  </main>
`;

const resolveTargets = (): RenderTargets => ({
  root: document.getElementById('widget-root') as HTMLElement,
  priceEl: document.querySelector('[data-price]') as HTMLElement,
  levelEl: document.querySelector('[data-level]') as HTMLElement,
  sublineEl: document.querySelector('[data-subline]') as HTMLElement,
  chartEl: document.querySelector('[data-chart]') as HTMLElement,
  legendEl: document.querySelector('[data-legend]') as HTMLElement,
  captionEl: document.querySelector('[data-caption]') as HTMLElement,
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

describe('price widget renderer', () => {
  it('renders the headline, level shades, both lines and the caption', () => {
    const targets = resolveTargets();
    renderWidget(targets, resolvePriceWidgetPreviewPayload(null, 'both'));
    expect(targets.root.dataset.state).toBe('ready');
    expect(targets.priceEl.textContent).toMatch(/øre$/);
    expect(targets.levelEl.hidden).toBe(false);
    expect(targets.sublineEl.textContent).toContain('High from');
    expect(targets.chartEl.querySelectorAll('.chart__shade--cheap').length).toBeGreaterThan(0);
    expect(targets.chartEl.querySelectorAll('.chart__shade--expensive').length).toBeGreaterThan(0);
    expect(targets.chartEl.querySelector('.chart__import')).not.toBeNull();
    expect(targets.chartEl.querySelector('.chart__export')).not.toBeNull();
    expect(targets.chartEl.querySelector('.chart__now-dot')).not.toBeNull();
    expect([...targets.legendEl.querySelectorAll('.legend__item')].map((item) => item.textContent))
      .toEqual(['Import', 'Export', 'Price low', 'Price high']);
    expect(targets.captionEl.hidden).toBe(false);
  });

  it('shows a normal level as plain text and a low or high one as a chip', () => {
    const targets = resolveTargets();
    renderWidget(targets, resolvePriceWidgetPreviewPayload(null, 'import'));
    expect(targets.levelEl.classList.contains('headline__level--chip')).toBe(false);
    const payload = resolvePriceWidgetPreviewPayload(null, 'import');
    if (payload.state !== 'ready') throw new Error('expected ready');
    renderWidget(targets, { ...payload, level: { label: 'Price high', tone: 'expensive' } });
    expect(targets.levelEl.className).toContain('headline__level--expensive');
  });

  it('hides the level in the export view', () => {
    const targets = resolveTargets();
    renderWidget(targets, resolvePriceWidgetPreviewPayload(null, 'export'));
    expect(targets.levelEl.hidden).toBe(true);
    expect(targets.chartEl.querySelector('.chart__import')).toBeNull();
    expect(targets.chartEl.querySelectorAll('.chart__shade').length).toBe(0);
  });

  it('clears the chart for an empty state', () => {
    const targets = resolveTargets();
    renderWidget(targets, resolvePriceWidgetPreviewPayload(null, 'import'));
    renderWidget(targets, resolvePriceWidgetPreviewPayload('empty', 'import'));
    expect(targets.root.dataset.state).toBe('empty');
    expect(targets.chartEl.childElementCount).toBe(0);
    expect(targets.legendEl.childElementCount).toBe(0);
    expect(targets.captionEl.hidden).toBe(true);
  });
});

describe('price widget controller', () => {
  it('asks the API for the series the owner chose to show', async () => {
    const api = vi.fn(async () => resolvePriceWidgetPreviewPayload(null, 'both'));
    const reportHeight = vi.fn();
    const homey: WidgetHomey = { api, getSettings: () => ({ show: 'both' }) };
    const controller = createWidgetController(resolveTargets(), document, window as WidgetWindow, reportHeight);
    controller.bootstrap(homey);
    await flushPromises();
    expect(api).toHaveBeenCalledWith('GET', '/timeline?show=both');
    expect(reportHeight).toHaveBeenCalled();
    controller.destroy();
  });

  it('renders the load-error state when the API rejects', async () => {
    const homey: WidgetHomey = { api: vi.fn(async () => { throw new Error('boom'); }) };
    const targets = resolveTargets();
    const controller = createWidgetController(targets, document, window as WidgetWindow, () => {});
    controller.bootstrap(homey);
    await flushPromises();
    expect(targets.root.dataset.state).toBe('empty');
    expect(targets.sublineEl.textContent).toBe('Could not load. Reopen the dashboard.');
    controller.destroy();
  });
});
