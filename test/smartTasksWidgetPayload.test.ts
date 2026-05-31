/**
 * @vitest-environment node
 */
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { SMART_TASK_WIDGET_EMPTY_HINT } from '../packages/shared-domain/src/deadlineLabels';
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
  test('returns empty payload with action hint when no active plans', () => {
    const payload = buildSmartTasksWidgetPayload({ activePlans: null, devices: [], nowMs: NOW });
    expect(payload).toEqual({
      state: 'empty',
      subtitle: EMPTY_SUBTITLE_DEFAULT,
      hint: SMART_TASK_WIDGET_EMPTY_HINT,
    });
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

  test('attaches budget-cause why + recourse on a cannot_meet row', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      dev: buildPlan({
        deviceId: 'dev',
        latest: {
          ...buildPlan({}).latest!,
          planStatus: 'cannot_meet',
          floorShortfallCause: 'budget',
          dailyBudgetExhaustedBucketCount: 3,
        },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].whyLabel).toBe('Today’s daily budget runs out before the deadline.');
    expect(payload.rows[0].recourseHint).toBe(
      'Budget settings show whether future days need power reserved earlier.',
    );
  });

  test('honors a non-budget floorShortfallCause over run-up bucket noise', () => {
    // Regression for the Codex producer-precedence finding: a non-budget
    // producer cause must win even when dailyBudgetExhaustedBucketCount > 0
    // (the run-up merely brushed the cap). Must read as device-driven, not
    // budget-driven.
    const payload = buildSmartTasksWidgetPayload(buildInput({
      dev: buildPlan({
        deviceId: 'dev',
        latest: {
          ...buildPlan({}).latest!,
          planStatus: 'cannot_meet',
          floorShortfallCause: 'time_capacity',
          dailyBudgetExhaustedBucketCount: 4,
        },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].whyLabel).toBe('Not enough delivery before the deadline.');
    expect(payload.rows[0].recourseHint).toBe(
      'Device settings show what’s holding it back.',
    );
  });

  test('attaches device-cause why + recourse on a cannot_meet row', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      dev: buildPlan({
        deviceId: 'dev',
        latest: {
          ...buildPlan({}).latest!,
          planStatus: 'cannot_meet',
          // no budget signals — falls through to device cause
          floorShortfallCause: 'shortfall',
        },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].whyLabel).toBe('Not enough delivery before the deadline.');
    expect(payload.rows[0].recourseHint).toBe(
      'Device settings show what’s holding it back.',
    );
  });

  test('disambiguates at_risk into budget vs time with matching recourse', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      budget: buildPlan({
        deviceId: 'budget',
        deviceName: 'Budget risk',
        latest: {
          ...buildPlan({}).latest!,
          planStatus: 'at_risk',
          dailyBudgetExhaustedBucketCount: 2,
        },
      }),
      time: buildPlan({
        deviceId: 'time',
        deviceName: 'Time risk',
        latest: { ...buildPlan({}).latest!, planStatus: 'at_risk' },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    const byId = Object.fromEntries(payload.rows.map((r) => [r.deviceId, r]));
    expect(byId.budget.whyLabel).toBe('Today’s daily budget may run out before the deadline.');
    expect(byId.budget.recourseHint).toBe(
      'Budget settings show whether future days need power reserved earlier.',
    );
    expect(byId.time.whyLabel).toBe('Limited time left before the deadline.');
    expect(byId.time.recourseHint).toBeNull();
  });

  test('suppresses plan-meta on a cannot_meet row so recourse stays above the fold', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      dev: buildPlan({
        deviceId: 'dev',
        latest: {
          ...buildPlan({}).latest!,
          planStatus: 'cannot_meet',
          energyNeededKWh: 7.2,
          planningSpeedKw: 2.4,
          estimatedDurationText: '3h 0m',
        },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].planMetaLabel).toBeNull();
  });

  test('resolves producer-side word fields (Due verb on failing, kind action verb)', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      heat: buildPlan({
        deviceId: 'heat',
        latest: { ...buildPlan({}).latest!, planStatus: 'cannot_meet' },
      }),
      ev: buildPlan({
        deviceId: 'ev',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    const byId = Object.fromEntries(payload.rows.map((r) => [r.deviceId, r]));
    expect(byId.heat.etaVerb).toBe('Due');
    expect(byId.heat.targetActionVerb).toBe('Heat to');
    expect(byId.heat.targetNoun).toBe('Target');
    expect(byId.ev.etaVerb).toBe('Ready by');
    expect(byId.ev.targetActionVerb).toBe('Charge to');
  });

  test('suppresses the confidence chip while a building_plan task waits on prices', () => {
    const payload = buildSmartTasksWidgetPayload(buildInput({
      p: buildPlan({
        deviceId: 'p',
        pending: true,
        pendingReason: 'awaiting_horizon_plan',
        latest: null,
        kwhPerUnitProvenance: {
          source: 'bootstrap',
          kWhPerUnit: 0.5,
          acceptedSamples: 0,
          confidence: 'low',
          lastAcceptedAtMs: null,
        },
      }),
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].statusLabel).toBe('Building plan…');
    expect(payload.rows[0].confidenceLabel).toBeNull();
  });

  test('attaches queued why with the first planned-hour time', () => {
    const queuedPlan = buildPlan({
      deviceId: 'queued',
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW + 2 * HOUR, plannedKWh: 1 }],
        planStatus: 'on_track',
      },
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ queued: queuedPlan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].statusLabel).toBe('Scheduled');
    expect(payload.rows[0].whyLabel).toBe('Cheaper hours start at 12:00.');
    expect(payload.rows[0].recourseHint).toBeNull();
  });

  test('attaches awaiting-horizon why on a pending row', () => {
    const pendingPlan = buildPlan({
      deviceId: 'p',
      pending: true,
      pendingReason: 'awaiting_horizon_plan',
      latest: null,
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ p: pendingPlan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].whyLabel).toBe('Waiting for tomorrow’s prices.');
    expect(payload.rows[0].recourseHint).toBeNull();
  });

  test('composes planMetaLabel from revision speed + duration + needed energy', () => {
    const plan = buildPlan({
      deviceId: 'dev',
      latest: {
        ...buildPlan({}).latest!,
        hours: [{ startsAtMs: NOW, plannedKWh: 1 }],
        energyNeededKWh: 7.2,
        planningSpeedKw: 2.4,
        estimatedDurationText: '3h 0m',
      },
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ dev: plan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    // Leads with the one-word "Estimate" label so the dense recap line is named
    // before its numbers (de-densing the detail panel's least-legible line).
    expect(payload.rows[0].planMetaLabel?.startsWith('Estimate ')).toBe(true);
    expect(payload.rows[0].planMetaLabel).toContain('≈3h 0m');
    expect(payload.rows[0].planMetaLabel).toContain('2.4 kW');
    expect(payload.rows[0].planMetaLabel).toContain('7.2 kWh');
  });

  test('composes planMetaLabel range form when expected differs from needed', () => {
    const plan = buildPlan({
      deviceId: 'dev',
      latest: {
        ...buildPlan({}).latest!,
        energyExpectedKWh: 7.0,
        energyNeededKWh: 8.0,
        planningSpeedKw: 2.4,
        estimatedDurationText: '3h 0m',
      },
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ dev: plan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].planMetaLabel).toContain('≈7.0–8.0 kWh');
  });

  test('emits confidence label only for cold-start non-cannot_meet rows', () => {
    const learningPlan = buildPlan({
      deviceId: 'learn',
      kwhPerUnitProvenance: {
        source: 'bootstrap',
        kWhPerUnit: 0.5,
        acceptedSamples: 0,
        confidence: 'low',
        lastAcceptedAtMs: null,
      },
      latest: { ...buildPlan({}).latest!, planStatus: 'at_risk' },
    });
    const settledPlan = buildPlan({
      deviceId: 'settled',
      kwhPerUnitProvenance: {
        source: 'learned',
        kWhPerUnit: 0.5,
        acceptedSamples: 12,
        confidence: 'low',
        lastAcceptedAtMs: NOW - HOUR,
      },
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({
      learn: learningPlan,
      settled: settledPlan,
    }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    const byName = Object.fromEntries(payload.rows.map((r) => [r.deviceId, r]));
    expect(byName.learn.confidenceLabel).toBe('Estimating');
    expect(byName.settled.confidenceLabel).toBeNull();
  });

  test('attaches a Today/Tomorrow/weekday-shaped long deadline label', () => {
    const plan = buildPlan({
      deviceId: 'dev',
      deadlineAtMs: NOW + 4 * HOUR,
    });
    const payload = buildSmartTasksWidgetPayload(buildInput({ dev: plan }));
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    // Day-word resolution uses local Y/M/D so it varies with the host TZ;
    // assert the shape only. UTC time half is fixed by the explicit timeZone.
    expect(payload.rows[0].deadlineLongLabel).toMatch(/^(Today|Tomorrow|[A-Z][a-z]{2}) 14:00$/);
  });

  test('resolves the day word in the widget timeZone, not the host TZ', () => {
    // Regression for the Codex P2: now/deadline share a UTC calendar day but
    // cross midnight in Asia/Tokyo (+09). The day word must agree with the
    // time half (both in the widget zone) → "Tomorrow 08:00", not "Today".
    // Deterministic regardless of the CI host timezone.
    const now = new Date('2026-05-26T12:00:00.000Z').getTime(); // 21:00 JST, 26th
    const deadline = new Date('2026-05-26T23:00:00.000Z').getTime(); // 08:00 JST, 27th
    const payload = buildSmartTasksWidgetPayload({
      ...buildInput({ dev: buildPlan({ deviceId: 'dev', deadlineAtMs: deadline }) }),
      nowMs: now,
      timeZone: 'Asia/Tokyo',
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].deadlineLongLabel).toBe('Tomorrow 08:00');
  });
});
