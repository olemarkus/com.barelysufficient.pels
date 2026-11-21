import type { NativeRelayBinding, RelayMeterObservation } from '../ports/nativeRelay';
import type { LatchedMeterReading } from '../power/lastTotalPower';
import type { PlannedBinaryCommand, ExecutionPlan } from '../planContract/executionPlan';
import { hasBinaryCommand, hasReleaseCommand } from './executablePlan';
import { RelayShedEpisode, type RelayShedOutcome, type RelayShedStatus } from './relayShedEpisode';

type RelayShedDeps = {
  /** null for a resolved loss of control, undefined while the native handle is unavailable. */
  binding: (id: string) => NativeRelayBinding | null | undefined;
  observation: (id: string) => RelayMeterObservation | undefined;
  pending: (id: string) => boolean;
  revision: () => number;
  noteNoAck: () => void;
  household: () => LatchedMeterReading | undefined;
  overlappingSheds: (id: string, sinceMs: number) => boolean;
};

export type RelayShedAttempt = {
  sameValue: boolean;
  finish: (outcome: RelayShedOutcome, binding?: string, unflaggedRelay?: boolean) => void;
};

export class RelayShedRecovery {
  private readonly episodes = new Map<string, RelayShedEpisode>();
  private authorized = new Map<string, PlannedBinaryCommand>();
  private revisionAtBuild?: number;

  constructor(private readonly deps: RelayShedDeps) {}

  retain(plan: ExecutionPlan, revision?: number): void {
    this.revisionAtBuild = revision;
    this.authorized = new Map();
    const absent = new Set(this.episodes.keys());
    for (const { commands, nonCapacityHoldShed } of plan.devices) {
      absent.delete(commands.id);
      if (!commands.commandAuthority || hasReleaseCommand(commands)
        || (hasBinaryCommand(commands) && commands.binary.desiredOn)) {
        this.close(commands.id, 'released');
      } else if (hasBinaryCommand(commands) && !nonCapacityHoldShed && commands.binary.source === 'controlled') {
        this.authorized.set(commands.id, commands.binary);
      }
    }
    // The execution plan includes every planned member of this home, including omitted candidates.
    for (const id of absent) this.close(id, 'left_home_plan');
    for (const id of this.episodes.keys()) this.observe(id);
  }

  private close(id: string, reason: string): void {
    this.episodes.get(id)?.closed(reason);
    this.episodes.delete(id);
  }

  private episode(id: string, requireBinding = false): RelayShedEpisode | undefined {
    const episode = this.episodes.get(id);
    if (!episode) return undefined;
    const binding = this.deps.binding(id);
    if (binding === null || (binding && binding.binding !== episode.binding)) {
      this.close(id, 'binding_or_authority_changed');
      return undefined;
    }
    return requireBinding && !binding ? undefined : episode;
  }

  getNoAck(id: string): RelayShedEpisode['noAck'] {
    return this.episode(id)?.noAck;
  }

  status(id: string): RelayShedStatus | undefined {
    return this.episode(id, true)?.status(this.deps.observation(id));
  }

  observe(id: string): void {
    this.episode(id, true)?.observe(this.deps.observation(id));
  }

  private current(intent: PlannedBinaryCommand): boolean {
    return this.authorized.get(intent.deviceId) === intent && this.revisionAtBuild === this.deps.revision();
  }

  /** Used at convergence, the early shed check and the matched-value preflight. */
  allowsRepeat(intent: PlannedBinaryCommand): boolean {
    const { deviceId, relayRecoveryMeterAtMs } = intent;
    if (!this.current(intent) || relayRecoveryMeterAtMs === undefined) return false;
    if (this.deps.pending(deviceId)) return false;
    return this.episode(deviceId, true)?.repeatReady(this.deps.observation(deviceId), relayRecoveryMeterAtMs) === true;
  }

  allowsOrdinary(intent: PlannedBinaryCommand): boolean {
    if (intent.relayNoAckPosture) return false;
    // A one-time meter-outage shed and a non-capacity hold carry no retry decision.
    if (intent.shedDecisionAtMs === undefined) return true;
    const failed = this.getNoAck(intent.deviceId);
    return !failed || (this.current(intent) && intent.shedDecisionAtMs >= failed.retryAtMs);
  }

  /** Called synchronously after preflight under the binary command claim, before the actuator. */
  begin(intent: PlannedBinaryCommand): RelayShedAttempt | undefined {
    const id = intent.deviceId;
    if (this.authorized.get(id) !== intent) return undefined;
    const binding = this.deps.binding(id);
    if (!binding) return undefined;
    const observed = this.deps.observation(id);
    const sameValue = this.allowsRepeat(intent);
    if (!sameValue && (observed?.on === false || intent.shedDecisionAtMs === undefined)) return undefined;
    const episode = this.episode(id) ?? new RelayShedEpisode(id, binding, observed, this.deps);
    this.episodes.set(id, episode);
    episode.dispatched(sameValue, observed);
    return { sameValue, finish: (outcome, actualBinding, unflaggedRelay) => {
      if (this.episode(id) !== episode) return;
      if (!episode.finish(outcome, actualBinding, intent.shedDecisionAtMs, unflaggedRelay)) {
        this.episodes.delete(id);
        return;
      }
      if (outcome === 'no_ack' && episode.noAck) this.deps.noteNoAck();
      this.observe(id);
    } };
  }
}
