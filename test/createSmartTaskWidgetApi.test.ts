/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveDeferredObjectiveDeadline,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectivePlanPreviewEstimate,
} from '../lib/objectives/deferredObjectives';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import {
  createCreateSmartTask,
  getCreateSmartTaskDevices,
  previewCreateSmartTask,
} from '../widgets/create_smart_task/src/api';

const TIME_ZONE = 'Europe/Oslo';
// 2026-01-01 05:00 Oslo (04:00 UTC, winter = UTC+1). A 07:00 ready-by resolves
// to today; a 03:00 ready-by rolls to tomorrow.
const NOW_MS = Date.UTC(2026, 0, 1, 4, 0, 0);

const buildEstimate = (overrides: Partial<DeferredObjectivePlanPreviewEstimate> = {}): DeferredObjectivePlanPreviewEstimate => ({
  status: 'on_track',
  scheduledHours: [{ startsAtMs: NOW_MS + 60 * 60 * 1000, plannedKWh: 2 }],
  projectedFinishAtMs: NOW_MS + 2 * 60 * 60 * 1000,
  energyEstimateKWh: 2,
  energyExpectedKWh: 1.8,
  costEstimate: 3.4,
  costUnit: 'kr',
  ...overrides,
});

const evDevice: TargetDeviceSnapshot = {
  id: 'ev-1',
  name: 'Driveway',
  targets: [],
  currentOn: false,
  deviceClass: 'evcharger',
} as TargetDeviceSnapshot;

type AppMock = {
  getCreateSmartTaskCandidateDevices: ReturnType<typeof vi.fn>;
  previewDeferredObjectivePlan: ReturnType<typeof vi.fn>;
  createDeferredObjective: ReturnType<typeof vi.fn>;
};

const buildContext = (app: Partial<AppMock>) => ({
  homey: {
    app,
    clock: { getTimezone: () => TIME_ZONE },
  },
});

const expectedDeadline = (localTime: string): number => {
  const resolution = resolveDeferredObjectiveDeadline({ nowMs: NOW_MS, timeZone: TIME_ZONE, deadlineLocalTime: localTime });
  if (resolution.deadlineAtMs === null) throw new Error('failed to resolve test deadline');
  return resolution.deadlineAtMs;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getCreateSmartTaskDevices', () => {
  it('builds the device payload from the runtime-planned candidate snapshot', async () => {
    const getCreateSmartTaskCandidateDevices = vi.fn(() => [evDevice]);
    const payload = await getCreateSmartTaskDevices(buildContext({ getCreateSmartTaskCandidateDevices }));
    expect(getCreateSmartTaskCandidateDevices).toHaveBeenCalledOnce();
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0]).toMatchObject({ deviceId: 'ev-1', kind: 'ev_soc', unitSymbol: '%' });
  });

  it('returns empty when the app method is missing', async () => {
    const payload = await getCreateSmartTaskDevices(buildContext({}));
    expect(payload.state).toBe('empty');
  });
});

describe('previewCreateSmartTask', () => {
  it('rejects a malformed candidate without calling the app', async () => {
    const previewDeferredObjectivePlan = vi.fn();
    const result = await previewCreateSmartTask({
      ...buildContext({ previewDeferredObjectivePlan }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 'eighty', readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('rejects an invalid ready-by time', async () => {
    const previewDeferredObjectivePlan = vi.fn();
    const result = await previewCreateSmartTask({
      ...buildContext({ previewDeferredObjectivePlan }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '25:99' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range target without calling the app (parity with create)', async () => {
    const previewDeferredObjectivePlan = vi.fn();
    const result = await previewCreateSmartTask({
      ...buildContext({ previewDeferredObjectivePlan }),
      // 150% is shape-valid (finite number) but out of the 1..100 battery range.
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 150, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
    expect(previewDeferredObjectivePlan).not.toHaveBeenCalled();
  });

  it('reports unavailable when the preview app method is missing', async () => {
    const result = await previewCreateSmartTask({
      ...buildContext({}),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('resolves the ready-by to a deadline and forwards the candidate', async () => {
    let received: { deviceId: string; candidate: DeferredObjectivePlanPreviewCandidate } | null = null;
    const previewDeferredObjectivePlan = vi.fn((deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = { deviceId, candidate };
      return buildEstimate();
    });
    const result = await previewCreateSmartTask({
      ...buildContext({ previewDeferredObjectivePlan }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00' },
    });
    if (!result.ok) throw new Error('expected ok preview');
    const deadline = expectedDeadline('07:00');
    expect(result.deadlineAtMs).toBe(deadline);
    expect(result.estimate.costEstimate).toBe(3.4);
    expect(result.deadlineLabel).toMatch(/\d{2}:\d{2}/);
    // Scheduled window is formatted server-side in the Homey TZ (Oslo). The
    // single estimate hour starts at NOW+1h = 06:00 Oslo (05:00 UTC + 1h).
    expect(result.scheduledWindowLabel).toBe('06:00');
    expect(received).not.toBeNull();
    expect(received!.deviceId).toBe('ev-1');
    expect(received!.candidate).toEqual({
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs: deadline,
    });
  });

  it('rolls a ready-by that already passed today to tomorrow', async () => {
    const previewDeferredObjectivePlan = vi.fn(() => buildEstimate());
    const result = await previewCreateSmartTask({
      ...buildContext({ previewDeferredObjectivePlan }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '03:00' },
    });
    if (!result.ok) throw new Error('expected ok preview');
    // 03:00 local is before now (05:00 local) → next occurrence is tomorrow.
    expect(result.deadlineAtMs).toBe(expectedDeadline('03:00'));
    expect(result.deadlineAtMs).toBeGreaterThan(NOW_MS);
  });
});

describe('createCreateSmartTask', () => {
  it('rejects a malformed candidate without calling the app', async () => {
    const createDeferredObjective = vi.fn();
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: '', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_request' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range target without calling createDeferredObjective', async () => {
    const createDeferredObjective = vi.fn();
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: 'heater-1', kind: 'temperature', target: 5000, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('forwards a valid candidate to createDeferredObjective', async () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true as const }));
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: 'heater-1', kind: 'temperature', target: 65, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: true });
    expect(createDeferredObjective).toHaveBeenCalledWith('heater-1', {
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineAtMs: expectedDeadline('07:00'),
    });
  });

  it('maps an app rejection reason to the response', async () => {
    const createDeferredObjective = vi.fn(() => ({ ok: false as const, reason: 'device_not_eligible' }));
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: 'ev-1', kind: 'temperature', target: 65, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'device_not_eligible' });
  });

  it('maps the picker-only device_not_planned rejection to the response', async () => {
    const createDeferredObjective = vi.fn(() => ({ ok: false as const, reason: 'device_not_planned' }));
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
  });

  it('persists the previewed deadline verbatim when the client echoes it back', async () => {
    let received: DeferredObjectivePlanPreviewCandidate | null = null;
    const createDeferredObjective = vi.fn((_deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = candidate;
      return { ok: true as const };
    });
    const previewedDeadline = expectedDeadline('07:00');
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: {
        deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00', deadlineAtMs: previewedDeadline,
      },
    });
    expect(result).toEqual({ ok: true });
    expect(received).not.toBeNull();
    // The persisted deadline is exactly what the preview resolved — not a fresh
    // server re-resolution that could have rolled to a later occurrence.
    expect(received!.deadlineAtMs).toBe(previewedDeadline);
  });

  // The minute-boundary roll: the user previews "Ready by today 07:00" within
  // the same minute, then confirms a beat later once 07:00 is in the past. The
  // server must NOT silently re-resolve to tomorrow (which would make the
  // created task disagree with the previewed "today" window) — it rejects with
  // `deadline_passed` so the widget re-previews.
  it('rejects a previewed deadline that has slipped into the past with deadline_passed', async () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true as const }));
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: {
        deviceId: 'ev-1',
        kind: 'ev_soc',
        target: 80,
        readyByLocalTime: '07:00',
        // One second before "now" — the previewed minute just elapsed.
        deadlineAtMs: NOW_MS - 1000,
      },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('rejects an implausibly far-future client deadline with deadline_passed', async () => {
    const createDeferredObjective = vi.fn(() => ({ ok: true as const }));
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: {
        deviceId: 'ev-1',
        kind: 'ev_soc',
        target: 80,
        readyByLocalTime: '07:00',
        deadlineAtMs: NOW_MS + 48 * 60 * 60 * 1000,
      },
    });
    expect(result).toEqual({ ok: false, reason: 'deadline_passed' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });

  it('falls back to server re-resolution when no client deadline is supplied', async () => {
    let received: DeferredObjectivePlanPreviewCandidate | null = null;
    const createDeferredObjective = vi.fn((_deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
      received = candidate;
      return { ok: true as const };
    });
    const result = await createCreateSmartTask({
      ...buildContext({ createDeferredObjective }),
      body: { deviceId: 'ev-1', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00' },
    });
    expect(result).toEqual({ ok: true });
    expect(received!.deadlineAtMs).toBe(expectedDeadline('07:00'));
  });
});
