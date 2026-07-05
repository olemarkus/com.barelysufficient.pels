import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_UI_SMART_TASK_CANCEL_PATH,
  SETTINGS_UI_SMART_TASK_PREVIEW_PATH,
  SETTINGS_UI_SMART_TASK_UPDATE_PATH,
} from '../../contracts/src/settingsUiApi.ts';

// Smart-task edit controller (detail-page edit/clear lane). The draft lives at
// module scope precisely so the detail page's full-root re-renders (including a
// ready → pending flip mid-edit) can never unmount it — these tests pin the
// state machine: open/edit/preview, echoed-deadline save, the two-step clear
// with auto-revert, and the terminal task_not_found path.

type ApiCall = { method: string; uri: string; body: unknown };

const setupDom = () => {
  document.body.replaceChildren();
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.append(toast);
};

const installHomey = async (apiHandler: (call: ApiCall) => unknown) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient({
    ready: async () => {},
    get: (_key: string, cb: (err: unknown, value: unknown) => void) => cb(null, null),
    set: (_key: string, _value: unknown, cb: (err: unknown) => void) => cb(null),
    api: (
      method: string,
      uri: string,
      bodyOrCallback: unknown,
      cbMaybe?: (err: unknown, value?: unknown) => void,
    ) => {
      let callback = cbMaybe;
      let body: unknown;
      if (typeof bodyOrCallback === 'function') {
        callback = bodyOrCallback as typeof cbMaybe;
      } else {
        body = bodyOrCallback;
      }
      if (typeof callback !== 'function') return;
      try {
        callback(null, apiHandler({ method, uri, body }));
      } catch (err) {
        callback(err);
      }
    },
  } as unknown as Parameters<typeof homeyModule.setHomeyClient>[0]);
};

const BASELINE_DEADLINE_AT_MS = 1_850_000_000_000;

const CONTEXT = {
  deviceId: 'heater-1',
  kind: 'temperature' as const,
  unit: '°C',
  min: 30,
  max: 75,
  step: 0.5,
  baselineReadyBy: '07:00',
  baselineTarget: 65,
  baselineDeadlineAtMs: BASELINE_DEADLINE_AT_MS,
};

const okPreview = {
  ok: true,
  deadlineAtMs: 1_780_000_000_000,
  deadlineLabel: 'Tomorrow 07:00',
  scheduledWindowLabel: '02:00–04:00',
  estimate: {
    status: 'on_track',
    scheduledHours: [{ startsAtMs: 1, plannedKWh: 1 }],
    projectedFinishAtMs: 2,
    energyEstimateKWh: 1,
    energyExpectedKWh: 1,
    costEstimate: 3.4,
    costUnit: 'kr',
  },
};

const loadController = async () => import('../src/ui/smartTaskEdit.ts');

describe('smartTaskEdit controller', () => {
  beforeEach(() => {
    setupDom();
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens with a clean, valid draft seeded from the baselines', async () => {
    await installHomey(() => ({ ok: true }));
    const controller = await loadController();
    controller.openSmartTaskEditor(CONTEXT);
    const s = controller.getSmartTaskEditSnapshot();
    expect(s).toMatchObject({
      draft: { readyBy: '07:00', target: '65' },
      dirty: false,
      valid: true,
      busy: 'idle',
      preview: null,
      clearArmed: false,
    });
  });

  it('debounces a preview for a dirty valid draft and composes the when/cost lines', async () => {
    const calls: ApiCall[] = [];
    await installHomey((call) => {
      calls.push(call);
      if (call.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH) return okPreview;
      return { ok: true };
    });
    const controller = await loadController();
    const render = vi.fn();
    controller.initSmartTaskEditController({ render, requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    expect(controller.getSmartTaskEditSnapshot()).toMatchObject({ dirty: true, valid: true });
    await vi.advanceTimersByTimeAsync(500);
    const previewCalls = calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH);
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]!.body).toMatchObject({
      deviceId: 'heater-1',
      kind: 'temperature',
      target: 70,
      readyByLocalTime: '07:00',
    });
    expect(controller.getSmartTaskEditSnapshot()!.preview).toMatchObject({
      deadlineAtMs: okPreview.deadlineAtMs,
      whenLine: 'If you save: runs 02:00–04:00 · Ready by Tomorrow 07:00',
    });
  });

  it('reverting the draft mid-preview returns busy to idle (no stuck "Updating estimate…")', async () => {
    let resolvePreview: ((value: unknown) => void) | null = null;
    await installHomey((call) => {
      if (call.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH) {
        // Never resolves during the test window — simulates an in-flight
        // round-trip the user edits underneath.
        return new Promise((resolve) => { resolvePreview = resolve; });
      }
      return { ok: true };
    });
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    await vi.advanceTimersByTimeAsync(450);
    expect(controller.getSmartTaskEditSnapshot()!.busy).toBe('previewing');
    // Revert to the baseline: the draft is clean again, so no new preview is
    // scheduled — busy must return to idle rather than stranding the
    // in-flight marker forever.
    controller.setSmartTaskEditTarget('65');
    expect(controller.getSmartTaskEditSnapshot()).toMatchObject({ busy: 'idle', dirty: false });
    expect(resolvePreview).not.toBeNull();
  });

  it('an out-of-bounds target invalidates the draft and schedules no preview', async () => {
    const calls: ApiCall[] = [];
    await installHomey((call) => {
      calls.push(call);
      return okPreview;
    });
    const controller = await loadController();
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('90');
    expect(controller.getSmartTaskEditSnapshot()).toMatchObject({ dirty: true, valid: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH)).toHaveLength(0);
  });

  it('save echoes the previewed deadline and closes the editor on success', async () => {
    const calls: ApiCall[] = [];
    await installHomey((call) => {
      calls.push(call);
      if (call.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH) return okPreview;
      return { ok: true };
    });
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    await vi.advanceTimersByTimeAsync(500);
    // `showToast` sleeps on success — pump the fake timers while awaiting.
    const saved = controller.submitSmartTaskUpdate();
    await vi.runAllTimersAsync();
    await saved;
    const updateCalls = calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.body).toMatchObject({
      deviceId: 'heater-1',
      target: 70,
      deadlineAtMs: okPreview.deadlineAtMs,
    });
    expect(controller.getSmartTaskEditSnapshot()).toBeNull();
  });

  it('a rejected save keeps the editor open with the reason inline', async () => {
    await installHomey((call) => (
      call.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH
        ? { ok: false, reason: 'write_conflict' }
        : { ok: true }
    ));
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    await controller.submitSmartTaskUpdate();
    const s = controller.getSmartTaskEditSnapshot();
    expect(s).not.toBeNull();
    expect(s!.busy).toBe('idle');
    expect(s!.errorLine).toContain('Try again');
  });

  it('deadline_passed on save re-previews so the next save echoes a fresh deadline', async () => {
    const calls: ApiCall[] = [];
    let updateCount = 0;
    await installHomey((call) => {
      calls.push(call);
      if (call.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH) return okPreview;
      if (call.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH) {
        updateCount += 1;
        return updateCount === 1 ? { ok: false, reason: 'deadline_passed' } : { ok: true };
      }
      return { ok: true };
    });
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    await vi.advanceTimersByTimeAsync(500);

    const firstSave = controller.submitSmartTaskUpdate();
    await vi.runAllTimersAsync();
    await firstSave;
    await vi.advanceTimersByTimeAsync(0);
    // Rejected save keeps the editor open with the edit-specific copy, and a
    // fresh preview has ALREADY re-resolved a future deadline — the user is
    // never left to re-save blind (which would silently roll to tomorrow
    // server-side).
    const s = controller.getSmartTaskEditSnapshot();
    expect(s).not.toBeNull();
    expect(s!.errorLine).toContain('Pick a later time');
    expect(calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_PREVIEW_PATH)).toHaveLength(2);
    expect(s!.preview).not.toBeNull();

    const secondSave = controller.submitSmartTaskUpdate();
    await vi.runAllTimersAsync();
    await secondSave;
    const updates = calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH);
    expect(updates).toHaveLength(2);
    expect(updates[1]!.body).toMatchObject({ deadlineAtMs: okPreview.deadlineAtMs });
    expect(controller.getSmartTaskEditSnapshot()).toBeNull();
  });

  it('a target-only save without a preview echoes the task\'s current deadline', async () => {
    // Saving before the debounced preview lands must still pin the deadline:
    // an unchanged ready-by means "keep the same moment", so the server
    // re-validates the echoed baseline instead of silently re-resolving the
    // HH:mm (which would roll an about-to-expire task to tomorrow).
    const calls: ApiCall[] = [];
    await installHomey((call) => {
      calls.push(call);
      return { ok: true };
    });
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    // No timer advance — save fires while the preview is still debouncing.
    const saved = controller.submitSmartTaskUpdate();
    await vi.runAllTimersAsync();
    await saved;
    const updates = calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toMatchObject({ target: 70, deadlineAtMs: BASELINE_DEADLINE_AT_MS });
  });

  it('typing an intermediate decimal keeps the raw text in the draft', async () => {
    await installHomey(() => ({ ok: true }));
    const controller = await loadController();
    controller.openSmartTaskEditor(CONTEXT);
    // "65." parses to the baseline value: raw text is kept for the input,
    // while dirtiness/validity work on the parsed number (not dirty, valid).
    controller.setSmartTaskEditTarget('65.');
    expect(controller.getSmartTaskEditSnapshot()).toMatchObject({
      draft: { target: '65.' },
      dirty: false,
      valid: true,
    });
  });

  it('task_not_found on save closes the editor and re-boots the page (the task ended elsewhere)', async () => {
    await installHomey((call) => (
      call.uri === SETTINGS_UI_SMART_TASK_UPDATE_PATH
        ? { ok: false, reason: 'task_not_found' }
        : { ok: true }
    ));
    const controller = await loadController();
    const refreshBoot = vi.fn();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose: vi.fn(), refreshBoot });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditTarget('70');
    const saved = controller.submitSmartTaskUpdate();
    await vi.runAllTimersAsync();
    await saved;
    expect(controller.getSmartTaskEditSnapshot()).toBeNull();
    // The detail page must repaint from LIVE data — refreshPlanSurface alone
    // only bumps the Overview plan surface, not this page's cached boot.
    expect(refreshBoot).toHaveBeenCalledTimes(1);
  });

  it('the draft survives external re-renders because it lives at module scope', async () => {
    await installHomey(() => ({ ok: true }));
    const controller = await loadController();
    const render = vi.fn();
    controller.initSmartTaskEditController({ render, requestClose: vi.fn(), refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);
    controller.setSmartTaskEditReadyBy('06:30');
    // Simulate what the mount does on every runtime refresh — including a
    // ready → pending flip: it re-reads the snapshot and repaints. The typed
    // draft must still be there.
    const again = controller.getSmartTaskEditSnapshot();
    expect(again).toMatchObject({ draft: { readyBy: '06:30', target: '65' }, dirty: true });
  });

  it('clear arms first, auto-reverts after the confirm window, and commits on the second tap', async () => {
    const calls: ApiCall[] = [];
    const requestClose = vi.fn();
    await installHomey((call) => {
      calls.push(call);
      return { ok: true };
    });
    const controller = await loadController();
    controller.initSmartTaskEditController({ render: vi.fn(), requestClose, refreshBoot: vi.fn() });
    controller.openSmartTaskEditor(CONTEXT);

    await controller.requestSmartTaskClear();
    expect(controller.getSmartTaskEditSnapshot()!.clearArmed).toBe(true);
    expect(calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_CANCEL_PATH)).toHaveLength(0);

    // Auto-revert: the armed confirm must not survive the window.
    await vi.advanceTimersByTimeAsync(5100);
    expect(controller.getSmartTaskEditSnapshot()!.clearArmed).toBe(false);

    await controller.requestSmartTaskClear();
    const cleared = controller.requestSmartTaskClear();
    await vi.runAllTimersAsync();
    await cleared;
    const cancelCalls = calls.filter((c) => c.uri === SETTINGS_UI_SMART_TASK_CANCEL_PATH);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.body).toEqual({ deviceId: 'heater-1' });
    expect(controller.getSmartTaskEditSnapshot()).toBeNull();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });
});
