/**
 * @vitest-environment node
 */
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import {
  buildSmartTasksWidgetPayload,
  EMPTY_SUBTITLE_DEFAULT,
  ROW_CAP,
} from '../widgets/smart_tasks/src/smartTasksWidgetPayload';

const NOW = new Date('2026-05-26T10:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

const buildPlan = (overrides: Partial<DeferredObjectiveActivePlanV1>): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'dev',
  deviceName: 'Device',
  objectiveKind: 'temperature',
  targetTemperatureC: 55,
  targetPercent: null,
  deadlineAtMs: NOW + 5 * HOUR,
  startedAtMs: NOW - HOUR,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: NOW,
    computedFromPricesUpTo: null,
    reason: 'flow_card',
    hours: [{ startsAtMs: NOW, plannedKWh: 1 }, { startsAtMs: NOW + HOUR, plannedKWh: 1 }],
    energyNeededKWh: 2,
    planStatus: 'on_track',
  },
  ...overrides,
});

const buildDevice = (overrides: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => ({
  id: 'dev',
  name: 'Device',
  zoneName: null,
  capabilities: [],
  ...overrides,
} as TargetDeviceSnapshot);

const buildInput = (plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>, devices: TargetDeviceSnapshot[] = []) => ({
  activePlans: { version: 1, plansByDeviceId } as DeferredObjectiveActivePlansV1,
  devices,
  nowMs: NOW,
  timeZone: 'UTC',
});

describe('buildSmartTasksWidgetPayload', () => {
  test('returns empty payload when no active plans', () => {
    const payload = buildSmartTasksWidgetPayload({ activePlans: null, devices: [], nowMs: NOW });
    expect(payload).toEqual({ state: 'empty', subtitle: EMPTY_SUBTITLE_DEFAULT });
  });

  test('returns empty payload when every plan is satisfied', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      a: buildPlan({ deviceId: 'a', latest: { ...buildPlan({}).latest!, planStatus: 'satisfied' } }),
    }));
    expect(payload.state).toBe('empty');
  });

  test('sorts cannot_meet → at_risk → pending → on_track', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      onTrack: buildPlan({ deviceId: 'onTrack', deviceName: 'On track' }),
      atRisk: buildPlan({
        deviceId: 'atRisk',
        deviceName: 'At risk',
        latest: { ...buildPlan({}).latest!, planStatus: 'at_risk' },
      }),
      pending: buildPlan({ deviceId: 'pending', deviceName: 'Pending', pending: true, latest: null }),
      cannot: buildPlan({
        deviceId: 'cannot',
        deviceName: 'Cannot',
        latest: { ...buildPlan({}).latest!, planStatus: 'cannot_meet' },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows.map((r) => r.deviceName)).toEqual(['Cannot', 'At risk', 'Pending']);
    expect(payload.overflowCount).toBe(1);
  });

  test('caps at 3 rows', () => {
    const plans: Record<string, DeferredObjectiveActivePlanV1> = {};
    for (let i = 0; i < 5; i += 1) {
      plans[`d${i}`] = buildPlan({ deviceId: `d${i}`, deviceName: `Dev ${i}`, deadlineAtMs: NOW + (i + 1) * HOUR });
    }
    const payload = buildSmartTasksWidgetPayload(buildInput(plans));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows).toHaveLength(ROW_CAP);
    expect(payload.overflowCount).toBe(2);
  });

  test('tie-breaks on ETA ascending, then deadline ascending', () => {
    // Same tier (on_track); ETA derives from last hour + 1h. First hour at NOW
    // so resolveSmartTaskListStatus doesn't collapse to 'queued'.
    const earlyEta = buildPlan({
      deviceId: 'early',
      deviceName: 'Early ETA',
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW, plannedKWh: 1 }],
      },
      deadlineAtMs: NOW + 8 * HOUR,
    });
    const lateEta = buildPlan({
      deviceId: 'late',
      deviceName: 'Late ETA',
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW, plannedKWh: 1 }, { startsAtMs: NOW + 2 * HOUR, plannedKWh: 1 }],
      },
      deadlineAtMs: NOW + 4 * HOUR,
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ late: lateEta, early: earlyEta }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows.map((r) => r.deviceName)).toEqual(['Early ETA', 'Late ETA']);
  });

  test('uses the deadline (not the planner ETA) as the displayed finish time', () => {
    // Planner schedules a single hour at NOW, so etaMs = NOW + 1h, but the
    // deadline is much later. The displayed finishLabel must reflect the
    // deadline, not the projection — sort still uses ETA as the tie-break.
    const deadline = new Date('2026-05-26T18:30:00.000Z').getTime();
    const plan = buildPlan({
      deviceId: 'dev',
      deadlineAtMs: deadline,
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW, plannedKWh: 1 }],
      },
    });
    const payload = buildSmartTasksWidgetPayload({
      ...buildInput({ dev: plan }),
      timeZone: 'UTC',
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].finishLabel).toBe('18:30');
  });

  test('joins live current value from device snapshot', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput(
      { dev: buildPlan({ deviceId: 'dev', targetTemperatureC: 55 }) },
      [buildDevice({ id: 'dev', currentTemperature: 42 })],
    ));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].currentValue).toBe(42);
    expect(payload.rows[0].targetValue).toBe(55);
    expect(payload.rows[0].unitSymbol).toBe('°C');
  });

  test('renders EV plans with % unit', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput(
      { ev: buildPlan({ deviceId: 'ev', objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 80 }) },
      [buildDevice({ id: 'ev', stateOfCharge: { percent: 60 } } as Partial<TargetDeviceSnapshot>)],
    ));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].unitSymbol).toBe('%');
    expect(payload.rows[0].currentValue).toBe(60);
    expect(payload.rows[0].targetValue).toBe(80);
  });

  test('excludes plans with non-finite deadlineAtMs', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      bad: buildPlan({ deviceId: 'bad', deadlineAtMs: Number.NaN }),
    }));
    expect(payload.state).toBe('empty');
  });

  test('renders row with null currentValue when device snapshot is missing', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      dev: buildPlan({ deviceId: 'dev', deviceName: 'Lonely device' }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].currentValue).toBeNull();
    expect(payload.rows[0].deviceName).toBe('Lonely device');
  });

  test('classifies queued (plan ready, first hour in future) into the on_track tier', () => {
    const queuedPlan = buildPlan({
      deviceId: 'queued',
      deviceName: 'Queued',
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW + 2 * HOUR, plannedKWh: 1 }],
        planStatus: 'on_track',
      },
    });
    const atRiskPlan = buildPlan({
      deviceId: 'risk',
      deviceName: 'Risky',
      latest: { ...buildPlan({}).latest!, planStatus: 'at_risk' },
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ queued: queuedPlan, risk: atRiskPlan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows.map((r) => r.deviceName)).toEqual(['Risky', 'Queued']);
    expect(payload.rows[1].statusLabel).toBe('Scheduled');
  });

  test('classifies paused_unplugged (EV unplugged mid-plan) into the pending tier', () => {
    const pausedPlan = buildPlan({
      deviceId: 'ev',
      deviceName: 'EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      diagnosticReasonCode: 'objective_invalid_session',
    });
    const onTrackPlan = buildPlan({ deviceId: 'heat', deviceName: 'Heating' });
    const payload = buildSmartTasksWidgetPayload(buildInput({ ev: pausedPlan, heat: onTrackPlan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows.map((r) => r.deviceName)).toEqual(['EV', 'Heating']);
    expect(payload.rows[0].statusLabel).toBe('Unplugged');
    expect(payload.rows[0].tone).toBe('muted');
  });

  test('uses canonical chip labels from shared-domain', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      a: buildPlan({ deviceId: 'a', latest: { ...buildPlan({}).latest!, planStatus: 'cannot_meet' } }),
      b: buildPlan({ deviceId: 'b', latest: { ...buildPlan({}).latest!, planStatus: 'at_risk' } }),
      c: buildPlan({ deviceId: 'c' }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows.map((r) => r.statusLabel)).toEqual(['Cannot finish', 'At risk', 'On track']);
    expect(payload.rows.map((r) => r.tone)).toEqual(['danger', 'warn', 'ok']);
  });
});
