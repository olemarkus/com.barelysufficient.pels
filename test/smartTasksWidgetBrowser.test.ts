import { installWidget } from '../widgets/smart_tasks/src/public/widgetApp';
import type { WidgetWindow } from '../widgets/smart_tasks/src/public/widgetApp';
import { registerHiddenGuardSuite } from './cssTestUtils';

// The renderer switches views (.list-view/.detail-view) and toggles the row
// list (.rows) plus the empty/overflow/detail lines by setting the `hidden`
// attribute, so a hidden view would stack on top of the visible one and the
// widget reads as frozen / unresponsive to taps without the blanket reset.
// See test/cssTestUtils.ts for the shared parsing + guard assertions.
registerHiddenGuardSuite({
  name: 'smart tasks widget hidden-element CSS',
  cssRelativePath: 'widgets/smart_tasks/public/index.css',
  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  hiddenToggledSelectors: [
    '.list-view', '.detail-view', // views
    '.rows', // row list (hidden when the payload is empty)
    '.empty', '.empty-hint', '.overflow', // list affordances
    '.detail-line', // toggled detail text lines
  ],
});

// Mirrors the production index.html markup the renderer queries against, so the
// controller wires up exactly as it would in the Homey webview.
const WIDGET_MARKUP = `
  <main id="widget-root" class="widget-root" data-state="ready" data-view="list" aria-label="Smart tasks">
    <section class="list-view" data-list-view>
      <ol class="rows" data-rows></ol>
      <p class="empty" data-empty hidden></p>
      <p class="empty-hint" data-empty-hint hidden></p>
      <p class="overflow" data-overflow hidden></p>
    </section>
    <section id="smart-task-detail" class="detail-view" data-detail-view hidden aria-live="polite">
      <header class="detail-header">
        <button type="button" class="back-btn" data-detail-back aria-label="Back to smart tasks">
          <span class="back-btn__name" data-detail-name></span>
        </button>
        <span class="chip" data-detail-chip></span>
      </header>
      <div class="detail-body">
        <p class="detail-line detail-line--target" data-detail-target></p>
        <p class="detail-line detail-line--deadline" data-detail-deadline hidden></p>
        <p class="detail-line detail-line--why" data-detail-why hidden></p>
        <p class="detail-line detail-line--recourse" data-detail-recourse hidden></p>
        <p class="detail-line detail-line--meta" data-detail-meta hidden></p>
        <p class="detail-line detail-line--confidence" data-detail-confidence hidden></p>
      </div>
    </section>
  </main>
  <template id="row-template">
    <li class="row">
      <button type="button" class="row__btn" data-row-button aria-controls="smart-task-detail" aria-label="Smart task">
        <span class="row__name" data-row-name></span>
        <span class="row__values" data-row-values></span>
        <span class="row__eta" data-row-eta></span>
        <span class="chip" data-row-chip></span>
      </button>
    </li>
  </template>
`;

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// The left-arrow chevron glyph the detail header used to leak as nav chrome on
// the dashboard surface (U+2190). Asserting on the codepoint keeps the test
// honest even if the markup author switches between &#8592; and the literal.
const LEFT_ARROW = '←';

describe('smart tasks widget detail view', () => {
  let activeController: ReturnType<typeof installWidget> | null = null;

  beforeEach(() => {
    // ?preview=1 renders the bundled PREVIEW_SMART_TASKS_PAYLOAD without an SDK.
    window.history.replaceState({}, '', '/?preview=1');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    document.body.innerHTML = WIDGET_MARKUP;
  });

  afterEach(() => {
    // Tear down the controller first: bootstrap() starts a 60s refresh interval +
    // document listeners; without destroy() they'd refresh against detached nodes
    // or leak open handles across tests.
    activeController?.destroy();
    activeController = null;
    document.body.className = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const openHotWaterDetail = async (): Promise<void> => {
    activeController = installWidget(window as WidgetWindow, document);
    expect(activeController).not.toBeNull();
    await flushPromises();
    // The "Hot water" preview row is the one carrying a plan-meta recap line.
    const row = document.querySelector(
      '[data-row-button][data-device-id="preview-hot-water"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();
    row?.click();
    await flushPromises();
  };

  test('detail header drops the leaked back-arrow glyph but keeps the back affordance', async () => {
    await openHotWaterDetail();

    const detailView = document.querySelector('[data-detail-view]') as HTMLElement;
    expect(detailView.hidden).toBe(false);

    const header = document.querySelector('.detail-header') as HTMLElement;
    // No leaked nav chevron — the dashboard tile is not a navigation stack.
    expect(header.textContent).not.toContain(LEFT_ARROW);
    expect(header.querySelector('.back-btn__chevron')).toBeNull();

    // The back button stays a real, labelled affordance with a return target.
    const backBtn = document.querySelector('[data-detail-back]') as HTMLButtonElement;
    expect(backBtn).not.toBeNull();
    expect(backBtn.getAttribute('aria-label')).toBe('Back to smart tasks');
    backBtn.click();
    await flushPromises();
    expect(detailView.hidden).toBe(true);
    expect((document.querySelector('[data-list-view]') as HTMLElement).hidden).toBe(false);
  });

  test('plan-meta recap renders the labelled estimate, keeping the banded range', async () => {
    await openHotWaterDetail();

    const meta = document.querySelector('[data-detail-meta]') as HTMLElement;
    expect(meta.hidden).toBe(false);
    // One-word label leads the dense recap so it is no longer the dimmest,
    // least-legible line; the banded energy range is preserved intact.
    expect(meta.textContent?.startsWith('Estimate ')).toBe(true);
    expect(meta.textContent).toContain('kWh');
  });
});
