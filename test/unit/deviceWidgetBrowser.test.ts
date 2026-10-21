// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { DEVICE_WIDGET_COPY } from '../../packages/shared-domain/src/deadlineLabels';
import { installWidget, type WidgetHomey, type WidgetWindow } from '../../widgets/device/src/public/widgetApp';
import { resolveDeviceWidgetPreviewPayload } from '../../widgets/device/src/public/previewPayloads';
import type { DeviceWidgetPayload } from '../../widgets/device/src/deviceWidgetTypes';
import { registerHiddenGuardSuite } from '../cssTestUtils';

const WIDGET_MARKUP = new DOMParser().parseFromString(
  readFileSync('widgets/device/public/index.html', 'utf8'),
  'text/html',
).body.innerHTML;

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

const text = (selector: string): string | null | undefined => document.querySelector(selector)?.textContent;
const shown = (selector: string): boolean => !document.querySelector(selector)?.hasAttribute('hidden');
const view = (): string | undefined => document.getElementById('widget-root')?.dataset.view;
const tap = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-tile-tap]');

const connect = async (
  payload: DeviceWidgetPayload,
  calls: Array<{ path: string; body: unknown }> = [],
  settings: unknown = { device: { id: 'heater', name: 'Water heater' } },
): Promise<void> => {
  const homey: WidgetHomey = {
    getSettings: () => settings,
    ready: () => undefined,
    api: async (_method, path, body) => {
      calls.push({ path, body });
      if (path === '/device') return payload;
      if (path === '/quick_targets') return { state: 'unavailable', reason: 'missing_prices' };
      return { ok: true };
    },
  };
  installWidget(window as WidgetWindow, document);
  (window as WidgetWindow).onHomeyReady?.(homey as never);
  await flushPromises();
};

describe('Device insight widget browser', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    delete (window as WidgetWindow).onHomeyReady;
    document.body.innerHTML = WIDGET_MARKUP;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('reads the chosen device and leads with its figure, status and reason', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    await connect(resolveDeviceWidgetPreviewPayload('heater'), calls);
    expect(calls[0]).toEqual({ path: '/device', body: { deviceId: 'heater' } });
    expect(view()).toBe('tile');
    expect(text('[data-tile-name]')).toBe('Water heater');
    expect(text('[data-tile-chip]')).toBe('Limited');
    expect(text('[data-tile-figure]')).toBe('54.0 °C');
    expect(text('[data-tile-figure-context]')).toBe('target 65 °C');
    expect(text('[data-tile-reason]')).toBe('Waiting to resume — 0.8 kW more needed');
    // The temperature fact only words the figure the tile already leads with.
    expect(shown('[data-tile-fact]')).toBe(false);
    // Limited is the state the status chip colours; no task, so a tap starts one.
    expect(document.querySelector<HTMLElement>('[data-tile-chip]')?.dataset.tone).toBe('warn');
    expect(tap()?.getAttribute('role')).toBe('button');
    expect(text('[data-tile-action-text]')).toBe(DEVICE_WIDGET_COPY.startTaskAction);
    // The button is named by its content, so the status stays audible.
    expect(tap()?.hasAttribute('aria-label')).toBe(false);
    expect(shown('[data-tile-chevron]')).toBe(true);
  });

  test('summarises a running task, and a tap opens its detail until Back', async () => {
    await connect(resolveDeviceWidgetPreviewPayload('ev'));
    // A running device reads as plain status; colour is for limits and task outcomes.
    expect(document.querySelector<HTMLElement>('[data-tile-chip]')?.dataset.tone).toBeUndefined();
    expect(text('[data-tile-figure]')).toBe('58%');
    expect(text('[data-tile-figure-context]')).toBe('Model Y');
    // The fact line ("Charging · 58 % · level 16 A") would repeat the figure.
    expect(shown('[data-tile-fact]')).toBe(false);
    expect(text('[data-tile-task-goal]')).toBe('Smart task · Charge to 80%');
    expect(text('[data-tile-task-next]')).toBe('Next run 02:00');
    expect(text('[data-tile-action-text]')).toBe(DEVICE_WIDGET_COPY.openTaskAction);
    (document.querySelector('[data-tile-name]') as HTMLElement).click();
    expect(view()).toBe('detail');
    expect(shown('[data-tile-view]')).toBe(false);
    expect(text('[data-detail-name]')).toBe('Garage charger');
    expect(text('[data-detail-chip]')).toBe('On track');
    expect(text('[data-detail-target]')).toBe('Charge to 80 %');
    expect(text('[data-detail-deadline]')).toBe('Ready by Tomorrow 07:00');
    (document.querySelector('[data-detail-back]') as HTMLElement).click();
    expect(view()).toBe('tile');
    expect(shown('[data-detail-view]')).toBe(false);
  });

  test('a refresh that finds the task ended closes the detail and keeps focus on the tile', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const homey: WidgetHomey = {
        getSettings: () => ({ device: { id: 'ev', name: 'Garage charger' } }),
        ready: () => undefined,
        api: async () => {
          reads += 1;
          return resolveDeviceWidgetPreviewPayload(reads === 1 ? 'ev' : 'nocar');
        },
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey as never);
      await flushPromises();
      tap()?.click();
      expect(view()).toBe('detail');
      expect(document.activeElement).toBe(document.querySelector('[data-detail-back]'));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(view()).toBe('tile');
      expect(document.activeElement).toBe(tap());
    } finally {
      vi.useRealTimers();
    }
  });

  test('Enter on the tile opens it, like a tap', async () => {
    await connect(resolveDeviceWidgetPreviewPayload('ev'));
    tap()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view()).toBe('detail');
  });

  test('a device that takes no task has no tap target', async () => {
    await connect(resolveDeviceWidgetPreviewPayload('plain'));
    expect(tap()?.hasAttribute('role')).toBe(false);
    expect(shown('[data-tile-chevron]')).toBe(false);
    expect(text('[data-tile-action-text]')).toBe('');
    (document.querySelector('[data-tile-name]') as HTMLElement).click();
    expect(view()).toBe('tile');
  });

  test('a tap with no open task opens the shared creation flow, and Back returns to the tile', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    await connect(resolveDeviceWidgetPreviewPayload('ended'), calls);
    expect(text('[data-tile-task-why]')).toBe('Reached at 05:48');
    (document.querySelector('[data-tile-figure]') as HTMLElement).click();
    await flushPromises();
    expect(calls.some((call) => call.path === '/quick_targets')).toBe(true);
    // No target could be timed (prices missing): the flow opens on the goal form.
    expect(view()).toBe('compose');
    expect(shown('[data-tile-view]')).toBe(false);
    (document.querySelector('[data-compose-back]') as HTMLElement).click();
    expect(view()).toBe('tile');
    expect(shown('[data-tile-view]')).toBe(true);
  });

  test('keeps "Created" up until the tile has read the device again', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const reload = { resolve: (_: unknown) => undefined as void };
      const homey: WidgetHomey = {
        getSettings: () => ({ device: { id: 'heater', name: 'Water heater' } }),
        ready: () => undefined,
        api: async (_method, path) => {
          if (path === '/device') {
            reads += 1;
            if (reads === 1) return resolveDeviceWidgetPreviewPayload('heater');
            return new Promise((resolve) => { reload.resolve = resolve; });
          }
          if (path === '/quick_targets') return { state: 'unavailable', reason: 'missing_prices' };
          if (path === '/preview') {
            return { ok: true, deadlineAtMs: Date.now() + 3_600_000, deadlineLabel: 'Today 07:00',
              scheduledWindowLabel: null, estimate: { budgetRole: 'none', status: 'on_track', scheduledHours: [],
                projectedFinishAtMs: null, energyEstimateKWh: 2, energyExpectedKWh: null, costEstimate: null } };
          }
          return { ok: true };
        },
      };
      installWidget(window as WidgetWindow, document);
      (window as WidgetWindow).onHomeyReady?.(homey as never);
      await flushPromises();
      tap()?.click();
      await flushPromises();
      (document.querySelector('[data-preview-btn]') as HTMLElement).click();
      await flushPromises();
      (document.querySelector('[data-create-btn]') as HTMLElement).click();
      await flushPromises();
      expect(view()).toBe('created');
      await vi.advanceTimersByTimeAsync(2_000);
      // The flash has run its time, but the tile's read is still out.
      expect(view()).toBe('created');
      reload.resolve(resolveDeviceWidgetPreviewPayload('ev'));
      await flushPromises();
      expect(view()).toBe('tile');
      expect(text('[data-tile-action-text]')).toBe(DEVICE_WIDGET_COPY.openTaskAction);
    } finally {
      vi.useRealTimers();
    }
  });

  test('asks for a device until one is chosen, and names a device PELS no longer manages', async () => {
    await connect(resolveDeviceWidgetPreviewPayload('heater'), [], {});
    expect(text('[data-tile-message]')).toBe(DEVICE_WIDGET_COPY.chooseDevice);
    document.body.innerHTML = WIDGET_MARKUP;
    await connect({ state: 'not_managed' });
    expect(text('[data-tile-name]')).toBe('Water heater');
    expect(text('[data-tile-message]')).toBe(DEVICE_WIDGET_COPY.notManaged);
    expect(shown('[data-tile-chip]')).toBe(false);
  });
});

registerHiddenGuardSuite({
  name: 'device widget hidden-element CSS',
  cssRelativePath: 'widgets/device/public/index.css',
});
