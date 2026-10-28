import type { InverterControlSurface, InverterObservation } from '../../packages/contracts/src/inverterControl';
import type {
  InverterActuation, InverterClaim, InverterCommand, InverterExecution,
  InverterControllableInput, InverterReleaseTarget,
} from '../ports/inverterControl';
import { inverterBindingsMatch, inverterLimitDeadbandW, inverterLimitToleranceW,
  type InverterDecision } from '../planContract/inverterDecision';
import type { InverterClaimStore } from './inverterClaimStore';
import { resolveInverterReleaseTarget } from './inverterRestoration';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/inverter');
const REQUEST_INTERVAL_MS = 30_000;
type InverterReleaseRequest = { requestedAtMs: number; target: InverterReleaseTarget };

function sameMode(left: InverterObservation['mode'], right: InverterObservation['mode']): boolean {
  if (left.kind === 'direct') return right.kind === 'direct';
  return right.kind !== 'direct' && left.value === right.value;
}

function sameControlReports(left: InverterObservation, right: InverterObservation): boolean {
  return left.limit.value === right.limit.value && sameMode(left.mode, right.mode);
}

export type InverterExecutionSource = {
  exists(deviceId: string): boolean;
  confirmedRemoved(deviceId: string): boolean;
  observation(deviceId: string): InverterObservation | undefined;
  control(deviceId: string): InverterControlSurface | undefined;
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
  private readonly releaseBaselines = new Map<string, InverterObservation>();

  constructor(
    private readonly store: InverterClaimStore,
    private readonly actuator: InverterActuation,
    private readonly source: InverterExecutionSource,
  ) {}

  private readClaims(): boolean {
    const read = this.store.readAll();
    if (read === null) return false;
    for (const [id, claim] of read.records) {
      if (this.claims.has(id)) continue;
      this.claims.set(id, claim);
      this.recovering.add(id);
    }
    this.blocked = read.blocked;
    this.loaded = true;
    return true;
  }

  ready(deviceId: string): boolean {
    if ((!this.loaded || this.blocked.has(deviceId)) && !this.readClaims()) return false;
    return !this.blocked.has(deviceId);
  }

  heldDeviceIds(): readonly string[] {
    if (!this.loaded || this.blocked.size > 0) this.readClaims();
    return [...this.claims.keys()];
  }

  releaseRecoveryReady(): boolean { return this.loaded && this.blocked.size === 0; }

  ownership(deviceId: string): InverterControllableInput['ownership'] {
    const claim = this.claims.get(deviceId);
    return claim ? { kind: 'held', claim, recovering: this.recovering.has(deviceId) } : { kind: 'free' };
  }

  notBeforeMs(deviceId: string): number { return this.notBefore.get(deviceId) ?? 0; }

  // An absent device keeps its durable claim for a later plan, but cannot
  // keep the meter-outage pass waiting on a hand-back it cannot attempt.
  pendingReleaseCount(decisions: readonly InverterDecision[]): number {
    return decisions.filter((decision) => decision.kind === 'release'
      && this.claims.has(decision.deviceId) && this.source.exists(decision.deviceId)).length;
  }

  hasWork(decisions: readonly InverterDecision[]): boolean {
    return decisions.some((decision) => {
      if (decision.kind === 'release') {
        return this.claims.has(decision.deviceId)
          && (this.source.exists(decision.deviceId) || this.source.confirmedRemoved(decision.deviceId));
      }
      const observed = this.source.observation(decision.deviceId);
      const control = this.source.control(decision.deviceId);
      return observed !== undefined && control !== undefined
        && (Math.abs(observed.limit.value - decision.limitW) >= inverterLimitDeadbandW(control)
          || observed.mode.kind === 'autonomous');
    });
  }

  async apply(decisions: readonly InverterDecision[]): ReturnType<InverterExecution['apply']> {
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
    const pendingInverterReleaseCount = this.pendingReleaseCount(decisions);
    return { commandRequestCount, failureCount, pendingInverterReleaseCount };
  }

  private async applyOne(decision: InverterDecision): Promise<boolean> {
    const { deviceId } = decision;
    if (!this.source.exists(deviceId)) {
      if (decision.kind === 'release') this.forgetRemovedClaim(deviceId);
      return false;
    }
    const observed = this.source.observation(deviceId);
    const claim = this.claims.get(deviceId);
    // A later explicit mode change belongs to the owner. Never overwrite it.
    if (claim && observed && this.ownerTookControl(deviceId, claim, observed)) {
      this.source.onExternalControl(deviceId);
      this.forgetClaim(deviceId);
      return false;
    }
    let command: InverterCommand | null;
    if (decision.kind === 'release') command = this.prepareRelease(deviceId);
    else {
      if (!observed) return false;
      command = this.prepareLimit(decision, observed);
    }
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

  private ownerTookControl(deviceId: string, claim: InverterClaim, observed: InverterObservation): boolean {
    if (observed.mode.kind !== 'autonomous' || observed.mode.observedAtMs <= claim.claimedAtMs) return false;
    const control = this.source.control(deviceId);
    if (control?.authority !== 'limit_and_release') return false;
    if (!inverterBindingsMatch(claim.restoration.binding, control)) return false;
    if (this.recovering.has(deviceId) && sameMode(observed.mode, claim.previousMode)) return false;
    return !(this.releaseRequests.has(deviceId) && sameMode(observed.mode, claim.previousMode));
  }

  private forgetRemovedClaim(deviceId: string): void {
    if (this.claims.has(deviceId) && this.source.confirmedRemoved(deviceId)) this.forgetClaim(deviceId);
  }

  private forgetClaim(deviceId: string): void {
    this.store.remove(deviceId);
    this.claims.delete(deviceId);
    this.recovering.delete(deviceId);
    this.releaseRequests.delete(deviceId);
    this.releaseBaselines.delete(deviceId);
    this.notBefore.delete(deviceId);
  }

  private prepareLimit(
    decision: Extract<InverterDecision, { kind: 'limit' }>, observed: InverterObservation,
  ): InverterCommand | null {
    const { deviceId } = decision;
    const control = this.source.control(deviceId);
    if (!control || control.authority !== 'limit_and_release'
      || !inverterBindingsMatch(control, decision.binding)
      || !sameControlReports(observed, decision.observation)
      || this.source.simulation() || !this.source.canLimit(deviceId)) return null;
    if (Math.abs(observed.limit.value - decision.limitW) < inverterLimitDeadbandW(control)
      && observed.mode.kind !== 'autonomous') return null;
    if (!this.claims.has(deviceId)) {
      const admitted: InverterClaim = {
        previousLimitW: observed.limit.value,
        previousMode: { ...observed.mode },
        claimedAtMs: Date.now(),
        restoration: { kind: 'native', binding: control },
      };
      this.store.save(deviceId, admitted);
      this.claims.set(deviceId, admitted);
    }
    this.releaseRequests.delete(deviceId);
    this.releaseBaselines.delete(deviceId);
    return { kind: 'production_limit', deviceId, limitW: decision.limitW };
  }

  private sameReleaseTarget(left: InverterReleaseTarget, right: InverterReleaseTarget): boolean {
    if (left.limitW !== right.limitW || left.kind !== right.kind) return false;
    return left.kind === 'watts_only' || (right.kind === 'watts_and_mode'
      && inverterBindingsMatch(left.binding, right.binding) && sameMode(left.mode, right.mode));
  }

  private confirmsRelease(deviceId: string, request: InverterReleaseRequest, observed: InverterObservation): boolean {
    const { requestedAtMs, target } = request;
    const baseline = this.releaseBaselines.get(deviceId);
    if (target.kind === 'watts_and_mode') {
      if (!sameMode(observed.mode, target.mode)) return false;
      if (target.mode.kind === 'autonomous' && observed.mode.kind !== 'direct') {
        return observed.mode.observedAtMs > requestedAtMs
          || (observed.mode.observedAtMs === requestedAtMs && baseline !== undefined
            && !sameMode(observed.mode, baseline.mode));
      }
    }
    const control = this.source.control(deviceId);
    const toleranceW = control ? inverterLimitToleranceW(control) : 1;
    return Math.abs(observed.limit.value - target.limitW) <= toleranceW
      && (observed.limit.observedAtMs > requestedAtMs
        || (observed.limit.observedAtMs === requestedAtMs && baseline !== undefined
          && observed.limit.value !== baseline.limit.value));
  }

  private prepareRelease(deviceId: string): InverterCommand | null {
    const claim = this.claims.get(deviceId);
    if (!claim) return null;
    const target = resolveInverterReleaseTarget(claim, this.source.control(deviceId));
    const request = this.releaseRequests.get(deviceId);
    const sameTarget = request !== undefined && this.sameReleaseTarget(request.target, target);
    const observed = this.source.observation(deviceId);
    // Pre-command telemetry may still show the old setting while a cap lands.
    if (sameTarget && observed && this.confirmsRelease(deviceId, request, observed)) {
      this.forgetClaim(deviceId);
      return null;
    }
    // Keep the first request's clock/evidence so delayed reports can confirm retries.
    if (!sameTarget) {
      this.releaseRequests.set(deviceId, { requestedAtMs: Date.now(), target });
      this.releaseBaselines.delete(deviceId);
      if (observed) this.releaseBaselines.set(deviceId, observed);
    }
    return { kind: 'production_release', deviceId, target };
  }
}
