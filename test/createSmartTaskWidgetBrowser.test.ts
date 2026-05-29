import {
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../packages/shared-domain/src/deadlineLabels';
import { installWidget } from '../widgets/create_smart_task/src/public/widgetApp';
import type { WidgetHomey, WidgetWindow } from '../widgets/create_smart_task/src/public/widgetApp';

// Mirrors the production index.html markup the renderer queries against, so the
// controller wires up exactly as it would in the Homey webview.
const WIDGET_MARKUP = `
  <main id="widget-root" class="widget-root" data-view="picker" aria-label="New smart task">
    <section class="picker-view" data-picker-view>
      <p class="step-title" data-picker-prompt>Choose a device</p>
      <ol class="rows" data-device-list></ol>
      <p class="empty" data-picker-empty hidden></p>
      <p class="empty-hint" data-picker-empty-hint hidden></p>
    </section>
    <section class="compose-view" data-compose-view hidden>
      <header class="step-header">
        <button type="button" class="back-btn" data-compose-back>
          <span class="back-btn__name" data-compose-title></span>
        </button>
      </header>
      <div class="field">
        <span class="field__label" data-goal-label>Goal</span>
        <div class="stepper">
          <button type="button" class="stepper__btn" data-goal-dec>-</button>
          <span class="stepper__value" data-goal-value></span>
          <button type="button" class="stepper__btn" data-goal-inc>+</button>
        </div>
      </div>
      <p class="goal-context" data-goal-context hidden></p>
      <div class="field">
        <span class="field__label" data-ready-by-label>Ready by</span>
        <div class="chip-row" data-ready-by-list></div>
      </div>
      <p class="ready-by-echo" data-ready-by-echo hidden></p>
      <button type="button" class="primary-btn" data-preview-btn>Preview</button>
    </section>
    <section class="preview-view" data-preview-view hidden>
      <header class="step-header">
        <button type="button" class="back-btn" data-preview-back>
          <span class="back-btn__name" data-preview-title>Preview</span>
        </button>
      </header>
      <div class="preview-body">
        <p class="preview-line preview-line--cost" data-preview-cost hidden></p>
        <p class="preview-line preview-line--cost-subtext" data-preview-cost-subtext hidden></p>
        <p class="preview-line preview-line--when" data-preview-when hidden></p>
        <p class="preview-line preview-line--energy" data-preview-energy hidden></p>
        <p class="preview-line preview-line--unavailable" data-preview-unavailable hidden></p>
        <p class="preview-line preview-line--caveat" data-preview-caveat hidden></p>
        <p class="preview-line preview-line--error" data-preview-error hidden></p>
      </div>
      <button type="button" class="primary-btn" data-create-btn>Create smart task</button>
    </section>
    <section class="created-view" data-created-view hidden>
      <p class="created-msg" data-created-msg></p>
    </section>
  </main>
  <template id="device-template">
    <li class="row">
      <button type="button" class="row__btn" data-device-button>
        <span class="row__name" data-device-name></span>
        <span class="row__meta" data-device-meta></span>
      </button>
    </li>
  </template>
  <template id="ready-by-template">
    <button type="button" class="chip-btn" data-ready-by aria-pressed="false"></button>
  </template>
`;

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const click = (selector: string): void => {
  (document.querySelector(selector) as HTMLElement).click();
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const DEVICE_A = {
  deviceId: 'd1',
  deviceName: 'Heater',
  kind: 'temperature',
  unitSymbol: '°C',
  goalMin: 5,
  goalMax: 85,
  goalStep: 0.5,
  defaultGoal: 65,
  currentValue: 48,
};
const DEVICE_B = {
  ...DEVICE_A,
  deviceId: 'd2',
  deviceName: 'Water heater',
  defaultGoal: 70,
  currentValue: 55,
};

const OK_PREVIEW = {
  ok: true as const,
  deadlineAtMs: Date.now() + 60 * 60 * 1000,
  deadlineLabel: 'Today 07:00',
  scheduledWindowLabel: '02:00–04:00',
  estimate: {
    status: 'on_track' as const,
    scheduledHours: [{ startsAtMs: Date.now(), plannedKWh: 2 }],
    projectedFinishAtMs: Date.now() + 2 * 60 * 60 * 1000,
    energyEstimateKWh: 2,
    energyExpectedKWh: 1.8,
    costEstimate: 3.4,
    costUnit: 'kr',
  },
};

describe('create smart task widget browser', () => {
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

  // FIX A (Ft7H6): a real boot (NOT ?preview=1) where the SDK bridge never
  // supplies an API client must never show canned sample devices as if real,
  // and must never let create report success without a real /create call.
  describe('real boot with no API client', () => {
    test('shows a not-ready state instead of canned sample devices, so create is unreachable', async () => {
      const controller = installWidget(window as WidgetWindow, document);
      expect(controller).not.toBeNull();
      // No onHomeyReady → bootstrapWithoutHomey wires the controller with null.
      await flushPromises();

      const list = document.querySelector('[data-device-list]') as HTMLElement;
      const empty = document.querySelector('[data-picker-empty]') as HTMLElement;
      // The picker shows the transient "connecting" copy, NOT the sample rows —
      // with no device to select, the user can never reach preview/create.
      expect(list.hidden).toBe(true);
      expect(list.querySelectorAll('[data-device-button]')).toHaveLength(0);
      expect(empty.hidden).toBe(false);
      expect(empty.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.notReady);

      // The widget never enters the success state on a real boot with no client.
      const root = document.getElementById('widget-root') as HTMLElement;
      expect(root.dataset.view).toBe('picker');
    });

    // Even if a client is briefly present for the device list + preview but then
    // disappears (or /create transport fails) before create, create must report
    // the failure and NOT flash "Created". Here the client's /create always
    // rejects with `unavailable`, standing in for "no real create happened".
    test('create with a failing /create reports an error, never a created flash', async () => {
      const previewResponse = {
        ok: true as const,
        deadlineAtMs: Date.now() + 60 * 60 * 1000,
        deadlineLabel: 'Today 07:00',
        scheduledWindowLabel: '02:00–04:00',
        estimate: {
          status: 'on_track' as const,
          scheduledHours: [{ startsAtMs: Date.now(), plannedKWh: 2 }],
          projectedFinishAtMs: Date.now() + 2 * 60 * 60 * 1000,
          energyEstimateKWh: 2,
          energyExpectedKWh: 1.8,
          costEstimate: 3.4,
          costUnit: 'kr',
        },
      };
      const createCalls: unknown[] = [];
      const homey: WidgetHomey = {
        api: async (method: string, path: string, body?: unknown) => {
          if (method === 'GET' && path === '/devices') {
            return {
              state: 'ready',
              devices: [{
                deviceId: 'd1',
                deviceName: 'Heater',
                kind: 'temperature',
                unitSymbol: '°C',
                goalMin: 5,
                goalMax: 85,
                goalStep: 0.5,
                defaultGoal: 65,
                currentValue: 48,
              }],
            };
          }
          if (method === 'POST' && path === '/preview') return previewResponse;
          if (method === 'POST' && path === '/create') {
            createCalls.push(body);
            return { ok: false, reason: 'unavailable' };
          }
          throw new Error(`unexpected api ${method} ${path}`);
        },
        ready: () => undefined,
      };

      const controller = installWidget(window as WidgetWindow, document);
      expect(controller).not.toBeNull();
      // The Homey SDK bridge wires the real client in via onHomeyReady.
      (window as WidgetWindow).onHomeyReady?.(homey);
      await flushPromises();

      click('[data-device-button]');
      click('[data-preview-btn]');
      await flushPromises();
      click('[data-create-btn]');
      await flushPromises();

      // A real /create round-trip was attempted (it failed) — and the failure is
      // surfaced as an error, never an optimistic "Created".
      expect(createCalls).toHaveLength(1);
      const root = document.getElementById('widget-root') as HTMLElement;
      expect(root.dataset.view).not.toBe('created');
      const createdView = document.querySelector('[data-created-view]') as HTMLElement;
      expect(createdView.hidden).toBe(true);
      const errorEl = document.querySelector('[data-preview-error]') as HTMLElement;
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.createError);
    });
  });

  // FIX Fu-Ev: the Create button must read as work-in-progress ("Creating…")
  // while the /create round-trip is PENDING, and must only ever show the success
  // label after a confirmed `{ ok: true }` — never while pending or after a
  // failure.
  describe('create button never shows success while pending or failed', () => {
    test('PENDING shows the progress label, not the success label', async () => {
      const createGate = defer<{ ok: boolean; reason?: string }>();
      const homey: WidgetHomey = {
        api: async (method: string, path: string) => {
          if (method === 'GET' && path === '/devices') return { state: 'ready', devices: [DEVICE_A] };
          if (method === 'POST' && path === '/preview') return OK_PREVIEW;
          if (method === 'POST' && path === '/create') return createGate.promise;
          throw new Error(`unexpected api ${method} ${path}`);
        },
        ready: () => undefined,
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey);
      await flushPromises();

      click('[data-device-button]');
      click('[data-preview-btn]');
      await flushPromises();
      click('[data-create-btn]');
      await flushPromises();

      // While /create is in flight the button reads "Creating…" (disabled),
      // never the "Smart task created" success label, and the success view is
      // not shown.
      const createBtn = document.querySelector('[data-create-btn]') as HTMLButtonElement;
      expect(createBtn.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.creating);
      expect(createBtn.textContent).not.toBe(CREATE_SMART_TASK_WIDGET_COPY.created);
      expect(createBtn.disabled).toBe(true);
      const root = document.getElementById('widget-root') as HTMLElement;
      expect(root.dataset.view).toBe('preview');

      // Only once a confirmed { ok: true } lands does the success view render.
      createGate.resolve({ ok: true });
      await flushPromises();
      expect(root.dataset.view).toBe('created');
      const createdMsg = document.querySelector('[data-created-msg]') as HTMLElement;
      expect(createdMsg.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.created);
    });

    test('a failed /create shows the error and leaves the button on its create label, never "created"', async () => {
      const homey: WidgetHomey = {
        api: async (method: string, path: string) => {
          if (method === 'GET' && path === '/devices') return { state: 'ready', devices: [DEVICE_A] };
          if (method === 'POST' && path === '/preview') return OK_PREVIEW;
          if (method === 'POST' && path === '/create') return { ok: false, reason: 'write_conflict' };
          throw new Error(`unexpected api ${method} ${path}`);
        },
        ready: () => undefined,
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey);
      await flushPromises();

      click('[data-device-button]');
      click('[data-preview-btn]');
      await flushPromises();
      click('[data-create-btn]');
      await flushPromises();

      const root = document.getElementById('widget-root') as HTMLElement;
      expect(root.dataset.view).toBe('preview');
      const createBtn = document.querySelector('[data-create-btn]') as HTMLButtonElement;
      // write_conflict collapses to the retryable generic create error (shared
      // copy), and the button reverts to its create label — never "created".
      expect(createBtn.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.createButton);
      expect(createBtn.textContent).not.toBe(CREATE_SMART_TASK_WIDGET_COPY.created);
      const errorEl = document.querySelector('[data-preview-error]') as HTMLElement;
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.createError);
    });
  });

  // FIX Fu-Ey: a slow preview/create that resolves AFTER the user backed out or
  // switched devices must be ignored (latest-request-wins) so it can't replace
  // the current view with a stale preview the user could then Create from.
  describe('stale preview/create responses are ignored after navigation', () => {
    test('a preview resolving after the user switched devices does not clobber the current view', async () => {
      const previewGates: Array<Deferred<typeof OK_PREVIEW>> = [];
      const homey: WidgetHomey = {
        api: async (method: string, path: string) => {
          if (method === 'GET' && path === '/devices') {
            return { state: 'ready', devices: [DEVICE_A, DEVICE_B] };
          }
          if (method === 'POST' && path === '/preview') {
            const gate = defer<typeof OK_PREVIEW>();
            previewGates.push(gate);
            return gate.promise;
          }
          throw new Error(`unexpected api ${method} ${path}`);
        },
        ready: () => undefined,
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey);
      await flushPromises();

      // Select device A, fire its preview (still pending), then back out and
      // select device B — landing on B's compose view.
      click('[data-device-button][data-device-id="d1"]');
      click('[data-preview-btn]');
      await flushPromises();
      expect(previewGates).toHaveLength(1);
      click('[data-preview-back]');
      click('[data-device-button][data-device-id="d2"]');

      const root = document.getElementById('widget-root') as HTMLElement;
      expect(root.dataset.view).toBe('compose');
      const composeTitle = document.querySelector('[data-compose-title]') as HTMLElement;
      expect(composeTitle.textContent).toBe(DEVICE_B.deviceName);

      // Device A's stale preview now resolves — it must be dropped: the view
      // stays on device B's compose, not flipped to a preview.
      previewGates[0].resolve(OK_PREVIEW);
      await flushPromises();
      expect(root.dataset.view).toBe('compose');
      expect(composeTitle.textContent).toBe(DEVICE_B.deviceName);
    });
  });
});
