import type { PendingTargetCommandState } from '../plan/planState';
import type { DesiredBinaryKind } from './executableDesiredState';
import { getPendingTargetCommandDecision } from './targetCommandRetry';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { getLogger } from '../logging/logger';
import type {
  DeviceControlAdapterSnapshot,
  DeviceDescriptor,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import { applyDeferredBinaryCommand } from './binaryExecutor';
import { applyShedReleaseStepFallback, applyShedReleaseTemperature } from './shedReleaseActuation';
import { buildExecutableObservedDeviceState } from './executablePlanProjection';
import type { ExecutorCommandContext } from './executorCommandContext';
import type { BinaryCommandClaimState } from './binaryCommandClaim';
import type { SteppedCommandClaimState } from './steppedCommandClaim';
import type { TargetCommandClaimState } from './targetCommandClaim';
import {
  hasReleasedOpposingCommand,
  type ReleasedOpposingCommand,
} from './lifecycleFallbackClaimRelease';

const logger = getLogger('executor/lifecycle-fallback');

export type LifecycleFallbackRequest = {
  kind: 'binary_off';
  observed: ExecutableObservedDeviceState;
} | {
  kind: 'target_fallback';
  observed: ExecutableObservedDeviceState;
  desired: number;
} | {
  kind: 'step_fallback';
  observed: ExecutableObservedDeviceState;
  targetStepId: string;
  // The step fallback always drives the binary axis to its configured posture,
  // so this carries the binary cluster rather than leaving it to be inferred.
  steppedLoad: ExecutableSteppedLoadIntent & DesiredBinaryKind;
};

export type LifecycleFallbackResult = { settled: boolean };

export type LifecycleFallbackPort = Pick<LifecycleFallbackDispatcher, 'abandon' | 'converge'>;

export type LifecycleFallbackDevice = Pick<
DeviceDescriptor,
'id' | 'name' | 'isEvCharger'
> & Pick<
SteppedLoadDecoration,
  'selectedStepId' | 'stepCommandPending' | 'stepCommandRetryCount'
| 'nextStepCommandRetryAtMs' | 'desiredStepId' | 'previousStepId' | 'stepCommandStatus'
> & {
  controlAdapter?: DeviceControlAdapterSnapshot;
  /** Producer-resolved write authority and complete descriptor for each axis. */
  binaryAxis:
    | { state: 'writable' }
    | { state: 'unavailable' };
  targetAxis:
    | { state: 'writable' }
    | { state: 'unavailable' };
  stepAxis:
    | { state: 'writable'; profile: SteppedLoadProfile }
    | { state: 'unavailable' };
};

export type LifecycleFallbackObservedState = ObservedDeviceState
& ReportedStepObservedProbe
& MeasuredPowerObservedProbe;

const createLifecycleTargetState = (): {
  pendingTargetCommands: Record<string, PendingTargetCommandState>;
  setPendingTargetCommand: (deviceId: string, pending: PendingTargetCommandState) => void;
  deletePendingTargetCommand: (deviceId: string) => void;
} => {
  const pendingTargetCommands: Record<string, PendingTargetCommandState> = {};
  return {
    pendingTargetCommands,
    setPendingTargetCommand: (deviceId, pending) => {
      // eslint-disable-next-line functional/immutable-data -- Private executor retry store owns this entry.
      pendingTargetCommands[deviceId] = { ...pending };
    },
    deletePendingTargetCommand: (deviceId) => {
      // eslint-disable-next-line functional/immutable-data -- Private executor retry store owns this entry.
      delete pendingTargetCommands[deviceId];
    },
  };
};

/**
 * Executor-owned convergence lane for a smart task's fallback posture. It
 * dispatches through the ordinary binary/target/stepped executors, so pending
 * windows, retry backoff, diagnostics, and activation-attempt cleanup stay
 * identical to plan-carried lifecycle releases.
 */
export class LifecycleFallbackDispatcher {
  // Target fallback retries must survive ordinary plan rebuilding/pruning. This
  // state is executor/lifecycle-owned and is never handed to plan maintenance.
  private readonly targetState = createLifecycleTargetState();
  private readonly authorityTokens = new Map<string, object>();
  private readonly currentRequests = new Map<string, LifecycleFallbackRequest>();
  /** Accepted opposing writes whose telemetry may still show the old fallback posture. */
  private readonly releasedOpposingCommands = new Map<string, ReleasedOpposingCommand>();

  /** `ctx` is the ordinary lane's; this lane spreads it as its own (`lifecycleContext`). */
  public constructor(private readonly ctx: ExecutorCommandContext) {}

  public getOwnedTargetPending(deviceId: string): PendingTargetCommandState | undefined {
    return this.targetState.pendingTargetCommands[deviceId];
  }

  public isActive(deviceId: string): boolean {
    return this.authorityTokens.has(deviceId);
  }

  public abandon(deviceId: string): void {
    this.authorityTokens.delete(deviceId);
    this.currentRequests.delete(deviceId);
    this.releasedOpposingCommands.delete(deviceId);
    this.targetState.deletePendingTargetCommand(deviceId);
  }

  public converge(request: LifecycleFallbackRequest): LifecycleFallbackResult {
    if (this.fenceCapacityDryRun(request.observed.id)) return { settled: false };
    return this.convergeWithAuthority(request);
  }

  private convergeWithAuthority(request: LifecycleFallbackRequest): LifecycleFallbackResult {
    const { observed } = request;
    const authorityToken = this.authorityTokens.get(observed.id) ?? {};
    this.authorityTokens.set(observed.id, authorityToken);
    this.currentRequests.set(observed.id, request);
    this.clearSettledTargetPending(observed.id, observed);
    if (this.waitForOpposingClaim(request, authorityToken)) return { settled: false };
    const releasedOpposing = this.releasedOpposingCommands.get(observed.id);
    switch (request.kind) {
      case 'binary_off':
        if (
          observed.observedBinaryAxis === 'off'
          && !hasReleasedOpposingCommand(releasedOpposing, request.kind)
        ) {
          return { settled: true };
        }
        this.dispatchBinaryOff(
          observed, authorityToken, hasReleasedOpposingCommand(releasedOpposing, request.kind),
        );
        return { settled: false };
      case 'target_fallback':
        return this.convergeTargetFallback(request, authorityToken, releasedOpposing);
      case 'step_fallback': {
        const currentId = observed.steppedLoad?.reportedStepId;
        const current = currentId ? getSteppedLoadStep(request.steppedLoad.steppedLoadProfile, currentId) : null;
        const target = getSteppedLoadStep(request.steppedLoad.steppedLoadProfile, request.targetStepId);
        if (
          target && current && current.planningPowerW <= target.planningPowerW
          && !hasReleasedOpposingCommand(releasedOpposing, request.kind)
        ) return { settled: true };
        this.dispatchStepFallback(
          observed,
          request.targetStepId,
          request.steppedLoad,
          authorityToken,
          hasReleasedOpposingCommand(releasedOpposing, request.kind),
        );
        return { settled: false };
      }
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  private convergeTargetFallback(
    request: Extract<LifecycleFallbackRequest, { kind: 'target_fallback' }>,
    authorityToken: object,
    releasedOpposing: ReleasedOpposingCommand | undefined,
  ): LifecycleFallbackResult {
    const { observed, desired } = request;
    this.retireOpposingOrdinaryTargetPending(observed, desired);
    if (
      Object.is(observed.target?.observedValue, desired)
      && !hasReleasedOpposingCommand(releasedOpposing, request.kind)
    ) return { settled: true };
    // A present target capability can still be transiently unreadable. Lifecycle
    // fallback needs trusted numeric evidence before deciding a write is needed.
    if (typeof observed.target?.observedValue !== 'number') return { settled: false };
    this.dispatchTargetFallback(
      observed, desired, authorityToken, hasReleasedOpposingCommand(releasedOpposing, request.kind),
    );
    return { settled: false };
  }

  private retireOpposingOrdinaryTargetPending(
    observed: ExecutableObservedDeviceState,
    desired: number,
  ): void {
    if (!observed.target) return;
    const ordinaryTargetCommands = this.ctx.targetCommands;
    const pending = ordinaryTargetCommands.pendingTargetCommands[observed.id];
    if (!pending) return;
    if (Object.is(pending.desired, desired)) return;
    ordinaryTargetCommands.deletePendingTargetCommand(observed.id);
  }

  private waitForOpposingClaim(
    request: LifecycleFallbackRequest,
    authorityToken: object,
  ): boolean {
    switch (request.kind) {
      case 'binary_off':
        return this.waitForOpposingBinaryClaim(request.observed, authorityToken);
      case 'target_fallback':
        return this.waitForOpposingTargetClaim(request.observed, request.desired, authorityToken);
      case 'step_fallback':
        return this.waitForOpposingStepClaim(request.observed, request.targetStepId, authorityToken);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  private waitForOpposingBinaryClaim(
    observed: ExecutableObservedDeviceState,
    authorityToken: object,
  ): boolean {
    const claim = this.ctx.binaryCommandClaim;
    if (claim.ownerOf(observed.id) !== 'ordinary') return false;
    claim.acquire(
      observed.id,
      'lifecycle',
      false,
      (released) => this.retryAfterBinaryClaimRelease(observed.id, authorityToken, released),
    );
    return true;
  }

  private waitForOpposingTargetClaim(
    observed: ExecutableObservedDeviceState,
    desired: number,
    authorityToken: object,
  ): boolean {
    if (!observed.target) return false;
    if (this.ctx.targetCommandClaim.ownerOf(observed.id) !== 'ordinary') return false;
    this.ctx.targetCommandClaim.acquire(
      observed.id,
      'lifecycle',
      desired,
      (released) => this.retryAfterTargetClaimRelease(observed.id, authorityToken, released),
    );
    return true;
  }

  private waitForOpposingStepClaim(
    observed: ExecutableObservedDeviceState,
    desiredStepId: string,
    authorityToken: object,
  ): boolean {
    const claim = this.ctx.steppedCommandClaim;
    if (claim.ownerOf(observed.id) !== 'ordinary') return false;
    claim.acquire(
      observed.id,
      'lifecycle',
      desiredStepId,
      (released) => this.retryAfterStepClaimRelease(observed.id, authorityToken, released),
    );
    return true;
  }

  /**
   * This lane's command context: the ordinary one with this lane as owner, its
   * own target retry store, and authority tied to the token that dispatched.
   */
  private lifecycleContext(deviceId: string, authorityToken: object): ExecutorCommandContext {
    return {
      ...this.ctx,
      owner: 'lifecycle',
      targetCommands: this.targetState,
      isAuthorityCurrent: () => this.authorityTokens.get(deviceId) === authorityToken,
      onBinaryCommandClaimReleased: (released) => (
        this.retryAfterBinaryClaimRelease(deviceId, authorityToken, released)
      ),
      onSteppedCommandClaimReleased: (released) => (
        this.retryAfterStepClaimRelease(deviceId, authorityToken, released)
      ),
      onTargetCommandClaimReleased: (released) => (
        this.retryAfterTargetClaimRelease(deviceId, authorityToken, released)
      ),
    };
  }

  private dispatchBinaryOff(
    observed: ExecutableObservedDeviceState,
    authorityToken: object,
    forceAgainstReleasedOpposing: boolean,
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'binary_release', deviceId: observed.id, name: observed.name,
    };
    void this.dispatch(observed, authorityToken, () => applyDeferredBinaryCommand(
      this.lifecycleContext(observed.id, authorityToken),
      intent,
      observed,
      { preferObservedSnapshot: true, forceAgainstReleasedOpposing },
    ));
  }

  private dispatchTargetFallback(
    observed: ExecutableObservedDeviceState,
    desired: number,
    authorityToken: object,
    forceAgainstReleasedOpposing: boolean,
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'shed_release', deviceId: observed.id, name: observed.name, releaseShedStepId: null,
    };
    void this.dispatch(observed, authorityToken, async () => {
      const deviceId = observed.id;
      const ordinaryPendingDecision = getPendingTargetCommandDecision(
        this.ctx.targetCommands, deviceId, desired, Date.now(),
      );
      if (ordinaryPendingDecision.type !== 'send') {
        this.targetState.setPendingTargetCommand(deviceId, ordinaryPendingDecision.pending);
        this.ctx.targetCommands.deletePendingTargetCommand(deviceId);
        if (ordinaryPendingDecision.type === 'skip') return false;
      }
      return applyShedReleaseTemperature(
        this.lifecycleContext(deviceId, authorityToken), intent, desired, observed, forceAgainstReleasedOpposing,
      );
    });
  }

  private dispatchStepFallback(
    observed: ExecutableObservedDeviceState,
    targetStepId: string,
    steppedLoad: ExecutableSteppedLoadIntent,
    authorityToken: object,
    forceAgainstReleasedOpposing: boolean,
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'shed_release', deviceId: observed.id, name: observed.name, releaseShedStepId: targetStepId,
    };
    void this.dispatch(observed, authorityToken, () => applyShedReleaseStepFallback(
      this.lifecycleContext(observed.id, authorityToken), intent, steppedLoad, observed, forceAgainstReleasedOpposing,
    ));
  }

  private async dispatch(
    observed: ExecutableObservedDeviceState,
    authorityToken: object,
    run: () => Promise<boolean>,
  ): Promise<void> {
    try {
      const applied = await run();
      if (applied === true && this.authorityTokens.get(observed.id) === authorityToken) {
        this.releasedOpposingCommands.delete(observed.id);
      }
    } catch (error: unknown) {
      logger.warn({
        event: 'lifecycle_fallback_failed',
        deviceId: observed.id,
        error: String(error),
      });
    } finally {
      // Authority may have ended while the actuator promise was in flight. Do
      // not let its late completion reinstall lifecycle-owned suppression.
      if (this.authorityTokens.get(observed.id) !== authorityToken) {
        this.targetState.deletePendingTargetCommand(observed.id);
      }
    }
  }

  private clearSettledTargetPending(deviceId: string, observed: ExecutableObservedDeviceState): void {
    const pending = this.targetState.pendingTargetCommands[deviceId];
    if (pending && observed.target && Object.is(observed.target.observedValue, pending.desired)) {
      this.targetState.deletePendingTargetCommand(deviceId);
    }
  }

  private retryCurrent(deviceId: string, authorityToken: object): void {
    if (this.authorityTokens.get(deviceId) !== authorityToken) return;
    const current = this.currentRequests.get(deviceId);
    if (!current) return;
    // Re-project observer truth before the retry, judged by the same ladder as
    // the request's first build: the step posture's, or none.
    const device = this.ctx.readDevice(deviceId);
    const ladder = current.kind === 'step_fallback' ? current.steppedLoad.steppedLoadProfile : undefined;
    const observed = device ? buildExecutableObservedDeviceState(device, ladder) : current.observed;
    this.converge({ ...current, observed });
  }

  private retryAfterBinaryClaimRelease(
    deviceId: string,
    authorityToken: object,
    released: BinaryCommandClaimState,
  ): void {
    if (this.authorityTokens.get(deviceId) !== authorityToken) return;
    if (released.owner === 'ordinary' && released.accepted && released.desired) {
      this.releasedOpposingCommands.set(deviceId, { kind: 'binary_off', desired: released.desired });
    }
    this.retryCurrent(deviceId, authorityToken);
  }

  private retryAfterTargetClaimRelease(
    deviceId: string,
    authorityToken: object,
    released: TargetCommandClaimState,
  ): void {
    if (this.authorityTokens.get(deviceId) !== authorityToken) return;
    const current = this.currentRequests.get(deviceId);
    if (
      released.owner === 'ordinary'
      && released.accepted
      && current?.kind === 'target_fallback'
      && !Object.is(released.desired, current.desired)
    ) {
      this.releasedOpposingCommands.set(deviceId, {
        kind: 'target_fallback',
        desired: released.desired,
      });
    }
    this.retryCurrent(deviceId, authorityToken);
  }

  private retryAfterStepClaimRelease(
    deviceId: string,
    authorityToken: object,
    released: SteppedCommandClaimState,
  ): void {
    if (this.authorityTokens.get(deviceId) !== authorityToken) return;
    const current = this.currentRequests.get(deviceId);
    if (
      released.owner === 'ordinary'
      && released.accepted
      && current?.kind === 'step_fallback'
      && released.desiredStepId !== current.targetStepId
    ) {
      this.releasedOpposingCommands.set(deviceId, {
        kind: 'step_fallback',
        desiredStepId: released.desiredStepId,
      });
    }
    this.retryCurrent(deviceId, authorityToken);
  }

  private fenceCapacityDryRun(deviceId: string): boolean {
    if (!this.ctx.getCapacityDryRun()) return false;
    this.abandon(deviceId);
    return true;
  }
}
