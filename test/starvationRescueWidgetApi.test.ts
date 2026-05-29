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
  previewDeferredObjectivePlan: ReturnType<typeof vi.fn>;
  rescueDeviceWithBudgetExemption: ReturnType<typeof vi.fn>;
};

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
    const previewDeferredObjectivePlan = vi.fn();
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewDeferredObjectivePlan }),
      body: { deviceId: '' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a capacity-starved device with not_rescuable', async () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [capacityDevice]), previewDeferredObjectivePlan }),
      body: { deviceId: 'rad-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('rejects a device that is no longer starved with not_rescuable', async () => {
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => []), previewDeferredObjectivePlan: vi.fn() }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
  });

  it('rejects a budget device with no known target with no_target', async () => {
    const noTarget: StarvationRescueDevice = { ...budgetDevice, intendedNormalTargetC: null };
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [noTarget]), previewDeferredObjectivePlan: vi.fn() }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'no_target' });
  });

  it('forwards a budget-exempt rescue candidate at the intended normal target', async () => {
    let received: { deviceId: string; candidate: DeferredObjectivePlanPreviewCandidate } | null = null;
    const previewDeferredObjectivePlan = vi.fn((deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = { deviceId, candidate };
      return buildEstimate();
    });
    const result = await previewStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewDeferredObjectivePlan }),
      body: { deviceId: 'heater-1' },
    });
    if (!result.ok) throw new Error('expected ok preview');
    expect(result.deadlineAtMs).toBe(NOW_MS + RESCUE_HORIZON_MS);
    expect(received).not.toBeNull();
    expect(received!.deviceId).toBe('heater-1');
    expect(received!.candidate).toEqual({
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS,
      rescue: { exemptFromBudget: 'always' },
    });
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

  it('rejects an echoed deadline that slipped into the past as deadline_passed', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn();
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS - 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('rejects an echoed deadline beyond the rescue horizon as deadline_passed', async () => {
    const rescueDeviceWithBudgetExemption = vi.fn();
    const result = await createStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS + 1 },
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
