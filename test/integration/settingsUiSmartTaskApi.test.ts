/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSettings } from '../mocks/homey';
import {
  resolveDeferredObjectiveDeadline,
  type DeferredObjectivePlanPreviewCandidate,
} from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectivePlanPreviewEstimate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import {
  cancelSettingsUiSmartTask,
  previewSettingsUiSmartTask,
  updateSettingsUiSmartTask,
} from '../../setup/settingsUiSmartTaskApi';

// Settings-UI smart-task edit lane (detail-page edit + clear). The handlers
// reach the SAME app methods the create_smart_task widget calls and reuse the
// shared candidate-request helpers; what is exercised here is the lane's own
// contract — the task-must-exist guard, the echoed-deadline anti-drift rule,
// and the app-reason mapping.

const TIME_ZONE = 'Europe/Oslo';
// 2026-01-01 05:00 Oslo (04:00 UTC, winter = UTC+1). A 07:00 ready-by resolves
// to today; a 03:00 ready-by rolls to tomorrow.
const NOW_MS = Date.UTC(2026, 0, 1, 4, 0, 0);
const DEVICE_ID = 'heater-1';
const OBJECTIVE_KEY = `deferred_objective.${DEVICE_ID}`;

const buildEstimate = (
  overrides: Partial<DeferredObjectivePlanPreviewEstimate> = {},
): DeferredObjectivePlanPreviewEstimate => ({
  status: 'on_track',
  scheduledHours: [{ startsAtMs: NOW_MS + 60 * 60 * 1000, plannedKWh: 2 }],
  projectedFinishAtMs: NOW_MS + 2 * 60 * 60 * 1000,
  energyEstimateKWh: 2,
  energyExpectedKWh: 1.8,
  costEstimate: 3.4,
  costUnit: 'kr',
  ...overrides,
});

const storedEntry = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: NOW_MS + 4 * 60 * 60 * 1000,
  ...overrides,
});

const updateBody = (overrides: Record<string, unknown> = {}) => ({
  deviceId: DEVICE_ID,
  kind: 'temperature',
  target: 70,
  readyByLocalTime: '07:00',
  ...overrides,
});

const expectedDeadline = (localTime: string): number => {
  const resolution = resolveDeferredObjectiveDeadline({
    nowMs: NOW_MS,
    timeZone: TIME_ZONE,
    deadlineLocalTime: localTime,
  });
  if (resolution.deadlineAtMs === null) throw new Error('failed to resolve test deadline');
  return resolution.deadlineAtMs;
};

type HandlerContext = {
  homey: never;
  settings: MockSettings;
};

const buildContext = (app: Record<string, unknown>, withTask = true): HandlerContext => {
  const settings = new MockSettings();
  // A PELS store always has SOME keys; seed one so a missing objective key
  // reads as a TRUSTWORTHY absence (empty getKeys() is the transient flake
  // the gate maps to the retryable write_conflict lane instead).
  settings.set('capacity_limit_kw', 10);
  if (withTask) settings.set(OBJECTIVE_KEY, storedEntry());
  return {
    homey: {
      app: {
        resolveSmartTaskHomeScope: () => 'main',
        ...app,
      },
      clock: { getTimezone: () => TIME_ZONE },
      settings,
    } as never,
    settings,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('previewSettingsUiSmartTask', () => {
  it('rejects a malformed request without calling the app', () => {
    const previewDeferredObjectivePlan = vi.fn();
    const { homey } = buildContext({ previewDeferredObjectivePlan });
    const result = previewSettingsUiSmartTask({ homey, body: { deviceId: '' } });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a device with no stored task as task_not_found', () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const { homey } = buildContext({ previewDeferredObjectivePlan }, false);
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'task_not_found' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: an expired-but-not-yet-disabled task is not editable', () => {
    // The window after deadlineAtMs but before the lifecycle pass flips
    // `enabled`: a "revision" here would finalize the ended run as replaced
    // instead of letting it record as completed/missed.
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const { homey, settings } = buildContext({ previewDeferredObjectivePlan });
    settings.set(OBJECTIVE_KEY, storedEntry({ deadlineAtMs: NOW_MS - 60 * 1000 }));
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'task_not_found' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: a stored-but-disabled task is not editable', () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const { homey, settings } = buildContext({ previewDeferredObjectivePlan });
    settings.set(OBJECTIVE_KEY, storedEntry({ enabled: false }));
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'task_not_found' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('resolves the ready-by in the Homey timezone and returns server-formatted labels', () => {
    const previewDeferredObjectivePlan = vi.fn(
      (_deviceId: string, _candidate: DeferredObjectivePlanPreviewCandidate) => buildEstimate(),
    );
    const { homey } = buildContext({ previewDeferredObjectivePlan });
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toMatchObject({
      ok: true,
      deadlineAtMs: expectedDeadline('07:00'),
      deadlineLabel: expect.stringContaining('07:00'),
      scheduledWindowLabel: expect.any(String),
    });
    const candidate = previewDeferredObjectivePlan.mock
      .calls[0]![1] as DeferredObjectivePlanPreviewCandidate;
    expect(candidate).toMatchObject({
      kind: 'temperature',
      targetTemperatureC: 70,
      deadlineAtMs: expectedDeadline('07:00'),
    });
    // An edit candidate carries no rescue — the create path's `preserve`
    // policy then keeps any standing permission intact.
    expect(candidate.rescue).toBeUndefined();
  });

  it('merges the stored rescue permissions into the previewed candidate', () => {
    // The save path sends a rescue-less candidate and the upsert's `preserve`
    // default keeps the task's standing permissions — the preview must
    // estimate under the SAME permissions or the "If you save" readout prices
    // the draft under stricter budget/priority constraints than the persisted
    // task will actually run with.
    const previewDeferredObjectivePlan = vi.fn(
      (_deviceId: string, _candidate: DeferredObjectivePlanPreviewCandidate) => buildEstimate(),
    );
    const { homey, settings } = buildContext({ previewDeferredObjectivePlan });
    settings.set(OBJECTIVE_KEY, storedEntry({ rescue: { exemptFromBudget: 'always' } }));
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toMatchObject({ ok: true });
    const candidate = previewDeferredObjectivePlan.mock
      .calls[0]![1] as DeferredObjectivePlanPreviewCandidate;
    expect(candidate.rescue).toEqual({ exemptFromBudget: 'always' });
  });

  it('rejects a relocated task before producing an estimate the save lane cannot honor', () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const resolveSmartTaskHomeScope = vi.fn(() => 'sub_home');
    const { homey } = buildContext({ previewDeferredObjectivePlan, resolveSmartTaskHomeScope });
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'device_in_sub_home' });
    expect(resolveSmartTaskHomeScope).toHaveBeenCalledWith(DEVICE_ID);
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('reports a provisional ownership fence as unavailable without estimating', () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const resolveSmartTaskHomeScope = vi.fn(() => 'unavailable');
    const { homey } = buildContext({ previewDeferredObjectivePlan, resolveSmartTaskHomeScope });
    const result = previewSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });
});

describe('updateSettingsUiSmartTask', () => {
  it('persists the exact previewed deadline the client echoes back', () => {
    const echoed = expectedDeadline('07:00');
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const { homey } = buildContext({ createDeferredObjective });
    const result = updateSettingsUiSmartTask({ homey, body: updateBody({ deadlineAtMs: echoed }) });
    expect(result).toEqual({ ok: true });
    expect(createDeferredObjective).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.objectContaining({ deadlineAtMs: echoed, targetTemperatureC: 70 }),
      'settings_ui:smart_task_update',
    );
  });

  it('rejects an echoed deadline that slipped into the past instead of rolling it forward', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const { homey } = buildContext({ createDeferredObjective });
    const result = updateSettingsUiSmartTask({
      homey,
      body: updateBody({ deadlineAtMs: NOW_MS - 60 * 1000 }),
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('re-resolves the ready-by server-side when no previewed deadline is echoed', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const { homey } = buildContext({ createDeferredObjective });
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: true });
    expect(createDeferredObjective).toHaveBeenCalledWith(
      DEVICE_ID,
      expect.objectContaining({ deadlineAtMs: expectedDeadline('07:00') }),
      'settings_ui:smart_task_update',
    );
  });

  it('GUARDRAIL: never creates a task for a device without one', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const { homey } = buildContext({ createDeferredObjective }, false);
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'task_not_found' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: a transient-empty store maps to retryable write_conflict, not task_not_found', () => {
    // One flaky getKeys() read must never make the UI declare a still-live
    // task "ended" — the store may hold the task even though nothing reads.
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const settings = new MockSettings();
    const homey = {
      app: { createDeferredObjective },
      clock: { getTimezone: () => TIME_ZONE },
      settings,
    } as never;
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'write_conflict' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('maps a refused persist onto the retryable write_conflict lane', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: false, reason: 'write_refused' }));
    const { homey } = buildContext({ createDeferredObjective });
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'write_conflict' });
  });

  it('reports unavailable when the app method is not wired', () => {
    const { homey } = buildContext({});
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects a relocated task before calling the create lane', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const resolveSmartTaskHomeScope = vi.fn(() => 'sub_home');
    const { homey } = buildContext({ createDeferredObjective, resolveSmartTaskHomeScope });
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'device_in_sub_home' });
    expect(resolveSmartTaskHomeScope).toHaveBeenCalledWith(DEVICE_ID);
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('reports a provisional ownership fence as unavailable before saving', () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true }));
    const resolveSmartTaskHomeScope = vi.fn(() => 'unavailable');
    const { homey } = buildContext({ createDeferredObjective, resolveSmartTaskHomeScope });
    const result = updateSettingsUiSmartTask({ homey, body: updateBody() });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });
});

describe('cancelSettingsUiSmartTask', () => {
  it('delegates to the app cancel and reports success', () => {
    const cancelDeferredObjective = vi.fn(() => ({ ok: true }));
    const { homey } = buildContext({ cancelDeferredObjective });
    const result = cancelSettingsUiSmartTask({ homey, body: { deviceId: DEVICE_ID } });
    expect(result).toEqual({ ok: true });
    expect(cancelDeferredObjective).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('rejects a body without a deviceId', () => {
    const cancelDeferredObjective = vi.fn();
    const { homey } = buildContext({ cancelDeferredObjective });
    const result = cancelSettingsUiSmartTask({ homey, body: {} });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(cancelDeferredObjective).not.toHaveBeenCalled();
  });

  it('passes task_not_found through and maps a refused clear to write_conflict', () => {
    const notFound = vi.fn(() => ({ ok: false, reason: 'task_not_found' }));
    const { homey } = buildContext({ cancelDeferredObjective: notFound });
    expect(cancelSettingsUiSmartTask({ homey, body: { deviceId: DEVICE_ID } }))
      .toEqual({ ok: false, reason: 'task_not_found' });

    const refused = vi.fn(() => ({ ok: false, reason: 'write_refused' }));
    const { homey: refusedHomey } = buildContext({ cancelDeferredObjective: refused });
    expect(cancelSettingsUiSmartTask({ homey: refusedHomey, body: { deviceId: DEVICE_ID } }))
      .toEqual({ ok: false, reason: 'write_conflict' });
  });
});
