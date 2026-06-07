// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { STARVATION_RESCUE_WIDGET_COPY } from '../../packages/shared-domain/src/planStarvation';
import { SMART_TASK_EXTRA_PERMISSION_LABELS } from '../../packages/shared-domain/src/deadlineLabels';
import { installWidget } from '../../widgets/starvation_rescue/src/public/widgetApp';
import type { WidgetHomey, WidgetWindow } from '../../widgets/starvation_rescue/src/public/widgetApp';
import type {
  StarvationRescueDevicesPayload,
  StarvationRescuePreviewResponse,
} from '../../widgets/starvation_rescue/src/starvationRescueWidgetTypes';
import { registerHiddenGuardSuite } from '../cssTestUtils';

// Mirrors the production index.html markup the renderer queries against.
const WIDGET_MARKUP = `
  <main id="widget-root" class="widget-root" data-view="list">
    <section class="list-view" data-list-view>
      <h1 class="list-title" data-list-title hidden></h1>
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
        <p class="preview-line" data-confirm-at-cap hidden></p>
        <div class="preview-chart" data-confirm-chart hidden></div>
        <p class="preview-line" data-confirm-when hidden></p>
        <p class="preview-line" data-confirm-energy hidden></p>
        <p class="preview-line" data-confirm-unavailable hidden></p>
        <p class="preview-line" data-confirm-caveat hidden></p>
        <p class="preview-line" data-confirm-error hidden></p>
        <div class="extra-perms-summary" data-confirm-perms hidden>
          <p class="extra-perms-summary__title" data-confirm-perms-title></p>
          <ul class="extra-perms-summary__list" data-confirm-perms-list></ul>
        </div>
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
    { deviceId: 'budget-1', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 42 * 60_000, intendedNormalTargetC: 65, hasSmartTask: false },
    { deviceId: 'cap-1', deviceName: 'Living room', cause: 'capacity', accumulatedMs: 11 * 60_000, intendedNormalTargetC: 21, hasSmartTask: false },
    // Budget-held, but it already has its own smart task → shown, no rescue button.
    { deviceId: 'task-1', deviceName: 'Cabin water', cause: 'budget', accumulatedMs: 30 * 60_000, intendedNormalTargetC: 60, hasSmartTask: true },
  ],
};

// Floor to the current clock hour so a scheduled "current hour" entry matches
// what the at-cap backend derivation compares against.
const HOUR_FLOOR = Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000);

const OK_PREVIEW = {
  ok: true as const,
  deadlineAtMs: Date.now() + 3 * 60 * 60 * 1000,
  deadlineLabel: 'Today 17:00',
  scheduledWindowLabel: '14:00–16:00',
  estimate: {
    status: 'on_track' as const,
    scheduledHours: [{ startsAtMs: HOUR_FLOOR, plannedKWh: 1.5 }],
    projectedFinishAtMs: Date.now() + 2 * 60 * 60 * 1000,
    energyEstimateKWh: 1.5,
    energyExpectedKWh: 1.4,
    costEstimate: 2.1,
    costUnit: 'kr',
    // A two-point price curve so the shared chart has something to draw.
    priceSeries: [
      { startsAtMs: HOUR_FLOOR, price: 0.9 },
      { startsAtMs: HOUR_FLOOR + 60 * 60 * 1000, price: 1.4 },
    ],
    // The default fixture is an eligible (stepped-load, top-priority) device, so
    // both rescue permissions survive the backend gate.
    grantedRescuePermissions: { exemptFromBudget: true, limitLowerPriorityDevices: true },
  },
};

const buildHomey = (overrides: Partial<Record<string, unknown>> = {}): WidgetHomey => ({
  ready: vi.fn(),
  api: vi.fn(async (method: string, path: string) => {
    if (path === '/devices') return READY_PAYLOAD;
    if (path === '/preview') return OK_PREVIEW;
    // Create resolves the honest flash: the default happy path runs the current hour.
    if (path === '/rescue') return { ok: true, runsCurrentHour: true };
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
    // The header names what the widget shows; with nothing held back it is hidden
    // so the calm empty line stands alone.
    expect((document.querySelector('[data-list-title]') as HTMLElement).hidden).toBe(true);
  });

  test('renders a list with tone-by-duration and the budget-only rescue guardrail', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey());
    await flushPromises();

    // The header names what the widget shows once a device is held back.
    const title = document.querySelector('[data-list-title]') as HTMLElement;
    expect(title.hidden).toBe(false);
    expect(title.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.headerTitle);

    const rows = document.querySelectorAll('[data-device-list] .row');
    expect(rows).toHaveLength(3);

    const [budgetRow, capacityRow, taskRow] = Array.from(rows) as HTMLElement[];
    // Budget row: 42 min ⇒ danger tone, offers a rescue button, no muted note.
    expect(budgetRow.dataset.tone).toBe('danger');
    expect((budgetRow.querySelector('[data-device-chip]') as HTMLElement).textContent).toBe('Held back · 42 min');
    expect((budgetRow.querySelector('[data-device-subtext]') as HTMLElement).textContent).toBe('Held below 65° by today’s budget');
    const budgetBtn = budgetRow.querySelector('[data-rescue-button]') as HTMLButtonElement;
    expect(budgetBtn.hidden).toBe(false);
    expect(budgetBtn.dataset.deviceId).toBe('budget-1');
    expect((budgetRow.querySelector('[data-device-note]') as HTMLElement).hidden).toBe(true);

    // Capacity row: 11 min ⇒ warn tone, NO rescue button (the guardrail).
    // Chip reads "Waiting", never the budget-releasable "Held back" (the hard cap
    // is physical — a capacity row is not something the user can let run now).
    expect(capacityRow.dataset.tone).toBe('warn');
    expect((capacityRow.querySelector('[data-device-chip]') as HTMLElement).textContent).toBe('Waiting · 11 min');
    expect((capacityRow.querySelector('[data-rescue-button]') as HTMLButtonElement).hidden).toBe(true);
    // The capacity subtext already reads "Waiting for available power"; the note
    // ("Waiting for available power.") only restates it, so it is suppressed to
    // avoid printing the same reason twice (differs only by a trailing period).
    expect((capacityRow.querySelector('[data-device-subtext]') as HTMLElement).textContent)
      .toBe('Waiting for available power');
    const note = capacityRow.querySelector('[data-device-note]') as HTMLElement;
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe('');

    // Task-owning budget row: SHOWN (visibility preserved) but NO rescue button —
    // and an explanatory note so the missing button isn't a mystery.
    expect((taskRow.querySelector('[data-rescue-button]') as HTMLButtonElement).hidden).toBe(true);
    const taskNote = taskRow.querySelector('[data-device-note]') as HTMLElement;
    expect(taskNote.hidden).toBe(false);
    expect(taskNote.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.smartTaskNote);
  });

  test('budget row with no known target hides the rescue button (API would reject no_target)', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') {
          return {
            state: 'ready',
            devices: [
              { deviceId: 'budget-no-target', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 20 * 60_000, intendedNormalTargetC: null, hasSmartTask: false },
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

  test('the confirm sheet renders the shared price-graph chart for the rescued device', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey());
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    // The same chart the create widget renders: an SVG price curve with the
    // scheduled hour shaded. Shown because the preview carries a price series.
    const chart = document.querySelector('[data-confirm-chart]') as HTMLElement;
    expect(chart.hidden).toBe(false);
    const svg = chart.querySelector('svg.pchart');
    expect(svg).not.toBeNull();
    // Stepped price line + the scheduled-hour band the shared renderer draws.
    expect(chart.querySelector('.pchart__line')).not.toBeNull();
    expect(chart.querySelector('.pchart__band')).not.toBeNull();
  });

  test('an eligible device shows BOTH canonical granted Extra permissions', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey());
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const perms = document.querySelector('[data-confirm-perms]') as HTMLElement;
    expect(perms.hidden).toBe(false);
    expect((document.querySelector('[data-confirm-perms-title]') as HTMLElement).textContent)
      .toBe(STARVATION_RESCUE_WIDGET_COPY.extraPermissionsTitle);
    // Both standing permissions the rescue grants, using the canonical labels
    // (shared with the create widget's toggles + runtime log breadcrumbs).
    const items = Array.from(document.querySelectorAll('[data-confirm-perms-list] li'))
      .map((li) => li.textContent);
    expect(items).toEqual([
      SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget,
      SMART_TASK_EXTRA_PERMISSION_LABELS.limitLowerPriorityDevices,
    ]);
  });

  test('a non-eligible device shows ONLY the budget permission (honest gated summary)', async () => {
    // The backend gate dropped `limitLowerPriorityDevices` (the device can't use
    // the boost), so the estimate reports only `exemptFromBudget` as granted — the
    // summary must not claim a permission the rescue won't grant.
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') {
          return {
            ...OK_PREVIEW,
            estimate: {
              ...OK_PREVIEW.estimate,
              grantedRescuePermissions: { exemptFromBudget: true, limitLowerPriorityDevices: false },
            },
          };
        }
        if (path === '/rescue') return { ok: true, runsCurrentHour: true };
        throw new Error(`unexpected ${path}`);
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const perms = document.querySelector('[data-confirm-perms]') as HTMLElement;
    expect(perms.hidden).toBe(false);
    const items = Array.from(document.querySelectorAll('[data-confirm-perms-list] li'))
      .map((li) => li.textContent);
    expect(items).toEqual([SMART_TASK_EXTRA_PERMISSION_LABELS.exemptFromBudget]);
  });

  test('a preview with no granted permissions hides the Extra permissions summary', async () => {
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') {
          const { grantedRescuePermissions: _omit, ...estimate } = OK_PREVIEW.estimate;
          return { ...OK_PREVIEW, estimate };
        }
        if (path === '/rescue') return { ok: true, runsCurrentHour: true };
        throw new Error(`unexpected ${path}`);
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const perms = document.querySelector('[data-confirm-perms]') as HTMLElement;
    expect(perms.hidden).toBe(true);
  });

  test('an at-cap preview surfaces the factual honesty note', async () => {
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') {
          return { ...OK_PREVIEW, estimate: { ...OK_PREVIEW.estimate, atCapNow: true } };
        }
        if (path === '/rescue') return { ok: true, runsCurrentHour: false };
        throw new Error(`unexpected ${path}`);
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const atCap = document.querySelector('[data-confirm-at-cap]') as HTMLElement;
    expect(atCap.hidden).toBe(false);
    expect(atCap.textContent).toBe(STARVATION_RESCUE_WIDGET_COPY.atCapNote);
  });

  test('a preview that is NOT at cap hides the at-cap note', async () => {
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(buildHomey());
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    // OK_PREVIEW carries no `atCapNow`, so the honesty note stays hidden.
    expect((document.querySelector('[data-confirm-at-cap]') as HTMLElement).hidden).toBe(true);
  });

  test('a still-queued create confirms to the honest "queued" flash, not "on the way"', async () => {
    // The create response (authoritative, post-persist) reports the device is NOT
    // running in the current hour — still queued behind cheaper later hours — so
    // the flash must not promise power is on the way. The flash reads the CREATE
    // response, never the (possibly stale) preview-time value.
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') return OK_PREVIEW;
        if (path === '/rescue') return { ok: true, runsCurrentHour: false };
        throw new Error(`unexpected ${path}`);
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
    expect(root.dataset.view).toBe('done');
    expect((document.querySelector('[data-done-msg]') as HTMLElement).textContent)
      .toBe(STARVATION_RESCUE_WIDGET_COPY.rescueDoneQueued);
  });

  test('a cannot-finish rescue preview is visibly distinct and cannot be confirmed', async () => {
    const rescueCalls: unknown[] = [];
    const cannotMeetPreview: StarvationRescuePreviewResponse = {
      ...OK_PREVIEW,
      estimate: { ...OK_PREVIEW.estimate, status: 'cannot_meet' },
    };
    const homey = buildHomey({
      api: vi.fn(async (_method: string, path: string, body?: unknown) => {
        if (path === '/devices') return READY_PAYLOAD;
        if (path === '/preview') return cannotMeetPreview;
        if (path === '/rescue') { rescueCalls.push(body); return { ok: true, runsCurrentHour: true }; }
        throw new Error(`unexpected ${path}`);
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    controller!.bootstrap(homey);
    await flushPromises();

    click('[data-rescue-button]');
    await flushPromises();

    const statusLine = document.querySelector('[data-confirm-unavailable]') as HTMLElement;
    expect(statusLine.hidden).toBe(false);
    expect(statusLine.textContent).toContain('Cannot finish');
    const confirmBtn = document.querySelector('[data-confirm-btn]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    click('[data-confirm-btn]');
    await flushPromises();
    expect(rescueCalls).toHaveLength(0);
  });

  test('does not render the list when an in-flight /devices load resolves after destroy()', async () => {
    let resolveDevices: (payload: StarvationRescueDevicesPayload) => void = () => {};
    const devicesPromise = new Promise<StarvationRescueDevicesPayload>((resolve) => {
      resolveDevices = resolve;
    });
    const ready = vi.fn();
    const homey = buildHomey({
      ready,
      api: vi.fn(async (_method: string, path: string) => {
        if (path === '/devices') return devicesPromise;
        throw new Error(`unexpected ${path}`);
      }),
    });
    const controller = installWidget(window as WidgetWindow, document);
    // Let the initial no-Homey bootstrap settle, then isolate the assertion to the
    // real-Homey load below (clear the ready spy so we only judge the guarded path).
    await flushPromises();
    ready.mockClear();

    controller!.bootstrap(homey); // starts loadAndRender, suspended on the pending /devices
    await flushPromises();

    controller!.destroy(); // tear down before the load resolves
    resolveDevices(READY_PAYLOAD);
    await flushPromises();

    // The late resolution must not render the list nor call ready() post-teardown.
    const list = document.querySelector('[data-device-list]') as HTMLElement;
    expect(list.children).toHaveLength(0);
    expect(ready).not.toHaveBeenCalled();
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

// The renderer hides views (.list-view/.confirm-view/.done-view), the per-row
// rescue button (.rescue-btn), the device list (.rows) and several preview
// lines by toggling the `hidden` attribute, so a hidden view would show flex or
// a non-rescuable row's rescue button would appear (breaking the budget-only
// guardrail) without the blanket reset. See test/cssTestUtils.ts for the shared
// parsing + guard assertions.
registerHiddenGuardSuite({
  name: 'starvation rescue widget hidden-element CSS',
  cssRelativePath: 'widgets/starvation_rescue/public/index.css',
  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  hiddenToggledSelectors: [
    '.list-view', '.confirm-view', '.done-view', // views
    '.rescue-btn', // per-row rescue button (the missed element this PR fixes)
    '.rows', // device list (hidden when the payload is empty)
    '.list-title', // header (hidden in the calm empty state)
    '.list-more', '.empty', // list affordances
    '.consequence', '.preview-line', '.done-msg', '.row__note', // toggled text lines
    '.preview-chart', // shared price chart (hidden when nothing chartable)
    '.extra-perms-summary', // read-only permissions summary
  ],
});
