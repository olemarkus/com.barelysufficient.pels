import {
  createDeferredObjectiveStatusBus,
  emitDeferredObjectiveLifecycleTransitions,
  emitDeferredObjectiveStatusTransitions,
} from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';

const baseDiagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> & {
  deviceId: string;
  trajectory: DeferredObjectiveDiagnostic['trajectory'];
}): DeferredObjectiveDiagnostic => ({
  deviceName: 'Boiler',
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  progressDirection: 'increasing',
  enforcement: 'soft',
  reasonCode: overrides.reasonCode ?? 'objective_invalid_deadline',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 55,
  currentTemperatureC: 50,
  // Mirror the production invariant: currentValue/targetValue track the kind's
  // unit (°C for temperature, % for ev_soc), so the fixture stays consistent when
  // a test overrides objectiveKind. An explicit currentValue/targetValue override
  // still wins via the `...overrides` spread below.
  currentValue: (overrides.objectiveKind ?? 'temperature') === 'temperature'
    ? (overrides.currentTemperatureC ?? 50)
    : (overrides.currentPercent ?? null),
  targetValue: (overrides.objectiveKind ?? 'temperature') === 'temperature'
    ? (overrides.targetTemperatureC ?? 55)
    : (overrides.targetPercent ?? null),
  deadlineAtMs: overrides.deadlineAtMs ?? 1_700_000_000_000,
  deadlineLocalTime: '07:00',
  energyNeededKWh: 1.5,
  kWhPerUnitBanded: 0.3,
  rateConfidence: null,
  horizonBucketCount: 1,
  expectedStepId: null,
  ...overrides,
  // Spreading a `Partial<DeferredObjectiveDiagnostic>` (itself a union) widens
  // the literal back to the union of both kind-discriminated members; the
  // temperature defaults above keep it a valid temperature diagnostic at runtime.
} as DeferredObjectiveDiagnostic);

const emitLifecycle = (params: {
  diagnostics: DeferredObjectiveDiagnostic[];
  nowMs: number;
  onDeadlineReached?: (
    deviceId: string,
    deadlineAtMs: number,
    nowMs: number,
  ) => void;
  onFallbackInactive?: (deviceId: string) => void;
}): void => {
  emitDeferredObjectiveLifecycleTransitions(params.diagnostics, new Set(), params.nowMs, params);
};

describe('emitDeferredObjectiveStatusTransitions', () => {
  it('publishes only on status changes', () => {
    const bus = createDeferredObjectiveStatusBus();
    const transitions: string[] = [];
    bus.onTransition((snapshot) => transitions.push(snapshot.status));

    const diag = baseDiagnostic({ deviceId: 'heater-1', trajectory: { kind: 'resolved', status: 'on_track' } });
    emitDeferredObjectiveStatusTransitions([diag], bus, 1);
    emitDeferredObjectiveStatusTransitions([diag], bus, 2);
    expect(transitions).toEqual(['on_track']);

    const next = baseDiagnostic({ deviceId: 'heater-1', trajectory: { kind: 'resolved', status: 'at_risk' } });
    emitDeferredObjectiveStatusTransitions([next], bus, 3);
    expect(transitions).toEqual(['on_track', 'at_risk']);
  });

  it('reports a cooling task shortfall above its lower target', () => {
    const bus = createDeferredObjectiveStatusBus();
    const diag = baseDiagnostic({
      deviceId: 'cooler-1',
      trajectory: { kind: 'resolved', status: 'on_track' },
      progressDirection: 'decreasing',
      targetTemperatureC: 22,
      currentTemperatureC: 26,
    });

    emitDeferredObjectiveStatusTransitions([diag], bus, 1);

    expect(bus.getCurrent('cooler-1')?.shortfallText).toBe('4 °C above target');
  });

  it('does not report a cooling shortfall once the temperature is at or below target', () => {
    const bus = createDeferredObjectiveStatusBus();
    const diag = baseDiagnostic({
      deviceId: 'cooler-1',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      progressDirection: 'decreasing',
      targetTemperatureC: 22,
      currentTemperatureC: 20,
    });

    emitDeferredObjectiveStatusTransitions([diag], bus, 1);

    expect(bus.getCurrent('cooler-1')?.shortfallText).toBeNull();
  });

  it('fires onDeadlineReached (deviceId, deadlineAtMs, nowMs) once the deadline has passed', () => {
    // Regression: the clock-driven terminal disable. Before this, a cap-off
    // device on a missed deadline in power_source=flow mode was left running —
    // the auto-disable removed the diagnostic before the next sparse plan cycle
    // could emit the terminal shed_release. The lifecycle clock now drives the
    // ending (release + gated disarm); the app callback gets deadlineAtMs/nowMs
    // so it can grace-bound the disarm while the release settles.
    const onDeadlineReached = vi.fn();
    const diag = baseDiagnostic({ deviceId: 'heater-1', trajectory: { kind: 'resolved', status: 'at_risk' }, deadlineAtMs: 1_000 });

    emitLifecycle({ diagnostics: [diag], nowMs: 999, onDeadlineReached });
    expect(onDeadlineReached).not.toHaveBeenCalled();

    emitLifecycle({ diagnostics: [diag], nowMs: 1_000, onDeadlineReached });
    expect(onDeadlineReached).toHaveBeenCalledWith('heater-1', 1_000, 1_000);
  });

  it('routes EV tasks through the same smart-task-neutral deadline hook', () => {
    const onDeadlineReached = vi.fn();
    const diag = baseDiagnostic({
      deviceId: 'ev-1',
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      objectiveKind: 'ev_soc',
      deadlineAtMs: 1_000,
    });

    emitLifecycle({ diagnostics: [diag], nowMs: 2_000, onDeadlineReached });
    expect(onDeadlineReached).toHaveBeenCalledWith('ev-1', 1_000, 2_000);
  });

  // Only the deadline ends a task: a satisfied one keeps governing its device
  // through admission until then (owner ruling 2026-10-17).
  it('owns no fallback for a satisfied task before its deadline, and ends it at the deadline', () => {
    const onFallbackInactive = vi.fn();
    const onDeadlineReached = vi.fn();
    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      deadlineAtMs: 1_000,
    });

    emitLifecycle({ diagnostics: [diag], nowMs: 999, onFallbackInactive, onDeadlineReached });
    expect(onFallbackInactive).toHaveBeenCalledWith('heater-1');
    expect(onDeadlineReached).not.toHaveBeenCalled();

    emitLifecycle({ diagnostics: [diag], nowMs: 1_000, onFallbackInactive, onDeadlineReached });
    expect(onDeadlineReached).toHaveBeenCalledWith('heater-1', 1_000, 1_000);
    expect(onFallbackInactive).toHaveBeenCalledTimes(1);
  });

  it('sets the sticky deadlineMissed flag once the deadline has passed without satisfaction', () => {
    // The dedicated "ended" Flow trigger is published from planHistory.ts now;
    // statusTransitions only carries the sticky snapshot flag that gates the
    // status-change trigger from firing once a run has missed.
    const bus = createDeferredObjectiveStatusBus();

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'at_risk' },
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions([diag], bus, 999);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);
    emitDeferredObjectiveStatusTransitions([diag], bus, 1_000);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
    emitDeferredObjectiveStatusTransitions([diag], bus, 1_500);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('does not set deadlineMissed when status reaches satisfied at the deadline', () => {
    const bus = createDeferredObjectiveStatusBus();
    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions([diag], bus, 5_000);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);
  });

  it('keeps deadlineMissed sticky across later status changes', () => {
    const bus = createDeferredObjectiveStatusBus();

    const atRisk = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'at_risk' },
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions([atRisk], bus, 1_500);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    const cannotMeet = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'cannot_meet' },
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions([cannotMeet], bus, 1_600);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    emitDeferredObjectiveStatusTransitions([cannotMeet], bus, 1_700);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('clears deadlineMissed when the deadline is rescheduled to the future', () => {
    const bus = createDeferredObjectiveStatusBus();

    const initialDeadline = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'at_risk' },
      deadlineAtMs: 1_000,
    });
    emitDeferredObjectiveStatusTransitions([initialDeadline], bus, 1_500);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);

    // User reschedules to a future time without changing status.
    const rescheduled = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'at_risk' },
      deadlineAtMs: 5_000,
    });
    emitDeferredObjectiveStatusTransitions([rescheduled], bus, 2_000);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(false);

    // Once the new deadline elapses without satisfaction, the sticky flag flips back on.
    emitDeferredObjectiveStatusTransitions([rescheduled], bus, 5_000);
    expect(bus.getCurrent('heater-1')?.deadlineMissed).toBe(true);
  });

  it('invokes onDeadlineReached once the deadline has passed (any non-trivial status)', () => {
    const reached: string[] = [];
    const onDeadlineReached = (deviceId: string) => { reached.push(deviceId); };

    const diag = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'at_risk' },
      deadlineAtMs: 1_000,
    });
    // Pre-deadline: no callback.
    emitLifecycle({ diagnostics: [diag], nowMs: 999, onDeadlineReached });
    expect(reached).toEqual([]);
    // Deadline reached: callback fires each post-deadline tick (the app callback
    // gates the actual disarm on the release settling), so we only assert here
    // that the first post-deadline tick triggers it.
    emitLifecycle({ diagnostics: [diag], nowMs: 1_000, onDeadlineReached });
    expect(reached[0]).toBe('heater-1');
  });

  it('invokes onDeadlineReached for a satisfied-at-deadline objective (so the app callback can disarm it)', () => {
    // Regression for the case where a device reaches its target before the
    // deadline and remains 'satisfied' as the deadline passes. The previous
    // gating on deadlineJustPassed (which is false for satisfied) skipped the
    // ending hook; now it fires on any post-deadline diagnostic regardless of
    // status branch so the app callback disarms it.
    const reached: string[] = [];
    const onDeadlineReached = (deviceId: string) => { reached.push(deviceId); };

    const satisfied = baseDiagnostic({
      deviceId: 'heater-1',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      deadlineAtMs: 1_000,
    });
    emitLifecycle({ diagnostics: [satisfied], nowMs: 999, onDeadlineReached });
    expect(reached).toEqual([]);
    emitLifecycle({ diagnostics: [satisfied], nowMs: 1_500, onDeadlineReached });
    expect(reached).toEqual(['heater-1']);
  });

  it('forgets devices no longer present in diagnostics', () => {
    const bus = createDeferredObjectiveStatusBus();
    emitDeferredObjectiveStatusTransitions(
      [baseDiagnostic({ deviceId: 'heater-1', trajectory: { kind: 'resolved', status: 'on_track' } })],
      bus,
      0,
    );
    expect(bus.hasActive('heater-1')).toBe(true);
    emitDeferredObjectiveStatusTransitions([], bus, 1);
    expect(bus.hasActive('heater-1')).toBe(false);
  });
});
