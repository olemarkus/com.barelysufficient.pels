/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectivePlanPreviewCandidate } from '../lib/plan/deferredObjectives';
import type { DeferredObjectivePlanPreviewEstimate } from '../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueDevice } from '../packages/contracts/src/starvationRescue';
import { buildStarvationRescueDevicesPayload } from '../widgets/starvation_rescue/src/starvationRescueWidgetPayload';
import {
  createStarvationRescue,
  getStarvationRescueDevices,
  previewStarvationRescue,
} from '../widgets/starvation_rescue/src/api';

const TIME_ZONE = 'Europe/Oslo';
const NOW_MS = Date.UTC(2026, 0, 1, 4, 0, 0);
const RESCUE_HORIZON_MS = 3 * 60 * 60 * 1000;

const budgetDevice: StarvationRescueDevice = {
  deviceId: 'heater-1',
  deviceName: 'Hot water',
  cause: 'budget',
  accumulatedMs: 42 * 60 * 1000,
  intendedNormalTargetC: 65,
};

const capacityDevice: StarvationRescueDevice = {
  deviceId: 'rad-1',
  deviceName: 'Living room',
  cause: 'capacity',
  accumulatedMs: 11 * 60 * 1000,
  intendedNormalTargetC: 21,
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
    // The widget hands the app a FRESH now+3h candidate at the intended target.
    expect(received!.candidate).toEqual({
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS,
      rescue: { exemptFromBudget: 'always' },
    });
  });

  it('PREVIEW≡PERSIST: surfaces the existing objective\'s resolved deadline, not the fresh now+3h', async () => {
    // When an objective already exists, the app's merge preserves its deadline.
    // The preview must echo THAT resolved deadline (here: well outside the rescue
    // horizon) so the user confirms what actually persists.
    const existingDeadline = NOW_MS + 20 * 60 * 60 * 1000; // tomorrow-ish, far past now+3h
    const previewStarvationRescuePlan = vi.fn(() => ({
      estimate: buildEstimate(),
      deadlineAtMs: existingDeadline,
      hasExistingObjective: true,
    }));
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'heater-1' },
    });
    if (!result.ok) throw new Error('expected ok preview');
    expect(result.deadlineAtMs).toBe(existingDeadline);
    // The widget still hands the app a fresh now+3h candidate; the app decides the
    // merge outcome and returns the resolved (existing) deadline.
    expect(previewStarvationRescuePlan).toHaveBeenCalledWith(
      'heater-1',
      expect.objectContaining({ deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS }),
    );
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
    expect(result).toEqual({ ok: true });
    expect(rescueDeviceWithBudgetExemption).toHaveBeenCalledWith('heater-1', {
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs,
      rescue: { exemptFromBudget: 'always' },
    });
    // The exemption is on the candidate that reaches the merge-not-replace path.
    expect(received!.rescue).toEqual({ exemptFromBudget: 'always' });
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
    expect(result).toEqual({ ok: true });
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

  it('PREVIEW≡PERSIST: accepts an out-of-horizon echoed deadline when an objective already exists', async () => {
    // The preview surfaced the existing objective's deadline (far past now+3h);
    // the merge preserves it and ignores the candidate's, so the create must NOT
    // reject it on the rescue-horizon guard — that guard is fresh-only.
    const existingDeadline = NOW_MS + 20 * 60 * 60 * 1000;
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        hasDeferredObjectiveForDevice: vi.fn(() => true),
      }),
      body: { deviceId: 'heater-1', deadlineAtMs: existingDeadline },
    });
    expect(result).toEqual({ ok: true });
    expect(rescueDeviceWithBudgetExemption).toHaveBeenCalledOnce();
  });

  it('rejects a PAST echoed deadline even when an objective already exists', async () => {
    // The existing-objective exception relaxes only the upper now+3h horizon, not
    // the past-deadline floor: the echoed deadline IS the existing objective's
    // preserved deadline, and a passed one can never schedule (the active-plan
    // recorder drops it). Persisting it would report a false success instead of
    // the retryable re-preview path, so the create must still reject it.
    const passedDeadline = NOW_MS - 60 * 1000;
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true as const }));
    const result = await createStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        hasDeferredObjectiveForDevice: vi.fn(() => true),
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
    expect(result).toEqual({ ok: true });
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
});
