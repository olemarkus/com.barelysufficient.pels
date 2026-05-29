import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { STARVATION_RESCUE_WIDGET_COPY } from '../packages/shared-domain/src/planStarvation';
import { installWidget } from '../widgets/starvation_rescue/src/public/widgetApp';
import type { WidgetHomey, WidgetWindow } from '../widgets/starvation_rescue/src/public/widgetApp';
import type { StarvationRescueDevicesPayload } from '../widgets/starvation_rescue/src/starvationRescueWidgetTypes';

// Mirrors the production index.html markup the renderer queries against.
const WIDGET_MARKUP = `
  <main id="widget-root" class="widget-root" data-view="list">
    <section class="list-view" data-list-view>
      <ol class="rows" data-device-list></ol>
      <p class="list-more" data-list-more hidden></p>
      <p class="empty" data-list-empty hidden></p>
    </section>
    <section class="confirm-view" data-confirm-view hidden>
      <header class="step-header">
        <button type="button" class="back-btn" data-confirm-back>
          <span class="back-btn__name" data-confirm-title></span>
        </button>
      </header>
      <p class="consequence" data-confirm-consequence></p>
      <div class="preview-body">
        <p class="preview-line" data-confirm-cost hidden></p>
        <p class="preview-line" data-confirm-when hidden></p>
        <p class="preview-line" data-confirm-energy hidden></p>
        <p class="preview-line" data-confirm-unavailable hidden></p>
        <p class="preview-line" data-confirm-caveat hidden></p>
        <p class="preview-line" data-confirm-error hidden></p>
      </div>
      <button type="button" class="primary-btn" data-confirm-btn>Confirm</button>
    </section>
    <section class="done-view" data-done-view hidden>
      <p class="done-msg" data-done-msg></p>
    </section>
  </main>
  <template id="device-template">
    <li class="row" data-tone="warn">
      <div class="row__main">
        <span class="row__name" data-device-name></span>
        <span class="row__chip" data-device-chip></span>
      </div>
      <span class="row__subtext" data-device-subtext></span>
      <p class="row__note" data-device-note hidden></p>
      <button type="button" class="rescue-btn" data-rescue-button hidden></button>
    </li>
  </template>
`;

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const click = (selector: string): void => {
  (document.querySelector(selector) as HTMLElement).click();
};

const READY_PAYLOAD: StarvationRescueDevicesPayload = {
  state: 'ready',
  devices: [
    { deviceId: 'budget-1', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 42 * 60_000, intendedNormalTargetC: 65 },
    { deviceId: 'cap-1', deviceName: 'Living room', cause: 'capacity', accumulatedMs: 11 * 60_000, intendedNormalTargetC: 21 },
  ],
};

const OK_PREVIEW = {
  ok: true as const,
  deadlineAtMs: Date.now() + 3 * 60 * 60 * 1000,
  deadlineLabel: 'Today 17:00',
  scheduledWindowLabel: '14:00–16:00',
  estimate: {
    status: 'on_track' as const,
    scheduledHours: [{ startsAtMs: Date.now(), plannedKWh: 1.5 }],
    projectedFinishAtMs: Date.now() + 2 * 60 * 60 * 1000,
    energyEstimateKWh: 1.5,
    energyExpectedKWh: 1.4,
    costEstimate: 2.1,
    costUnit: 'kr',
  },
};

const buildHomey = (overrides: Partial<Record<string, unknown>> = {}): WidgetHomey => ({
  ready: vi.fn(),
  api: vi.fn(async (method: string, path: string) => {
    if (path === '/devices') return READY_PAYLOAD;
    if (path === '/preview') return OK_PREVIEW;
    if (path === '/rescue') return { ok: true };
    throw new Error(`unexpected ${method} ${path}`);
  }),
  ...overrides,
} as WidgetHomey);

describe('starvation rescue widget browser', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).Homey;
    delete (window as WidgetWindow).onHomeyReady;
    document.body.innerHTML = WIDGET_MARKUP;
  });

  afterEach(() => {
    document.body.className = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('real boot with no API client shows the connecting state, not canned data', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    expect(controller).not.toBeNull();
    await flushPromises();

    const list = document.querySelector('[data-device-list]') as HTMLElement;
    const empty = document.querySelector('[data-list-empty]') as HTMLElement;
    expect(list.hidden).toBe(true);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.notReady);
  });

  test('empty payload renders the calm steady-state subtitle', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    const homey = buildHomey({
      api: vi.fn(async () => ({ state: 'empty', subtitle: STARVATION_RESCUE_WIDGET_COPY.emptySubtitle })),
    });
    (window as WidgetWindow).onHomeyReady?.(homey);
    controller!.bootstrap(homey);
    await flushPromises();

    const empty = document.querySelector('[data-list-empty]') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.emptySubtitle);
  });

  test('renders a list with tone-by-duration and the budget-only rescue guardrail', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey());
    await flushPromises();

    const rows = document.querySelectorAll('[data-device-list] .row');
    expect(rows).toHaveLength(2);

    const [budgetRow, capacityRow] = Array.from(rows) as HTMLElement[];
    // Budget row: 42 min ⇒ danger tone, offers a rescue button, no muted note.
    expect(budgetRow.dataset.tone).toBe('danger');
    expect((budgetRow.querySelector('[data-device-chip]') as HTMLElement).textContent).toBe('Starved · 42 min');
    expect((budgetRow.querySelector('[data-device-subtext]') as HTMLElement).textContent).toBe('Held below 65° by today’s budget');
    const budgetBtn = budgetRow.querySelector('[data-rescue-button]') as HTMLButtonElement;
    expect(budgetBtn.hidden).toBe(false);
    expect(budgetBtn.dataset.deviceId).toBe('budget-1');
    expect((budgetRow.querySelector('[data-device-note]') as HTMLElement).hidden).toBe(true);

    // Capacity row: 11 min ⇒ warn tone, NO rescue button (the guardrail), a note instead.
    expect(capacityRow.dataset.tone).toBe('warn');
    expect((capacityRow.querySelector('[data-rescue-button]') as HTMLButtonElement).hidden).toBe(true);
    const note = capacityRow.querySelector('[data-device-note]') as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.capacityNote);
  });

  test('budget row with no known target hides the rescue button (API would reject no_target)', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') {
          return {
            state: 'ready',
            devices: [
              { deviceId: 'budget-no-target', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 20 * 60_000, intendedNormalTargetC: null },
            ],
          } satisfies StarvationRescueDevicesPayload;
        }
        throw new Error(`unexpected ${path}`);
      }),
    }));
    await flushPromises();

    const row = document.querySelector('[data-device-list] .row') as HTMLElement;
    // Budget-caused but no target to aim at: no rescue button is offered, so the
    // widget never sends a request the API rejects with `no_target`.
    expect((row.querySelector('[data-rescue-button]') as HTMLButtonElement).hidden).toBe(true);
    // No cause-specific note either (budget has none) — the row is just informational.
    expect((row.querySelector('[data-device-note]') as HTMLElement).hidden).toBe(true);
  });

  test('tapping a budget rescue previews then confirms to a success flash', async () => {
    const homey = buildHomey();
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const root = document.getElementById('widget-root') as HTMLElement;
    expect(root.dataset.view).toBe('confirm');
    // The honest consequence sits above the figures (money-action guardrail).
    expect((document.querySelector('[data-confirm-consequence]') as HTMLElement).textContent)
      .toBe(STARVATION_RESCUE_WIDGET_COPY.rescueConsequence);
    expect((document.querySelector('[data-confirm-cost]') as HTMLElement).hidden).toBe(false);

    click('[data-confirm-btn]');
    await flushPromises();

    expect(root.dataset.view).toBe('done');
    expect((document.querySelector('[data-done-msg]') as HTMLElement).textContent)
      .toBe(STARVATION_RESCUE_WIDGET_COPY.rescueDone);
    // The create echoes the deadline the preview resolved (not a fresh now+3h).
    expect((homey.api as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'POST', '/rescue', { deviceId: 'budget-1', deadlineAtMs: OK_PREVIEW.deadlineAtMs },
    );
  });

  test('a failing /rescue keeps the confirm view with an error, never a done flash', async () => {
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') return OK_PREVIEW;
        return { ok: false, reason: 'write_conflict' };
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();
    click('[data-confirm-btn]');
    await flushPromises();

    const root = document.getElementById('widget-root') as HTMLElement;
    expect(root.dataset.view).toBe('confirm');
    const error = document.querySelector('[data-confirm-error]') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueError);
  });
});

describe('starvation rescue widget hidden-element CSS', () => {
  // The renderer hides views (.list-view/.confirm-view/.done-view), the per-row
  // rescue button (.rescue-btn), the device list (.rows) and several preview
  // lines by toggling the `hidden` attribute. Any author-origin `display` rule
  // on such an element would beat the user-agent `[hidden] { display: none }`
  // rule on cascade origin (regardless of specificity), so the hidden element
  // would still render — a hidden view shows flex, or a non-rescuable row's
  // rescue button appears (breaking the budget-only guardrail). The fix is a
  // single blanket author-origin reset, `[hidden] { display: none !important }`,
  // which re-asserts the UA semantics for EVERY hidden-toggled element at once.
  // jsdom does not model author-over-UA origin precedence, so a
  // getComputedStyle assertion cannot distinguish the bug from the fix; we
  // instead pin the source guard that prevents it.
  // Resolve from the repo root (vitest cwd); import.meta.url is an http URL
  // under jsdom, so fileURLToPath is unavailable here.
  const cssPath = resolve(process.cwd(), 'widgets/starvation_rescue/public/index.css');
  // Strip `/* … */` comments first: the explanatory comments contain literal
  // `[hidden] { display: none }` examples whose braces would otherwise corrupt
  // the naive rule-block split below.
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  // Split into `selector { declarations }` rule blocks.
  const ruleBlocks = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
    selectors: m[1].trim(),
    body: m[2],
  }));

  const setsDisplay = (body: string): boolean => /(^|;|\{|\s)display\s*:/.test(body);

  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  const hiddenToggledSelectors = [
    '.list-view', '.confirm-view', '.done-view', // views
    '.rescue-btn', // per-row rescue button (the missed element this PR fixes)
    '.rows', // device list (hidden when the payload is empty)
    '.list-more', '.empty', // list affordances
    '.consequence', '.preview-line', '.done-msg', '.row__note', // toggled text lines
  ];

  const targetsSelector = (selectors: string, sel: string): boolean => (
    // The class appears as a complete token, not as a substring of another class.
    new RegExp(`(^|[\\s,>+~])${sel.replace('.', '\\.')}(?![\\w-])`).test(selectors)
  );

  const blanketReset = ruleBlocks.find(
    (b) => b.selectors === '[hidden]' && setsDisplay(b.body),
  );

  test('a blanket [hidden] reset re-asserts display:none for every hidden-toggled element', () => {
    // The single guard that covers the views, the rescue button, the list, and
    // any future hidden-toggled element in one place. Must be `!important` to
    // win against author `display` rules on the same element regardless of
    // source order — author-vs-author ties break on specificity/order, and
    // `[hidden]` is lower-specificity than the class rules it must override.
    expect(blanketReset).toBeDefined();
    expect(blanketReset!.body).toMatch(/display\s*:\s*none\s*!important/);
  });

  test('every hidden-toggled element is kept inert while hidden', () => {
    // Belt-and-suspenders: even if the blanket reset above were ever removed,
    // any `display` rule on a hidden-toggled selector must self-guard with
    // `:not([hidden])`. With the blanket reset present, this passes trivially
    // (the reset covers everything); without it, an unguarded `display` rule on
    // a hidden-toggled selector — like the original .rescue-btn bug — fails.
    if (blanketReset) return; // covered by the reset; nothing more to prove
    const unguarded = ruleBlocks
      .filter((b) => setsDisplay(b.body))
      .filter((b) => hiddenToggledSelectors.some((sel) => (
        targetsSelector(b.selectors, sel) && !b.selectors.includes(`${sel}:not([hidden])`)
      )));
    expect(unguarded).toEqual([]);
  });
});
