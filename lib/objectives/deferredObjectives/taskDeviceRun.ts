import type { TaskDeliveryEvidence } from '../../../packages/contracts/src/taskDelivery';
import type { ConfirmedTaskSwitchOn } from '../../ports/actuationHistory';
import type { TaskDeliveryFacts } from './deliveryEvidence';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import type { InProgressKey } from './planHistoryInProgressState';

export type TaskDeviceRunEvent = {
  kind: 'started' | 'finished';
  deviceId: string;
  deviceName: string;
  targetEnergyKWh: number;
  deadlineAtMs: number;
};

type RunListener = (event: TaskDeviceRunEvent) => void;

type Run = {
  targetEnergyKWh: number;
} & ({ phase: 'working'; dispatchedAtMs: number } | { phase: 'paused' } | { phase: 'finished' });

type TaskDeviceRunDeps = {
  readSwitchOn: (deviceId: string) => ConfirmedTaskSwitchOn | undefined;
  hasStartedDrawing: (deviceId: string, dispatchedAtMs: number, nowMs: number) => boolean;
  hasSwitchedOffSince: (deviceId: string, confirmedAtMs: number) => boolean;
  isSimulation: () => boolean;
};

type EnergyDiagnostic = Extract<DeferredObjectiveDiagnostic, { objectiveKind: 'energy' }>;

/** Publishes evidence about an appliance's run on the existing smart-task lifecycle clock. */
export class TaskDeviceRunTracker {
  private readonly runs = new Map<InProgressKey, Run>();
  private readonly listeners = new Set<RunListener>();

  constructor(private readonly deps: TaskDeviceRunDeps) {}

  public subscribe = (listener: RunListener): void => {
    this.listeners.add(listener);
  };

  public observe(
    key: InProgressKey,
    diagnostic: DeferredObjectiveDiagnostic,
    facts: TaskDeliveryFacts,
    nonDelivery: TaskDeliveryEvidence['nonDelivery'],
    nowMs: number,
  ): void {
    if (diagnostic.objectiveKind !== 'energy') {
      this.runs.delete(key);
      return;
    }
    const { targetEnergyKWh } = diagnostic;
    const prior = this.runs.get(key);
    const run = prior?.targetEnergyKWh === targetEnergyKWh ? prior : undefined;
    if (prior && !run) this.runs.delete(key);
    if (run?.phase === 'finished') return;

    const next = this.advanceRun(run, diagnostic, facts, nonDelivery, nowMs);
    if (!next || next === run) return;
    this.runs.set(key, next);
    if (!run) this.publish('started', diagnostic);
    if (next.phase === 'finished') this.publish('finished', diagnostic);
  }

  private readPermittedSwitchOn(
    diagnostic: EnergyDiagnostic, facts: TaskDeliveryFacts,
  ): ConfirmedTaskSwitchOn | undefined {
    if (this.deps.isSimulation() || facts.obligation !== 'claimed' || facts.control.kind !== 'permitted') {
      return undefined;
    }
    const activation = this.deps.readSwitchOn(diagnostic.deviceId);
    if (!activation || activation.task.deadlineAtMs !== diagnostic.evaluation.deadlineAtMs
      || activation.task.targetEnergyKWh !== diagnostic.targetEnergyKWh) return undefined;
    return this.deps.hasSwitchedOffSince(diagnostic.deviceId, activation.confirmedAtMs) ? undefined : activation;
  }

  private advanceRun(
    previous: Run | undefined, diagnostic: EnergyDiagnostic, facts: TaskDeliveryFacts,
    nonDelivery: TaskDeliveryEvidence['nonDelivery'], nowMs: number,
  ): Run | undefined {
    const { deviceId, targetEnergyKWh } = diagnostic;
    const activation = this.readPermittedSwitchOn(diagnostic, facts);
    if (!activation) return previous?.phase === 'working' ? { targetEnergyKWh, phase: 'paused' } : previous;
    if (previous?.phase === 'working' && previous.dispatchedAtMs === activation.dispatchedAtMs) {
      return nonDelivery.kind === 'confirmed' ? { targetEnergyKWh, phase: 'finished' } : previous;
    }
    if (facts.observation.kind === 'drawing'
      && this.deps.hasStartedDrawing(deviceId, activation.dispatchedAtMs, nowMs)) {
      return { targetEnergyKWh, phase: 'working', dispatchedAtMs: activation.dispatchedAtMs };
    }
    return previous;
  }

  public retainTasks(seen: ReadonlySet<InProgressKey>): void {
    for (const key of this.runs.keys()) {
      if (!seen.has(key)) this.runs.delete(key);
    }
  }

  private publish(kind: TaskDeviceRunEvent['kind'], diagnostic: EnergyDiagnostic): void {
    const { deviceId, deviceName, targetEnergyKWh, evaluation } = diagnostic;
    if (deviceName === undefined) return;
    const event = {
      kind, deviceId, deviceName, targetEnergyKWh, deadlineAtMs: evaluation.deadlineAtMs,
    };
    for (const listener of this.listeners) listener(event);
  }
}
