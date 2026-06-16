/**
 * @vitest-environment node
 */
import type { DeferredObjectivePlanPreviewCandidate } from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectivePlanPreviewEstimate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueDevice } from '../../packages/contracts/src/starvationRescue';
import {
  createSettingsUiStarvationRescue,
  getSettingsUiStarvationRescueDevices,
  previewSettingsUiStarvationRescue,
} from '../../setup/settingsUiApi';

// Settings-UI overview device-card budget-exempt rescue handlers. They reach the
// SAME app methods the starvation_rescue widget calls and reuse the shared
// request/candidate/gating helpers, so these assert the settings-UI lane resolves
// the rescue identically to the widget.

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

const taskOwningBudgetDevice: StarvationRescueDevice = {
  ...budgetDevice, deviceId: 'heater-2', deviceName: 'Cabin water', hasSmartTask: true,
};

const noTargetBudgetDevice: StarvationRescueDevice = {
  ...budgetDevice, deviceId: 'heater-3', deviceName: 'Garage', intendedNormalTargetC: null,
};

const buildEstimate = (
  overrides: Partial<DeferredObjectivePlanPreviewEstimate> = {},
): DeferredObjectivePlanPreviewEstimate => ({
  status: 'on_track',
  scheduledHours: [{ startsAtMs: NOW_MS, plannedKWh: 1.5 }],
  projectedFinishAtMs: NOW_MS + 2 * 60 * 60 * 1000,
  energyEstimateKWh: 1.5,
  energyExpectedKWh: 1.4,
  costEstimate: 2.1,
  costUnit: 'kr',
  ...overrides,
});

const freshPreviewPlan = (estimate = buildEstimate()) => vi.fn(
  (_deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => ({
    estimate,
    deadlineAtMs: candidate.deadlineAtMs,
    hasExistingObjective: false,
  }),
);

const buildContext = (app: Record<string, unknown>) => ({
  homey: {
    app,
    clock: { getTimezone: () => TIME_ZONE },
  } as never,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getSettingsUiStarvationRescueDevices', () => {
  it('returns only the rescuable (budget, task-free, known-target) device IDs', () => {
    const getStarvedRescueDevices = vi.fn(() => [
      budgetDevice, capacityDevice, taskOwningBudgetDevice, noTargetBudgetDevice,
    ]);
    const payload = getSettingsUiStarvationRescueDevices(buildContext({ getStarvedRescueDevices }));
    expect(payload.rescuableDeviceIds).toEqual(['heater-1']);
  });

  it('returns an empty set when the app getter is missing', () => {
    expect(getSettingsUiStarvationRescueDevices(buildContext({})).rescuableDeviceIds).toEqual([]);
  });
});

describe('previewSettingsUiStarvationRescue', () => {
  it('rejects a malformed request without calling the app', () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = previewSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: '' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewStarvationRescuePlan).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a capacity-starved device with not_rescuable', () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = previewSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [capacityDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'rad-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(previewStarvationRescuePlan).not.toHaveBeenCalled();
  });

  it('previews a budget-starved device with the now+3h deadline and a formatted label', () => {
    const previewStarvationRescuePlan = freshPreviewPlan();
    const result = previewSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), previewStarvationRescuePlan }),
      body: { deviceId: 'heater-1' },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.deadlineAtMs).toBe(NOW_MS + RESCUE_HORIZON_MS);
    expect(typeof result.deadlineLabel).toBe('string');
    // The candidate handed to the app carries the budget exemption + the device's
    // intended normal target (resolved server-side, never from the client).
    const candidate = previewStarvationRescuePlan.mock.calls[0][1];
    // Temperature-variant field; narrow off the EvSoc | Temperature candidate union.
    expect((candidate as { targetTemperatureC?: number }).targetTemperatureC).toBe(65);
    expect(candidate.rescue?.exemptFromBudget).toBe('always');
  });
});

describe('createSettingsUiStarvationRescue', () => {
  it('GUARDRAIL: rejects a no-target budget device with no_target', () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true }));
    const result = createSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [noTargetBudgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-3' },
    });
    expect(result).toEqual({ ok: false, reason: 'no_target' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('GUARDRAIL: rejects a task-owning budget device with not_rescuable', () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true }));
    const result = createSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [taskOwningBudgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-2' },
    });
    expect(result).toEqual({ ok: false, reason: 'not_rescuable' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('rejects an echoed deadline that has slipped past the rescue horizon', () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: true }));
    const result = createSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1', deadlineAtMs: NOW_MS + RESCUE_HORIZON_MS + 60_000 },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(rescueDeviceWithBudgetExemption).not.toHaveBeenCalled();
  });

  it('commits the rescue and reports runsCurrentHour from the just-persisted plan', () => {
    const previewStarvationRescuePlan = freshPreviewPlan(
      buildEstimate({ scheduledHours: [{ startsAtMs: NOW_MS, plannedKWh: 1.2 }] }),
    );
    const rescueDeviceWithBudgetExemption = vi.fn(
      (_deviceId: string, _candidate: DeferredObjectivePlanPreviewCandidate) => ({ ok: true }),
    );
    const result = createSettingsUiStarvationRescue({
      ...buildContext({
        getStarvedRescueDevices: vi.fn(() => [budgetDevice]),
        rescueDeviceWithBudgetExemption,
        previewStarvationRescuePlan,
      }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: true, runsCurrentHour: true });
    const candidate = rescueDeviceWithBudgetExemption.mock.calls[0][1];
    expect(candidate.rescue?.exemptFromBudget).toBe('always');
    expect(candidate.deadlineAtMs).toBe(NOW_MS + RESCUE_HORIZON_MS);
  });

  it('maps a write_refused app rejection onto the retryable write_conflict reason', () => {
    const rescueDeviceWithBudgetExemption = vi.fn(() => ({ ok: false, reason: 'write_refused' }));
    const result = createSettingsUiStarvationRescue({
      ...buildContext({ getStarvedRescueDevices: vi.fn(() => [budgetDevice]), rescueDeviceWithBudgetExemption }),
      body: { deviceId: 'heater-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'write_conflict' });
  });
});
