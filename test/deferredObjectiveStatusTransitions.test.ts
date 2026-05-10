import {
  createDeferredObjectiveStatusBus,
  emitDeferredObjectiveStatusTransitions,
} from '../lib/plan/deferredObjectives';
import type { DeferredObjectiveDiagnostic } from '../lib/plan/deferredObjectives/diagnosticsBridge';

const baseDiagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> & {
  deviceId: string;
  status: DeferredObjectiveDiagnostic['status'];
}): DeferredObjectiveDiagnostic => ({
  deviceId: overrides.deviceId,
  deviceName: 'Boiler',
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: overrides.status,
  reasonCode: overrides.reasonCode ?? 'objective_invalid_deadline',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 55,
  currentTemperatureC: 50,
  deadlineAtMs: overrides.deadlineAtMs ?? 1_700_000_000_000,
  deadlineLocalTime: '07:00',
  deadlineRollsToNextDay: false,
  energyNeededKWh: 1.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 0.3,
  rateConfidence: null,
  horizonBucketCount: 1,
  requestedMinimumStepId: null,
  ...overrides,
});

describe('emitDeferredObjectiveStatusTransitions', () => {
  it('publishes only on status changes', () => {
    const bus = createDeferredObjectiveStatusBus();
    const transitions: string[] = [];
    bus.onTransition((snapshot) => transitions.push(snapshot.status));

    const diag = baseDiagnostic({ deviceId: 'heater-1', status: 'on_track' });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1 });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 2 });
    expect(transitions).toEqual(['on_track']);

    const next = baseDiagnostic({ deviceId: 'heater-1', status: 'at_risk' });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [next], statusBus: bus, nowMs: 3 });
    expect(transitions).toEqual(['on_track', 'at_risk']);
  });

  it('publishes deadline_missed when the deadline has passed without satisfaction', () => {
    const bus = createDeferredObjectiveStatusBus();
    const missed: string[] = [];
    bus.onMissed((snapshot) => missed.push(snapshot.deviceId));

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 999 });
    expect(missed).toEqual([]);
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1_000 });
    expect(missed).toEqual(['heater-1']);
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1_500 });
    expect(missed).toEqual(['heater-1']); // not duplicated
  });

  it('does not publish missed when status reaches satisfied', () => {
    const bus = createDeferredObjectiveStatusBus();
    const missed: string[] = [];
    bus.onMissed((snapshot) => missed.push(snapshot.deviceId));

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'satisfied',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 5_000 });
    expect(missed).toEqual([]);
  });

  it('keeps the missed flag sticky across later status changes (no duplicate emission)', () => {
    const bus = createDeferredObjectiveStatusBus();
    const missed: string[] = [];
    bus.onMissed((snapshot) => missed.push(snapshot.deviceId));

    const atRisk = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [atRisk], statusBus: bus, nowMs: 1_500 });
    expect(missed).toEqual(['heater-1']);

    const cannotMeet = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'cannot_meet',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [cannotMeet], statusBus: bus, nowMs: 1_600 });
    expect(missed).toEqual(['heater-1']); // status changed, but missed must not re-fire
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    emitDeferredObjectiveStatusTransitions({ diagnostics: [cannotMeet], statusBus: bus, nowMs: 1_700 });
    expect(missed).toEqual(['heater-1']);
  });

  it('clears the missed flag and re-fires when the deadline is rescheduled to the future', () => {
    const bus = createDeferredObjectiveStatusBus();
    const missed: string[] = [];
    bus.onMissed((snapshot) => missed.push(snapshot.deviceId));

    const initialDeadline = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [initialDeadline], statusBus: bus, nowMs: 1_500 });
    expect(missed).toEqual(['heater-1']);

    // User reschedules to a future time without changing status.
    const rescheduled = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 5_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [rescheduled], statusBus: bus, nowMs: 2_000 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);

    emitDeferredObjectiveStatusTransitions({ diagnostics: [rescheduled], statusBus: bus, nowMs: 5_000 });
    expect(missed).toEqual(['heater-1', 'heater-1']);
  });

  it('forgets devices no longer present in diagnostics', () => {
    const bus = createDeferredObjectiveStatusBus();
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [baseDiagnostic({ deviceId: 'heater-1', status: 'on_track' })],
      statusBus: bus,
      nowMs: 0,
    });
    expect(bus.hasActive('heater-1')).toBe(true);
    emitDeferredObjectiveStatusTransitions({ diagnostics: [], statusBus: bus, nowMs: 1 });
    expect(bus.hasActive('heater-1')).toBe(false);
  });
});
