import type { InverterObservation } from '../../packages/contracts/src/inverterControl';
import type {
  InverterActuation, InverterClaim, InverterCommand, InverterExecution, InverterPlanInput,
} from '../ports/inverterControl';
import type { InverterDecision } from '../planContract/inverterDecision';
import type { InverterClaimStore } from './inverterClaimStore';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/inverter');
const REQUEST_INTERVAL_MS = 30_000;

type InverterReleaseRequest = { requestedAtMs: number; observation: InverterObservation };

function sameMode(left: InverterObservation['mode'], right: InverterObservation['mode']): boolean {
  if (left.kind === 'direct') return right.kind === 'direct';
  return right.kind !== 'direct' && left.value === right.value;
}

function confirmsRelease(
  request: InverterReleaseRequest, claim: InverterClaim, observed: InverterObservation,
): boolean {
  if (!sameMode(observed.mode, claim.previousMode)) return false;
  if (claim.previousMode.kind === 'autonomous' && observed.mode.kind !== 'direct') {
    return observed.mode.observedAtMs > request.requestedAtMs
      || (observed.mode.observedAtMs === request.requestedAtMs && !sameMode(observed.mode, request.observation.mode));
  }
  return observed.limit.value === claim.previousLimitW && (
    observed.limit.observedAtMs > request.requestedAtMs || (observed.limit.observedAtMs === request.requestedAtMs
      && observed.limit.value !== request.observation.limit.value)
  );
}

export type InverterExecutionSource = {
  observation(deviceId: string): InverterObservation | undefined;
  simulation(): boolean;
  canLimit(deviceId: string): boolean;
  onExternalControl(deviceId: string): void;
};

/** Production-cap convergence. The durable claim outlives both SDK timeouts and restarts. */
export class InverterExecutor implements InverterExecution {
  private loaded = false;
  private readonly claims = new Map<string, InverterClaim>();
  private readonly recovering = new Set<string>();
  private blocked: ReadonlySet<string> = new Set();
  private readonly notBefore = new Map<string, number>();
  private readonly releaseRequests = new Map<string, InverterReleaseRequest>();

  constructor(
    private readonly store: InverterClaimStore,
    private readonly actuator: InverterActuation,
    private readonly source: InverterExecutionSource,
  ) {}

  ready(deviceId: string): boolean {
    if (!this.loaded || this.blocked.has(deviceId)) {
      const read = this.store.readAll();
      if (read === null) return false;
      for (const [id, claim] of read.records) {
        if (this.claims.has(id)) continue;
        this.claims.set(id, claim);
        this.recovering.add(id);
      }
      this.blocked = read.blocked;
      this.loaded = true;
    }
    return !this.blocked.has(deviceId);
  }

  ownership(deviceId: string): InverterPlanInput['ownership'] {
    const claim = this.claims.get(deviceId);
    return claim ? { kind: 'held', claim, recovering: this.recovering.has(deviceId) } : { kind: 'free' };
  }

  notBeforeMs(deviceId: string): number { return this.notBefore.get(deviceId) ?? 0; }

  hasWork(decisions: readonly InverterDecision[]): boolean {
    return decisions.some((decision) => {
      if (decision.kind === 'release') return this.claims.has(decision.deviceId);
      const observed = this.source.observation(decision.deviceId);
      return observed !== undefined && (Math.abs(observed.limit.value - decision.limitW) >= 1
        || observed.mode.kind === 'autonomous');
    });
  }

  async apply(decisions: readonly InverterDecision[]): Promise<{ commandRequestCount: number; failureCount: number }> {
    let commandRequestCount = 0;
    let failureCount = 0;
    for (const decision of decisions) {
      if (Date.now() < this.notBeforeMs(decision.deviceId)
        && (decision.kind === 'limit' || this.releaseRequests.has(decision.deviceId))) continue;
      try {
        if (await this.applyOne(decision)) commandRequestCount += 1;
      } catch (error) {
        failureCount += 1;
        logger.error({ event: 'inverter_command_failed', deviceId: decision.deviceId, err: error });
      }
    }
    return { commandRequestCount, failureCount };
  }

  private async applyOne(decision: InverterDecision): Promise<boolean> {
    const { deviceId } = decision;
    const observed = this.source.observation(deviceId);
    if (observed === undefined) return false;
    const claim = this.claims.get(deviceId);
    // A later explicit mode change belongs to the owner. Never overwrite it.
    if (claim && observed.mode.kind === 'autonomous'
      && observed.mode.observedAtMs > claim.claimedAtMs
      && (!this.recovering.has(deviceId) || !sameMode(observed.mode, claim.previousMode))
      && !(this.releaseRequests.has(deviceId) && sameMode(observed.mode, claim.previousMode))) {
      this.source.onExternalControl(deviceId);
      this.forgetClaim(deviceId);
      return false;
    }
    const command = this.prepareCommand(decision, observed);
    if (command === null) return false;
    this.notBefore.set(deviceId, Date.now() + REQUEST_INTERVAL_MS);
    const outcome = await this.actuator.apply(command);
    if (!outcome.requested) {
      if (!claim && decision.kind === 'limit') this.forgetClaim(deviceId);
      return false;
    }
    // Keep the durable record until a later report confirms the hand-back.
    logger.info({ event: 'inverter_command_requested', deviceId, decision: decision.kind,
      ...(decision.kind === 'limit' ? { limitW: decision.limitW } : {}) });
    return true;
  }

  private forgetClaim(deviceId: string): void {
    this.store.remove(deviceId);
    this.claims.delete(deviceId);
    this.recovering.delete(deviceId);
    this.releaseRequests.delete(deviceId);
    this.notBefore.delete(deviceId);
  }

  private prepareCommand(decision: InverterDecision, observed: InverterObservation): InverterCommand | null {
    const { deviceId } = decision;
    const claim = this.claims.get(deviceId);
    if (decision.kind === 'limit') {
      if (JSON.stringify(observed) !== JSON.stringify(decision.observation)
        || this.source.simulation() || !this.source.canLimit(deviceId)) return null;
      if (Math.abs(observed.limit.value - decision.limitW) < 1 && observed.mode.kind !== 'autonomous') return null;
      if (!claim) {
        const admitted = {
          previousLimitW: observed.limit.value,
          previousMode: { ...observed.mode },
          claimedAtMs: Date.now(),
        };
        this.store.save(deviceId, admitted);
        this.claims.set(deviceId, admitted);
      }
      this.releaseRequests.delete(deviceId);
      return { kind: 'production_limit', deviceId, limitW: decision.limitW };
    }
    if (!claim) return null;
    const request = this.releaseRequests.get(deviceId);
    // Pre-command telemetry may still show the old setting while a limit lands.
    if (request && confirmsRelease(request, claim, observed)) {
      this.forgetClaim(deviceId);
      return null;
    }
    // Retries share one target; delayed telemetry from the first request still confirms it.
    if (!request) this.releaseRequests.set(deviceId, { requestedAtMs: Date.now(), observation: observed });
    return { kind: 'production_release', deviceId, claim };
  }
}
