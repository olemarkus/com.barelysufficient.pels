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
  expectedStepId: null,
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

  it('fires onDeadlineReached (deviceId, objectiveKind, deadlineAtMs, nowMs) once the deadline has passed', () => {
    // Regression: the clock-driven terminal disable. Before this, a cap-off
    // device on a missed deadline in power_source=flow mode was left running —
    // the auto-disable removed the diagnostic before the next sparse plan cycle
    // could emit the terminal shed_release. The lifecycle clock now drives the
    // ending (release + gated disarm); the app callback gets deadlineAtMs/nowMs
    // so it can grace-bound the disarm while the release settles.
    const bus = createDeferredObjectiveStatusBus();
    const onDeadlineReached = vi.fn();
    const diag = baseDiagnostic({ deviceId: 'heater-1', status: 'at_risk', deadlineAtMs: 1_000 });

    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 999, onDeadlineReached });
    expect(onDeadlineReached).not.toHaveBeenCalled();

    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 1_000, onDeadlineReached });
    expect(onDeadlineReached).toHaveBeenCalledWith('heater-1', 'temperature', 1_000, 1_000);
  });

  it('routes objectiveKind through to onDeadlineReached so EV tasks can pause the charger', () => {
    const bus = createDeferredObjectiveStatusBus();
    const onDeadlineReached = vi.fn();
    const diag = baseDiagnostic({
      deviceId: 'ev-1',
      status: 'cannot_meet',
      objectiveKind: 'ev_soc',
      deadlineAtMs: 1_000,
    });

    emitDeferredObjectiveStatusTransitions({ diagnostics: [diag], statusBus: bus, nowMs: 2_000, onDeadlineReached });
    expect(onDeadlineReached).toHaveBeenCalledWith('ev-1', 'ev_soc', 1_000, 2_000);
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

  it('invokes onDeadlineReached once the deadline has passed (any non-trivial status)', () => {
    const bus = createDeferredObjectiveStatusBus();
    const reached: string[] = [];
    const onDeadlineReached = (deviceId: string) => { reached.push(deviceId); };

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'at_risk',
      deadlineAtMs: 1_000,
    });
    // Pre-deadline: no callback.
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [diag], statusBus: bus, nowMs: 999, onDeadlineReached,
    });
    expect(reached).toEqual([]);
    // Deadline reached: callback fires each post-deadline tick (the app callback
    // gates the actual disarm on the release settling), so we only assert here
    // that the first post-deadline tick triggers it.
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [diag], statusBus: bus, nowMs: 1_000, onDeadlineReached,
    });
    expect(reached[0]).toBe('heater-1');
  });

  it('invokes onDeadlineReached for a satisfied-at-deadline objective (so the app callback can disarm it)', () => {
    // Regression for the case where a device reaches its target before the
    // deadline and remains 'satisfied' as the deadline passes. The previous
    // gating on deadlineJustPassed (which is false for satisfied) skipped the
    // ending hook; now it fires on any post-deadline diagnostic regardless of
    // status branch so the app callback disarms it.
    const bus = createDeferredObjectiveStatusBus();
    const reached: string[] = [];
    const onDeadlineReached = (deviceId: string) => { reached.push(deviceId); };

    const satisfied = baseDiagnostic({
      deviceId: 'heater-1',
      status: 'satisfied',
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [satisfied], statusBus: bus, nowMs: 999, onDeadlineReached,
    });
    expect(reached).toEqual([]);
    emitDeferredObjectiveStatusTransitions({
      diagnostics: [satisfied], statusBus: bus, nowMs: 1_500, onDeadlineReached,
    });
    expect(reached).toEqual(['heater-1']);
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
