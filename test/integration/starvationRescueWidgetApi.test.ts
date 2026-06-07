/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectivePlanPreviewCandidate } from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectivePlanPreviewEstimate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import { buildStarvationRescueDevicesPayload } from '../../widgets/starvation_rescue/src/starvationRescueWidgetPayload';
import {
  createStarvationRescue,
  getStarvationRescueDevices,
  previewStarvationRescue,
} from '../../widgets/starvation_rescue/src/api';

const TIME_ZONE = 'Europe/Oslo';
const NOW_MS = Date.UTC(2026, 0, 1, 4, 0, 0);
const RESCUE_HORIZON_MS = 3 * 60 * 60 * 1000;

const budgetDevice: StarvationRescueDevice = {
  deviceId: 'heater-1',
  deviceName: 'Hot water',
  cause: 'budget',
  accumulatedMs: 42 * 60 * 1000,
  intendedNormalTargetC: 65,
  hasSmartTask: false,
};

const capacityDevice: StarvationRescueDevice = {
  deviceId: 'rad-1',
  deviceName: 'Living room',
  cause: 'capacity',
  accumulatedMs: 11 * 60 * 1000,
  intendedNormalTargetC: 21,
  hasSmartTask: false,
};

// A budget-held device that already has its own smart task: shown in the list,
// but NOT rescuable (the existing task handles it).
const taskOwningBudgetDevice: StarvationRescueDevice = {
  ...budgetDevice, deviceId: 'heater-2', deviceName: 'Cabin water', hasSmartTask: true,
};

const buildEstimate = (overrides: Partial<DeferredObjectivePlanPreviewEstimate> = {}): DeferredObjectivePlanPreviewEstimate => ({
  status: 'on_track',
  scheduledHours: [{ startsAtMs: NOW_MS + 60 * 60 * 1000, plannedKWh: 1.5 }],
  projectedFinishAtMs: NOW_MS + 2 * 60 * 60 * 1000,
  energyEstimateKWh: 1.5,
  energyExpectedKWh: 1.4,
  costEstimate: 2.1,
  costUnit: 'kr',
  ...overrides,
});

type AppMock = {
  getStarvedRescueDevices: ReturnType<typeof vi.fn>;
  previewStarvationRescuePlan: ReturnType<typeof vi.fn>;
  rescueDeviceWithBudgetExemption: ReturnType<typeof vi.fn>;
  hasDeferredObjectiveForDevice: ReturnType<typeof vi.fn>;
};

// Default preview-plan stub: mimics the FRESH (no existing objective) path —
// echoes the candidate's deadline back as the resolved deadline, just like
// `App.previewStarvationRescuePlan` does when no objective is merged.
const freshPreviewPlan = (estimate = buildEstimate()) => vi.fn(
  (_deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => ({
    estimate,
    deadlineAtMs: candidate.deadlineAtMs,
    hasExistingObjective: false,
  }),
);

const buildContext = (app: Partial<AppMock>) => ({
  homey: { app, clock: { getTimezone: () => TIME_ZONE } },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildStarvationRescueDevicesPayload', () => {
  it('returns the calm empty state when nothing is starved', () => {
    expect(buildStarvationRescueDevicesPayload({ devices: [] }).state).toBe('empty');
    expect(buildStarvationRescueDevicesPayload({ devices: null }).state).toBe('empty');
  });

  it('passes through the starved device list when present', () => {
    const payload = buildStarvationRescueDevicesPayload({ devices: [budgetDevice, capacityDevice] });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices).toHaveLength(2);
    expect(payload.devices[0].cause).toBe('budget');
  });
});

describe('getStarvationRescueDevices', () => {
  it('builds the payload from the app getter', async () => {
    const getStarvedRescueDevices = vi.fn(() => [budgetDevice]);
    const payload = await getStarvationRescueDevices(buildContext({ getStarvedRescueDevices }));
    expect(getStarvedRescueDevices).toHaveBeenCalledOnce();
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0].deviceId).toBe('heater-1');
  });

  it('returns empty when the app getter is missing', async () => {
    const payload = await getStarvationRescueDevices(buildContext({}));
    expect(payload.state).toBe('empty');
  });
});

describe('previewStarvationRescue', () => {
  it('rejects a malformed request without calling the app', async () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: '' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewStarvationRescuePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a capacity-starved device with not_rescuable', async () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [capacityDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'rad-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(previewStarvationRescuePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a budget device that already has its own smart task with not_rescuable', async () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [taskOwningBudgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'heater-2' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(previewStarvationRescuePlan).not.toHaveBeenCalled();
  });

  it('rejects a device that is no longer starved with not_rescuable', async () => {
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => []), previewStarvationRescuePlan: freshPreviewPlan() }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
  });

  it('rejects a budget device with no known target with no_target', async () => {
    const noTarget: StarvationRescueDevice = { ...budgetDevice, intendedNormalTargetC: null };
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [noTarget]), previewStarvationRescuePlan: freshPreviewPlan() }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'no_target' });
  });

  it('forwards a fresh budget-exempt rescue candidate at the intended normal target (no existing objective)', async () => {
    let received: { deviceId: string; candidate: DeferredObjectivePlanPreviewCandidate } | null = null;
    const previewStarvationRescuePlan = vi.fn((deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = { deviceId, candidate };
      return { estimate: buildEstimate(), deadlineAtMs: candidate.deadlineAtMs, hasExistingObjective: false };
    });
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'heater-1' },
    });
    if (!result.ok) throw new Error('expected ok preview');
    expect(result.deadlineAtMs).toBe(NOW_MS + RESCUE_HORIZON_MS);
    expect(received).not.toBeNull();
    expect(received!.deviceId).toBe('heater-1');
    // The widget hands the app a FRESH now+3h candidate at the intended target,
    // requesting BOTH rescue permissions (the create engine gates the limit one).
    expect(received!.candidate).toEqual({
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS,
      rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
    });
  });

  it('reports unavailable when the preview app method is missing', async () => {
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]) }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('createStarvationRescue', () => {
  it('GUARDRAIL: rejects a capacity-starved device without calling the rescue method', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn();
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [capacityDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'rad-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('forwards the budget-exempt rescue candidate, echoing the previewed deadline', async () => {
    let received: DeferredObjectivePlanPreviewCandidate | null = null;
    const rescueDeviceWithBudgetExemption = vi.fn((_deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = candidate;
      return { ok: true as const };
    });
    const deadlineAtMs = NOW_MS + RESCUE_HORIZON_MS;
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs },
    });
    // No previewStarvationRescuePlan stub in this context → the create can't
    // re-derive the post-persist plan, so the honest-conservative flash is queued.
    expect(result).toEqual({ ok: true, runsCurrentHour: false });
    expect(rescueDeviceWithBudgetExemption).toHaveBeenCalledWith('heater-1', {
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs,
      rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
    });
    // The widget requests both permissions; the create engine keeps the budget
    // exemption for any device and gates the limit-lower-priority grant.
    expect(received!.rescue).toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
  });

  it('maps a refused write to the retryable write_conflict reason (no false success)', async () => {
    // The app refused to persist on a transient un-confirmable migration /
    // untrustworthy read. The widget must surface the retryable write_conflict
    // reason, not report `ok: true` while the exemption never landed.
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: false as const, reason: 'write_refused' }));
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: false, reason: 'write_conflict' });
  });

  it('persists the previewed deadline verbatim across an hour boundary (no fresh now+3h)', async () => {
    // Confirm left open: "now" advances 1h past the preview, but the echoed
    // deadline is still in-horizon, so the create persists the EXACT previewed
    // deadline rather than recomputing now+3h.
    const previewedDeadline = NOW_MS + RESCUE_HORIZON_MS;
    vi.setSystemTime(NOW_MS + 60 * 60 * 1000);
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: previewedDeadline },
    });
    expect(result).toEqual({ ok: true, runsCurrentHour: false });
    expect(rescueDeviceWithBudgetExemption).toHaveBeenCalledWith(
      'heater-1',
      expect.objectContaining({ deadlineAtMs: previewedDeadline }),
    );
  });

  it('rejects an echoed deadline that slipped into the past as deadline_passed (fresh case)', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn();
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        hasDeferredObjectiveForDevice: vi.fn(() => false),
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS - 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('rejects an echoed deadline beyond the rescue horizon as deadline_passed (fresh case)', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn();
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        hasDeferredObjectiveForDevice: vi.fn(() => false),
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS + 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('rejects a PAST echoed deadline as deadline_passed (a passed deadline can never schedule)', async () => {
    // A rescue is always a fresh now+3h task; a passed echoed deadline can never
    // schedule (the active-plan recorder drops it). Persisting it would report a
    // false success instead of the retryable re-preview path, so reject it.
    const passedDeadline = NOW_MS - 60 * 1000;
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: passedDeadline },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('falls back to a fresh near-term horizon when no deadline is echoed', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: true, runsCurrentHour: false });
    expect(rescueDeviceWithBudgetExemption).toHaveBeenCalledWith(
      'heater-1',
      expect.objectContaining({ deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS }),
    );
  });

  it('maps a write_conflict app rejection to the response', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: false as const, reason: 'write_conflict' }));
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: false, reason: 'write_conflict' });
  });

  it('reports unavailable when the rescue app method is missing', async () => {
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]) }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('flashes runsCurrentHour=true when the just-persisted plan runs the current hour', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    // Post-persist re-derivation schedules the CURRENT hour → honest "on the way".
    const previewStarvationRescuePlan = freshPreviewPlan(
      buildEstimate({ scheduledHours: [{ startsAtMs: NOW_MS, plannedKWh: 1.5 }] }),
    );
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        previewStarvationRescuePlan,
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: true, runsCurrentHour: true });
  });

  it('recomputes the flash at CREATE time: a confirm across an hour boundary flashes queued, not stale on-the-way', async () => {
    // Preview happened at 04:xx with the 04:00 bucket planned; the user confirms
    // at 05:xx. The create re-derives the plan against the NEW current hour (05:00),
    // which the schedule (04:00 only) no longer covers → the flash must be queued,
    // not the stale preview-time "on the way".
    vi.setSystemTime(NOW_MS + 60 * 60 * 1000); // advance one hour → current hour is now 05:00
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const previewStarvationRescuePlan = freshPreviewPlan(
      buildEstimate({ scheduledHours: [{ startsAtMs: NOW_MS, plannedKWh: 1.5 }] }), // 04:00 bucket only
    );
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        previewStarvationRescuePlan,
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS },
    });
    expect(result).toEqual({ ok: true, runsCurrentHour: false });
  });
});
