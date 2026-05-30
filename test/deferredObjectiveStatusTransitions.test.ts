import {
  createDeferredObjectiveStatusBus,
  emitDeferredObjectiveStatusTransitions,
} from '../lib/objectives/deferredObjectives';
import type { DeferredObjectiveDiagnostic } from '../lib/objectives/deferredObjectives/diagnosticsBridge';

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
  energyNeededKWh: 1.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 0.3,
  rateConfidence: null,
  horizonBucketCount: 1,
  dailyBudgetExhaustedBucketCount: 0,
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

  it('sets the sticky deadlineMissed flag once the deadline has passed without satisfaction', () => {
    // The dedicated "ended" Flow trigger is published from planHistory.ts now;
    // statusTransitions only carries the sticky snapshot flag that gates the
    // status-change trigger from firing once a run has missed.
    const bus = createDeferredObjectiveStatusBus();

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 999 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1_000 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1_500 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('does not set deadlineMissed when status reaches satisfied at the deadline', () => {
    const bus = createDeferredObjectiveStatusBus();
    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'satisfied',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 5_000 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);
  });

  it('keeps deadlineMissed sticky across later status changes', () => {
    const bus = createDeferredObjectiveStatusBus();

    const atRisk = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [atRisk], statusBus: bus, nowMs: 1_500 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    const cannotMeet = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'cannot_meet',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [cannotMeet], statusBus: bus, nowMs: 1_600 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    emitDeferredObjectiveStatusTransitions({ diagnostics: [cannotMeet], statusBus: bus, nowMs: 1_700 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('clears deadlineMissed when the deadline is rescheduled to the future', () => {
    const bus = createDeferredObjectiveStatusBus();

    const initialDeadline = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [initialDeadline], statusBus: bus, nowMs: 1_500 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    // User reschedules to a future time without changing status.
    const rescheduled = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 5_000,
    });
    emitDeferredObjectiveStatusTransitions({ diagnostics: [rescheduled], statusBus: bus, nowMs: 2_000 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);

    // Once the new deadline elapses without satisfaction, the sticky flag flips back on.
    emitDeferredObjectiveStatusTransitions({ diagnostics: [rescheduled], statusBus: bus, nowMs: 5_000 });
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('invokes onDeadlinePassed once the deadline has passed (any non-trivial status)', () => {
    const bus = createDeferredObjectiveStatusBus();
    const disabled: string[] = [];
    const onDeadlinePassed = (deviceId: string) => { disabled.push(deviceId); };

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    // Pre-deadline: no callback.
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [diag], statusBus: bus, nowMs: 999, onDeadlinePassed,
    });
    expect(disabled).toEqual([]);
    // Deadline reached: callback fires. Subsequent ticks may fire again — the
    // callback itself is idempotent (no-op when enabled is already false),
    // so we only assert here that the first post-deadline tick triggers it.
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [diag], statusBus: bus, nowMs: 1_000, onDeadlinePassed,
    });
    expect(disabled[0]).toBe('heater-1');
  });

  it('disables a satisfied-at-deadline objective so it does not stay enabled forever', () => {
    // Regression for the case where a device reaches its target before the
    // deadline and remains 'satisfied' as the deadline passes. The previous
    // gating on deadlineJustPassed (which is false for satisfied) left the
    // objective enabled indefinitely; now we disable on any post-deadline
    // diagnostic regardless of status branch.
    const bus = createDeferredObjectiveStatusBus();
    const disabled: string[] = [];
    const onDeadlinePassed = (deviceId: string) => { disabled.push(deviceId); };

    const satisfied = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'satisfied',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [satisfied], statusBus: bus, nowMs: 999, onDeadlinePassed,
    });
    expect(disabled).toEqual([]);
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [satisfied], statusBus: bus, nowMs: 1_500, onDeadlinePassed,
    });
    expect(disabled).toEqual(['heater-1']);
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
