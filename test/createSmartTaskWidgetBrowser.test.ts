import {
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../packages/shared-domain/src/deadlineLabels';
import { installWidget } from '../widgets/create_smart_task/src/public/widgetApp';
import type { WidgetHomey, WidgetWindow } from '../widgets/create_smart_task/src/public/widgetApp';
import { registerHiddenGuardSuite } from './cssTestUtils';

// Mirrors the production index.html markup the renderer queries against, so the
// controller wires up exactly as it would in the Homey webview.
const WIDGET_MARKUP = `
  <main id="widget-root" class="widget-root" data-view="picker" aria-label="New smart task">
    <section class="picker-view" data-picker-view>
      <p class="step-title" data-picker-prompt>Choose a device</p>
      <p class="step-caption" data-picker-caption></p>
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
      <details class="extra-perms" data-extra-perms>
        <summary class="extra-perms__summary">
          <span class="extra-perms__title" data-extra-perms-title>Extra permissions</span>
          <span class="extra-perms__chevron" aria-hidden="true">&#9662;</span>
        </summary>
        <p class="extra-perms__hint" data-extra-perms-hint></p>
        <label class="perm-toggle">
          <input type="checkbox" class="perm-toggle__input" data-perm-budget-input />
          <span class="perm-toggle__text" data-perm-budget-label></span>
        </label>
        <label class="perm-toggle" data-perm-limit hidden>
          <input type="checkbox" class="perm-toggle__input" data-perm-limit-input />
          <span class="perm-toggle__text" data-perm-limit-label></span>
        </label>
        <p class="perm-toggle__note" data-perm-limit-note hidden></p>
      </details>
      <button type="button" class="primary-btn" data-preview-btn>Preview</button>
    </section>
    <section class="preview-view" data-preview-view hidden>
      <header class="step-header">
        <button type="button" class="back-btn" data-preview-back>
          <span class="back-btn__name" data-preview-title>Preview</span>
        </button>
      </header>
      <div class="preview-body">
        <p class="preview-line preview-line--feasibility" data-preview-feasibility hidden></p>
        <p class="preview-line preview-line--cost" data-preview-cost hidden></p>
        <p class="preview-line preview-line--cost-subtext" data-preview-cost-subtext hidden></p>
        <div class="preview-chart" data-preview-chart hidden></div>
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
        <span class="row__icon" data-device-icon role="img"></span>
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
  group: 'heating',
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
                group: 'heating',
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
      // write_conflict (transient save refusal — goal was valid) shows the
      // bespoke retry line, not the goal-blaming generic createError, and the
      // button reverts to its create label — never "created".
      expect(createBtn.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.createButton);
      expect(createBtn.textContent).not.toBe(CREATE_SMART_TASK_WIDGET_COPY.created);
      const errorEl = document.querySelector('[data-preview-error]') as HTMLElement;
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.writeConflict);
    });
  });

  // An unavailable preview must explain WHY honestly: a device with no learned
  // profile yet (`unavailableReason: 'needs_observation'`) gets the bespoke
  // "observe this device first" copy, never the (false) "no prices" line.
  describe('unavailable preview message reflects the backend reason', () => {
    const previewWith = (estimate: Record<string, unknown>) => ({
      ok: true as const,
      deadlineAtMs: Date.now() + 60 * 60 * 1000,
      deadlineLabel: 'Today 07:00',
      scheduledWindowLabel: '',
      estimate: { scheduledHours: [], projectedFinishAtMs: null, energyEstimateKWh: null, energyExpectedKWh: null, costEstimate: null, ...estimate },
    });

    const renderUnavailablePreview = async (estimate: Record<string, unknown>): Promise<HTMLElement> => {
      const homey: WidgetHomey = {
        api: async (method: string, path: string) => {
          if (method === 'GET' && path === '/devices') return { state: 'ready', devices: [DEVICE_A] };
          if (method === 'POST' && path === '/preview') return previewWith(estimate);
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
      return document.querySelector('[data-preview-unavailable]') as HTMLElement;
    };

    test('needs_observation shows the observe-the-device copy, not the no-prices line', async () => {
      const el = await renderUnavailablePreview({ status: 'unavailable', unavailableReason: 'needs_observation' });
      expect(el.hidden).toBe(false);
      expect(el.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.previewNeedsObservation);
      expect(el.textContent).not.toBe(CREATE_SMART_TASK_WIDGET_COPY.previewUnavailable);
      // The Create button stays enabled — an unprojectable candidate is still creatable.
      const createBtn = document.querySelector('[data-create-btn]') as HTMLButtonElement;
      expect(createBtn.disabled).toBe(false);
    });

    test('an unavailable preview with no reason keeps the generic line', async () => {
      const el = await renderUnavailablePreview({ status: 'unavailable' });
      expect(el.hidden).toBe(false);
      expect(el.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.previewUnavailable);
    });

    test('an already-met goal (satisfied, zero hours) shows the goal-met copy, not the no-prices line', async () => {
      // `satisfied` is projectable=false (zero scheduled hours) but is NOT an
      // unavailable cause — it must read as "already met", never "no prices".
      const el = await renderUnavailablePreview({ status: 'satisfied' });
      expect(el.hidden).toBe(false);
      expect(el.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.previewSatisfied);
      expect(el.textContent).not.toBe(CREATE_SMART_TASK_WIDGET_COPY.previewUnavailable);
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

  describe('feasibility warning', () => {
    const buildHomeyWithPreview = (preview: unknown): WidgetHomey => ({
      api: async (method: string, path: string) => {
        if (method === 'GET' && path === '/devices') return { state: 'ready', devices: [DEVICE_A] };
        if (method === 'POST' && path === '/preview') return preview;
        throw new Error(`unexpected api ${method} ${path}`);
      },
      ready: () => undefined,
    });

    test('a cannot_meet verdict surfaces the warning, not the missing-price line, and still allows create', async () => {
      const cannotMeetPreview = {
        ...OK_PREVIEW,
        estimate: { ...OK_PREVIEW.estimate, status: 'cannot_meet' as const },
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(buildHomeyWithPreview(cannotMeetPreview));
      await flushPromises();
      click('[data-device-button]');
      click('[data-preview-btn]');
      await flushPromises();

      const feasibility = document.querySelector('[data-preview-feasibility]') as HTMLElement;
      expect(feasibility.hidden).toBe(false);
      expect(feasibility.textContent).toBe(CREATE_SMART_TASK_WIDGET_COPY.cannotMeet);
      // The "no prices published" line must NOT also show — a cannot_meet is a
      // feasibility verdict, not a missing-price gap.
      const unavailable = document.querySelector('[data-preview-unavailable]') as HTMLElement;
      expect(unavailable.hidden).toBe(true);
      // Surfacing the risk is the fix; create stays reachable (the estimate
      // understates cannot_meet risk, so the user decides).
      const createBtn = document.querySelector('[data-create-btn]') as HTMLButtonElement;
      expect(createBtn.disabled).toBe(false);
    });

    test('an on_track verdict shows no feasibility warning', async () => {
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(buildHomeyWithPreview(OK_PREVIEW));
      await flushPromises();
      click('[data-device-button]');
      click('[data-preview-btn]');
      await flushPromises();

      const feasibility = document.querySelector('[data-preview-feasibility]') as HTMLElement;
      expect(feasibility.hidden).toBe(true);
    });
  });

  describe('extra permissions', () => {
    const steppedDevice = { ...DEVICE_A, deviceId: 'd-step', deviceName: 'EV charger', supportsLimitLowerPriority: true };
    const plainDevice = { ...DEVICE_A, supportsLimitLowerPriority: false };
    const buildHomey = (devices: unknown[], createCalls: unknown[]): WidgetHomey => ({
      api: async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/devices') return { state: 'ready', devices };
        if (method === 'POST' && path === '/preview') return OK_PREVIEW;
        if (method === 'POST' && path === '/create') { createCalls.push(body); return { ok: true }; }
        throw new Error(`unexpected api ${method} ${path}`);
      },
      ready: () => undefined,
    });
    const input = (sel: string): HTMLInputElement => document.querySelector(sel) as HTMLInputElement;

    test('offers limit-lower-priority only for an eligible device, gated behind budget, and sends both on create', async () => {
      const createCalls: unknown[] = [];
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(buildHomey([steppedDevice], createCalls));
      await flushPromises();
      click('[data-device-button]');

      // Offered (eligible) but DISABLED until budget exemption is on (inert alone).
      expect((document.querySelector('[data-perm-limit]') as HTMLElement).hidden).toBe(false);
      expect(input('[data-perm-limit-input]').disabled).toBe(true);

      click('[data-perm-budget-input]');
      expect(input('[data-perm-limit-input]').disabled).toBe(false);
      click('[data-perm-limit-input]');
      click('[data-preview-btn]');
      await flushPromises();
      click('[data-create-btn]');
      await flushPromises();

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({ exemptFromBudget: true, limitLowerPriorityDevices: true });
    });

    test('hides limit-lower-priority for an ineligible device; a budget-only create omits it', async () => {
      const createCalls: unknown[] = [];
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(buildHomey([plainDevice], createCalls));
      await flushPromises();
      click('[data-device-button]');

      expect((document.querySelector('[data-perm-limit]') as HTMLElement).hidden).toBe(true);
      click('[data-perm-budget-input]');
      click('[data-preview-btn]');
      await flushPromises();
      click('[data-create-btn]');
      await flushPromises();

      expect(createCalls[0]).toMatchObject({ exemptFromBudget: true });
      expect(createCalls[0]).not.toHaveProperty('limitLowerPriorityDevices');
    });

    test('turning budget exemption back off forces limit-lower-priority off too', async () => {
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(buildHomey([steppedDevice], []));
      await flushPromises();
      click('[data-device-button]');

      click('[data-perm-budget-input]');
      click('[data-perm-limit-input]');
      expect(input('[data-perm-limit-input]').checked).toBe(true);

      click('[data-perm-budget-input]'); // budget off → limit must reset off + disable
      expect(input('[data-perm-limit-input]').checked).toBe(false);
      expect(input('[data-perm-limit-input]').disabled).toBe(true);
    });
  });

  // Homey widgets don't scroll internally, so the widget sizes its iframe to the
  // rendered content via Homey.setHeight, driven by a ResizeObserver. jsdom ships
  // neither a ResizeObserver nor real layout, so install a controllable fake and
  // stub the measured height to exercise the reporting contract.
  describe('iframe height (Homey.setHeight)', () => {
    let triggers: Array<() => void>;
    const installFakeResizeObserver = (): void => {
      triggers = [];
      // A real (non-arrow) function so `new widgetWindow.ResizeObserver(...)`
      // constructs; returning an object makes `new` yield that observer stub.
      const Fake = function FakeResizeObserver(cb: ResizeObserverCallback) {
        return {
          observe: (): number => triggers.push(() => cb([], {} as ResizeObserver)),
          unobserve: (): undefined => undefined,
          disconnect: (): undefined => undefined,
        };
      };
      (window as WidgetWindow).ResizeObserver = Fake as unknown as typeof ResizeObserver;
    };
    const stubRootHeight = (px: number): void => {
      const root = document.getElementById('widget-root') as HTMLElement;
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ height: px } as DOMRect);
    };

    afterEach(() => {
      delete (window as WidgetWindow).ResizeObserver;
      document.body.style.padding = '';
    });

    test('reports content height plus body padding (rounded up), deduping repeats', async () => {
      installFakeResizeObserver();
      stubRootHeight(412.2);
      // Homey's .homey-widget-small pads the body around the root; the reported
      // height must include it or the iframe clips each view's bottom.
      document.body.style.paddingTop = '8px';
      document.body.style.paddingBottom = '8px';
      const setHeight = vi.fn();
      const homey: WidgetHomey = {
        api: async () => ({ state: 'ready', devices: [DEVICE_A] }),
        ready: () => undefined,
        setHeight,
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey);
      await flushPromises();

      triggers[0]();
      expect(setHeight).toHaveBeenCalledWith(429); // ceil(412.2 + 8 + 8)

      triggers[0](); // unchanged height → no redundant setHeight
      expect(setHeight).toHaveBeenCalledTimes(1);
    });

    test('the no-Homey boot never observes or sizes', async () => {
      installFakeResizeObserver();
      installWidget(window as WidgetWindow, document);
      // onHomeyReady never fires → bootstrapWithoutHomey wires a null client.
      await flushPromises();
      expect(triggers).toHaveLength(0);
    });
  });
});

// The renderer switches steps (.picker-view/.compose-view/.preview-view/
// .created-view) and toggles the device list (.rows) plus the empty/context/
// preview lines by setting the `hidden` attribute, so a hidden step would
// stack on top of the visible one and the widget reads as frozen / unresponsive
// to taps without the blanket reset. See test/cssTestUtils.ts for the shared
// parsing + guard assertions.
registerHiddenGuardSuite({
  name: 'create smart task widget hidden-element CSS',
  cssRelativePath: 'widgets/create_smart_task/public/index.css',
  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  hiddenToggledSelectors: [
    '.picker-view', '.compose-view', '.preview-view', '.created-view', // step views
    '.rows', // device list (hidden when there are no devices)
    '.empty', '.empty-hint', // picker affordances
    '.goal-context', '.ready-by-echo', // compose context lines
    '.perm-toggle', '.perm-toggle__note', // limit-lower-priority toggle + its gated note
    '.preview-line', // toggled preview text lines
  ],
});
