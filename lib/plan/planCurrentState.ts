/**
 * Plan-state-aware `ResolvedCurrentState` projection used by reason rendering.
 * Pure observed-state resolution lives in `lib/observer/observedState.ts`;
 * this module adds the `pendingInfluence` plan/executor concept on top.
 */
import {
  resolveObservedCurrentState,
  resolveObservedCurrentStateValue,
  resolveObservedSteppedLoadCurrentState,
  type CurrentStateInput,
  type ObservedCurrentStateInput,
} from '../observer/observedState';

export type PlannerCurrentStateSource = 'binary' | 'stepped' | 'target' | 'unknown';
export type PlannerPendingInfluence = 'none' | 'present_but_not_applied';

export type ResolvedCurrentState = {
  currentState: string;
  isOn: boolean | null;
  source: PlannerCurrentStateSource;
  reasonCode: string;
  pendingInfluence: PlannerPendingInfluence;
};

export {
  resolveObservedCurrentState,
  resolveObservedSteppedLoadCurrentState,
};
export type { CurrentStateInput, ObservedCurrentStateInput };

type ResolveCurrentStateOptions = {
  pendingPresent?: boolean;
};

const isSteppedLoadObservation = (
  device: Pick<CurrentStateInput, 'steppedLoadProfile'>,
): boolean => (
  device.steppedLoadProfile?.model === 'stepped_load'
);

function resolvePendingInfluence(
  options?: ResolveCurrentStateOptions,
): PlannerPendingInfluence {
  return options?.pendingPresent === true ? 'present_but_not_applied' : 'none';
}

function buildBinaryResolvedCurrentState(params: {
  currentState: 'on' | 'off';
  stepped: boolean;
  pendingInfluence: PlannerPendingInfluence;
}): ResolvedCurrentState {
  const { currentState, stepped, pendingInfluence } = params;
  const isOn = currentState === 'on';
  let reasonCode = isOn ? 'observed_binary_on' : 'observed_binary_off';
  if (stepped) {
    reasonCode = isOn ? 'observed_step_active' : 'observed_step_off';
  }
  return {
    currentState,
    isOn,
    source: stepped ? 'stepped' : 'binary',
    reasonCode,
    pendingInfluence,
  };
}

function buildNotApplicableResolvedCurrentState(params: {
  currentState: 'not_applicable';
  binaryControl?: { on: boolean };
  pendingInfluence: PlannerPendingInfluence;
}): ResolvedCurrentState {
  const { currentState, binaryControl, pendingInfluence } = params;
  // Binary devices carry an observed `binaryControl`; resolve their on/off. A
  // device with no binary control (target-only / non-binary) carries no
  // `binaryControl`, mirroring the old absent-`currentOn` target branch.
  if (binaryControl !== undefined) {
    return {
      currentState,
      isOn: binaryControl.on,
      source: 'binary',
      reasonCode: binaryControl.on
        ? 'observed_binary_on_not_applicable'
        : 'observed_binary_off_not_applicable',
      pendingInfluence,
    };
  }
  return {
    currentState,
    isOn: null,
    source: 'target',
    reasonCode: 'observed_target_only',
    pendingInfluence,
  };
}

export function resolveEffectiveCurrentState(
  device: CurrentStateInput,
  options?: ResolveCurrentStateOptions,
): ResolvedCurrentState {
  const currentState = resolveObservedCurrentStateValue(device);
  const pendingInfluence = resolvePendingInfluence(options);
  const stepped = isSteppedLoadObservation(device);

  if (currentState === 'on' || currentState === 'off') {
    return buildBinaryResolvedCurrentState({ currentState, stepped, pendingInfluence });
  }

  if (currentState === 'not_applicable') {
    return buildNotApplicableResolvedCurrentState({
      currentState,
      binaryControl: device.binaryControl,
      pendingInfluence,
    });
  }

  return {
    currentState,
    isOn: null,
    source: 'unknown',
    reasonCode: currentState === 'unknown' ? 'observed_state_unknown' : 'observed_state_unrecognized',
    pendingInfluence,
  };
}

export function resolveEffectiveCurrentOn(
  device: CurrentStateInput,
  options?: ResolveCurrentStateOptions,
): boolean | null {
  return resolveEffectiveCurrentState(device, options).isOn;
}
