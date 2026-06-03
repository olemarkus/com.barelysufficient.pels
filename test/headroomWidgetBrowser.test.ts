import { renderWidget, type RenderTargets } from '../widgets/headroom/src/public/render';
import {
  PREVIEW_HEADROOM_PAYLOAD,
  PREVIEW_HEADROOM_PAYLOADS,
  resolveHeadroomPreviewPayload,
} from '../widgets/headroom/src/public/previewPayloads';
import {
  createWidgetController,
  installWidget,
  type WidgetHomey,
  type WidgetWindow,
} from '../widgets/headroom/src/public/widgetApp';
import type { HeadroomWidgetReadyPayload } from '../widgets/headroom/src/headroomWidgetTypes';

const MARKUP = `
  <main id="widget-root" class="widget-root" role="img" aria-label="Available power">
    <div class="row row--top">
      <div class="power">
        <span class="power__pair">
          <span class="power__current" data-current>—</span>
          <span class="power__sep">/</span>
          <span class="power__budget" data-budget>— kW</span>
        </span>
        <span class="power__captions" aria-hidden="true">
          <span class="power__caption power__caption--current" data-caption-current></span>
          <span class="power__caption power__caption--budget" data-caption-budget></span>
        </span>
      </div>
      <span class="chip chip--unknown" data-price>—</span>
    </div>
    <div class="bar"><div class="bar__fill" data-bar></div></div>
    <div class="row row--bottom">
      <span class="state-label" data-state-label hidden></span>
      <span class="meta" data-meta>—</span>
    </div>
  </main>
`;

const setMarkup = (): void => {
  document.body.innerHTML = MARKUP;
};

const resolveTargets = (): RenderTargets => ({
  root: document.getElementById('widget-root') as HTMLElement,
  currentEl: document.querySelector('[data-current]') as HTMLElement,
  budgetEl: document.querySelector('[data-budget]') as HTMLElement,
  captionCurrentEl: document.querySelector('[data-caption-current]') as HTMLElement,
  captionBudgetEl: document.querySelector('[data-caption-budget]') as HTMLElement,
  chipEl: document.querySelector('[data-price]') as HTMLElement,
  barFillEl: document.querySelector('[data-bar]') as HTMLElement,
  stateLabelEl: document.querySelector('[data-state-label]') as HTMLElement,
  metaEl: document.querySelector('[data-meta]') as HTMLElement,
});

const READY: HeadroomWidgetReadyPayload = {
  ...PREVIEW_HEADROOM_PAYLOAD,
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('headroom widget browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    setMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.className = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('labels the number pair Power now / Safe pace now', () => {
    const targets = resolveTargets();
    renderWidget(targets, READY);

    expect(targets.captionCurrentEl.textContent).toBe('Power now');
    expect(targets.captionBudgetEl.textContent).toBe('Safe pace now');
    expect(targets.currentEl.textContent).toBe('3.2');
    expect(targets.budgetEl.textContent).toBe('7 kW');
    expect(targets.root.getAttribute('aria-label')).toContain('Power now 3.2 kW');
    expect(targets.root.getAttribute('aria-label')).toContain('Safe pace now 7 kW');
    expect(targets.root.getAttribute('aria-label')).not.toContain('Current draw');
  });

  test('uses the at-pace tone and label when pacing at the safe pace under the cap', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, currentKw: 6.3, hourBudgetKw: 6.3, headroomKw: 0, limitState: 'at_pace' });

    expect(targets.root.dataset.tone).toBe('at-pace');
    expect(targets.barFillEl.dataset.tone).toBe('at-pace');
    expect(targets.stateLabelEl.hidden).toBe(false);
    expect(targets.stateLabelEl.textContent).toBe('At safe pace');
    // At pace is managed, not an error: meta tone stays calm.
    expect(targets.metaEl.dataset.tone).toBe('ok');
  });

  test('reserves the danger tone for over-the-hard-cap exceedance', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, currentKw: 6.7, hourBudgetKw: 6.3, headroomKw: -0.4, limitState: 'over_cap' });

    expect(targets.root.dataset.tone).toBe('danger');
    expect(targets.stateLabelEl.textContent).toBe('Over hard cap');
    expect(targets.metaEl.dataset.tone).toBe('danger');
  });

  test('over_cap meta leads with the overage and appends the held-back count', () => {
    const targets = resolveTargets();
    renderWidget(targets, {
      ...READY,
      currentKw: 6.7,
      hourBudgetKw: 6.3,
      headroomKw: -0.4,
      overageKw: 0.4,
      limitState: 'over_cap',
      shedCount: 3,
    });

    // The misleading clamped "0 kW available" never appears; the overage figure
    // is the severity signal, with the held-back count appended.
    expect(targets.metaEl.textContent).not.toContain('available');
    expect(targets.metaEl.textContent).toBe('0.4 kW over hard cap · 3 held back');
    // The aria-label must match the visible meta — assistive tech hears the
    // same overage figure.
    const aria = targets.root.getAttribute('aria-label') ?? '';
    expect(aria).not.toContain('available');
    expect(aria).toContain('0.4 kW over hard cap');
    expect(aria).toContain('3 held back');
  });

  test('over_cap meta shows just the overage when nothing is held back', () => {
    const targets = resolveTargets();
    renderWidget(targets, {
      ...READY,
      currentKw: 6.7,
      hourBudgetKw: 6.3,
      headroomKw: -0.4,
      overageKw: 0.4,
      limitState: 'over_cap',
      shedCount: 0,
    });

    expect(targets.metaEl.textContent).toBe('0.4 kW over hard cap');
    expect(targets.metaEl.textContent).not.toContain('available');
  });

  test('non-over_cap states still show the available-power meta fragment', () => {
    const targets = resolveTargets();
    renderWidget(targets, {
      ...READY, currentKw: 3.2, hourBudgetKw: 7, headroomKw: 3.8, limitState: 'under', shedCount: 2,
    });

    expect(targets.metaEl.textContent).toContain('available');
    expect(targets.metaEl.textContent).toContain('2 held back');
  });

  test('renders the canonical price chip and a grammatical aria phrase', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, priceLevel: 'cheap' });

    expect(targets.chipEl.textContent).toBe('Price low');
    expect(targets.chipEl.hidden).toBe(false);
    const aria = targets.root.getAttribute('aria-label') ?? '';
    // The fixed broken forms must never come back.
    expect(aria).not.toContain('Price Cheap');
    expect(aria).not.toContain('Price Price');
    expect(aria).toContain('Price: low');
  });

  test('shows "Price high" for expensive hours', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, priceLevel: 'expensive' });

    expect(targets.chipEl.textContent).toBe('Price high');
    expect(targets.root.getAttribute('aria-label')).toContain('Price: high');
  });

  test('omits the price chip and aria phrase for normal hours', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, priceLevel: 'normal' });

    expect(targets.chipEl.hidden).toBe(true);
    expect(targets.root.getAttribute('aria-label')).not.toContain('Price');
  });

  test('hides the state label when there is nothing exceptional to say', () => {
    const targets = resolveTargets();
    renderWidget(targets, { ...READY, limitState: 'under' });

    expect(targets.stateLabelEl.hidden).toBe(true);
    expect(targets.stateLabelEl.textContent).toBe('');
    expect(targets.root.dataset.tone).toBe('neutral');
  });

  test('renders the empty state with accessible fallback copy', () => {
    const targets = resolveTargets();
    renderWidget(targets, null);

    expect(targets.root.dataset.state).toBe('empty');
    expect(targets.currentEl.textContent).toBe('No data yet');
    expect(targets.root.getAttribute('aria-label')).toBe('Available power: No data yet');
  });

  test('boots preview data without Homey and renders ready', async () => {
    window.history.replaceState({}, '', '/?preview=1');
    const controller = createWidgetController({
      targets: resolveTargets(),
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    await controller.loadAndRender();

    expect(document.getElementById('widget-root')?.dataset.state).toBe('ready');
    controller.destroy();
  });

  test('does not render or call ready() when an in-flight load resolves after destroy()', async () => {
    let resolveApi: (payload: HeadroomWidgetReadyPayload) => void = () => {};
    const apiPromise = new Promise<HeadroomWidgetReadyPayload>((resolve) => {
      resolveApi = resolve;
    });
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockReturnValue(apiPromise),
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
    expect(targets.root.dataset.state).not.toBe('ready'); // nothing rendered yet

    controller.destroy(); // tear down before the load resolves
    resolveApi(READY);
    await flushPromises();

    // The late resolution must not touch the torn-down DOM, nor call ready().
    expect(targets.root.dataset.state).not.toBe('ready');
    expect(ready).not.toHaveBeenCalled();
  });

  test('renders the load-error subtitle when the Homey API call fails', async () => {
    const ready = vi.fn();
    const homey: WidgetHomey = {
      api: vi.fn().mockRejectedValue(new Error('boom')),
      ready,
    };
    const controller = createWidgetController({
      targets: resolveTargets(),
      widgetDocument: document,
      widgetWindow: window as WidgetWindow,
    });

    controller.bootstrap(homey);
    await flushPromises();

    expect(document.querySelector('[data-current]')?.textContent).toBe('Unable to load');
    expect(ready).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  test('installs the widget entrypoint and returns null without the root', () => {
    const controller = installWidget(window as WidgetWindow, document);
    expect(controller).not.toBeNull();
    expect(typeof (window as WidgetWindow).onHomeyReady).toBe('function');
    controller?.destroy();

    document.body.innerHTML = '<main></main>';
    expect(installWidget(window as WidgetWindow, document)).toBeNull();
  });
});

describe('resolveHeadroomPreviewPayload', () => {
  it('selects the preview payload for a known ?state= value', () => {
    expect(resolveHeadroomPreviewPayload('at_pace')).toBe(PREVIEW_HEADROOM_PAYLOADS.at_pace);
    expect(resolveHeadroomPreviewPayload('over_cap').limitState).toBe('over_cap');
  });

  it('falls back to the under-limit default for null/unknown states', () => {
    expect(resolveHeadroomPreviewPayload(null)).toBe(PREVIEW_HEADROOM_PAYLOAD);
    expect(resolveHeadroomPreviewPayload('bogus')).toBe(PREVIEW_HEADROOM_PAYLOAD);
    expect(PREVIEW_HEADROOM_PAYLOAD.limitState).toBe('under');
  });
});
