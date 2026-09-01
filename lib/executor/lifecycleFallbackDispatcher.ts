import type { PendingTargetCommandState } from '../plan/planState';
import type { ShedBehavior } from '../plan/planTypes';
import type { DesiredBinaryKind } from './executableDesiredState';
import { getPendingTargetCommandDecision } from './targetCommandRetry';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
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
import { applyShedReleaseIntent, type ShedReleaseActuationDeps } from './shedReleaseActuation';
import type { TargetCommandClaim } from './targetCommandClaim';
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

type LifecycleFallbackDeps = Omit<ShedReleaseActuationDeps, 'getShedBehavior'> & {
  targetCommandClaim: TargetCommandClaim;
  capacityDryRun: () => boolean;
  /** Re-projects observer truth before a claim-release retry. */
  refreshObserved?: (deviceId: string) => ExecutableObservedDeviceState | undefined;
};

export type LifecycleFallbackPort = Pick<LifecycleFallbackDispatcher, 'abandon' | 'converge'>;

export type LifecycleFallbackDevice = Pick<
DeviceDescriptor,
'id' | 'name'
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
    | { state: 'writable'; target: 'temperature' }
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

  public constructor(private readonly deps: LifecycleFallbackDeps) {}

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
        this.dispatchBinaryOff(observed, authorityToken, {
          forceAgainstReleasedOpposing: hasReleasedOpposingCommand(releasedOpposing, request.kind),
        });
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
        this.dispatchStepFallback(observed, request.targetStepId, request.steppedLoad, authorityToken, {
          forceAgainstReleasedOpposing: hasReleasedOpposingCommand(releasedOpposing, request.kind),
        });
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
    this.dispatchTargetFallback(observed, desired, authorityToken, {
      forceAgainstReleasedOpposing: hasReleasedOpposingCommand(releasedOpposing, request.kind),
    });
    return { settled: false };
  }

  private retireOpposingOrdinaryTargetPending(
    observed: ExecutableObservedDeviceState,
    desired: number,
  ): void {
    if (!observed.target) return;
    const state = this.deps.buildTargetExecutorContext().state;
    const pending = state.pendingTargetCommands[observed.id];
    if (!pending) return;
    if (pending.target === 'temperature' && Object.is(pending.desired, desired)) return;
    state.deletePendingTargetCommand(observed.id);
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
    const claim = this.deps.buildBinaryExecutorContext().binaryCommandClaim;
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
    if (this.deps.targetCommandClaim.ownerOf(observed.id, 'temperature') !== 'ordinary') return false;
    this.deps.targetCommandClaim.acquire(
      observed.id,
      'temperature',
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
    const claim = this.deps.buildSteppedExecutorContext().steppedCommandClaim;
    if (claim.ownerOf(observed.id) !== 'ordinary') return false;
    claim.acquire(
      observed.id,
      'lifecycle',
      desiredStepId,
      (released) => this.retryAfterStepClaimRelease(observed.id, authorityToken, released),
    );
    return true;
  }

  private dispatchBinaryOff(
    observed: ExecutableObservedDeviceState,
    authorityToken: object,
    options: { forceAgainstReleasedOpposing: boolean },
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'binary_release', deviceId: observed.id, name: observed.name,
    };
    void this.dispatch({
      observed,
      authorityToken,
      run: async () => {
        const binaryContext = this.deps.buildBinaryExecutorContext();
        return applyDeferredBinaryCommand({
          ...binaryContext,
          binaryCommandOwner: 'lifecycle',
          isLifecycleFallbackActive: () => true,
          isBinaryCommandAuthorityCurrent: () => (
            this.authorityTokens.get(observed.id) === authorityToken
          ),
          onBinaryCommandClaimReleased: (released) => (
            this.retryAfterBinaryClaimRelease(observed.id, authorityToken, released)
          ),
        }, intent, observed, {
          preferObservedSnapshot: true,
          forceAgainstReleasedOpposing: options.forceAgainstReleasedOpposing,
        });
      },
    });
  }

  private dispatchTargetFallback(
    observed: ExecutableObservedDeviceState,
    desired: number,
    authorityToken: object,
    options: { forceAgainstReleasedOpposing: boolean },
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'shed_release', deviceId: observed.id, name: observed.name, releaseShedStepId: null,
    };
    this.dispatchRelease({
      observed,
      authorityToken,
      intent,
      steppedLoad: null,
      behavior: { action: 'set_temperature', temperature: desired },
      forceAgainstReleasedOpposing: options.forceAgainstReleasedOpposing,
    });
  }

  private dispatchStepFallback(
    observed: ExecutableObservedDeviceState,
    targetStepId: string,
    steppedLoad: ExecutableSteppedLoadIntent,
    authorityToken: object,
    options: { forceAgainstReleasedOpposing: boolean },
  ): void {
    const intent: ExecutableReleaseIntent = {
      kind: 'shed_release', deviceId: observed.id, name: observed.name, releaseShedStepId: targetStepId,
    };
    this.dispatchRelease({
      observed,
      authorityToken,
      intent,
      steppedLoad,
      behavior: { action: 'set_step' },
      forceAgainstReleasedOpposing: options.forceAgainstReleasedOpposing,
    });
  }

  private dispatchRelease(params: {
    observed: ExecutableObservedDeviceState;
    authorityToken: object;
    intent: ExecutableReleaseIntent;
    steppedLoad: ExecutableSteppedLoadIntent | null;
    behavior: Exclude<ShedBehavior, { action: 'turn_off' }>;
    forceAgainstReleasedOpposing: boolean;
  }): void {
    const { observed, authorityToken } = params;
    void this.dispatch({
      observed,
      authorityToken,
      run: async () => this.applyRelease(params),
    });
  }

  private async applyRelease(params: {
    observed: ExecutableObservedDeviceState;
    authorityToken: object;
    intent: ExecutableReleaseIntent;
    steppedLoad: ExecutableSteppedLoadIntent | null;
    behavior: Exclude<ShedBehavior, { action: 'turn_off' }>;
    forceAgainstReleasedOpposing: boolean;
  }): Promise<boolean> {
    const {
      observed, authorityToken, intent, steppedLoad, behavior, forceAgainstReleasedOpposing,
    } = params;
    const deviceId = observed.id;
    const targetContext = this.deps.buildTargetExecutorContext();
    const ordinaryPendingDecision = (
      behavior.action === 'set_temperature'
      && observed.target
    ) ? getPendingTargetCommandDecision({
        state: targetContext.state,
        deviceId,
        desired: behavior.temperature,
        nowMs: Date.now(),
      }) : null;
    if (ordinaryPendingDecision && ordinaryPendingDecision.type !== 'send') {
      this.targetState.setPendingTargetCommand(deviceId, ordinaryPendingDecision.pending);
      targetContext.state.deletePendingTargetCommand(deviceId);
      if (ordinaryPendingDecision.type === 'skip') return false;
    }
    return applyShedReleaseIntent({
      intent,
      steppedLoadIntent: steppedLoad ?? undefined,
      observed,
      snapshot: observed.snapshot,
      forceAgainstReleasedOpposing,
      deps: {
        ...this.deps,
        getShedBehavior: () => behavior,
        buildTargetExecutorContext: () => ({
          ...targetContext,
          state: this.targetState,
          targetCommandClaim: this.deps.targetCommandClaim,
          targetCommandOwner: 'lifecycle',
          isLifecycleFallbackActive: () => true,
          isTargetCommandAuthorityCurrent: () => (
            this.authorityTokens.get(deviceId) === authorityToken
          ),
          onTargetCommandClaimReleased: (released) => (
            this.retryAfterTargetClaimRelease(deviceId, authorityToken, released)
          ),
          getLifecycleOwnedPendingTargetCommand: () => undefined,
        }),
        buildSteppedExecutorContext: () => ({
          ...this.deps.buildSteppedExecutorContext(),
          steppedCommandOwner: 'lifecycle',
          binaryCommandOwner: 'lifecycle',
          isLifecycleFallbackActive: () => true,
          isSteppedCommandAuthorityCurrent: () => (
            this.authorityTokens.get(deviceId) === authorityToken
          ),
          isBinaryCommandAuthorityCurrent: () => (
            this.authorityTokens.get(deviceId) === authorityToken
          ),
          onSteppedCommandClaimReleased: (released) => (
            this.retryAfterStepClaimRelease(deviceId, authorityToken, released)
          ),
          onBinaryCommandClaimReleased: (released) => (
            this.retryAfterBinaryClaimRelease(deviceId, authorityToken, released)
          ),
        }),
      },
    });
  }

  private async dispatch(params: {
    observed: ExecutableObservedDeviceState;
    authorityToken: object;
    run: () => Promise<boolean | void>;
  }): Promise<void> {
    const { observed, authorityToken, run } = params;
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
    const observed = this.deps.refreshObserved?.(deviceId) ?? current.observed;
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
    if (!this.deps.capacityDryRun()) return false;
    this.abandon(deviceId);
    return true;
  }
}
