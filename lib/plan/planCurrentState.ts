/**
 * Plan-state-aware `ResolvedCurrentState` projection. Pure observed-state
 * resolution lives in `lib/observer/observedState.ts`; this module adds the
 * `pendingInfluence` plan/executor concept on top.
 *
 * Despite the shape, nothing renders a reason from this today: the only
 * production caller is `resolveEffectiveCurrentOn`, read for its `isOn` boolean
 * by `lib/executor/executableSteppedLoadProjection.ts`. The `currentState`,
 * `source`, `reasonCode`, and `pendingInfluence` fields have no production
 * reader — see the `TODO.md` entry that asks whether that surface is intended.
 */
import {
  resolveObservedCurrentStateValue,
  type CurrentStateInput,
} from '../observer/observedState';
import { isBinaryControlled, getBinaryOn } from '../../packages/shared-domain/src/binaryControlState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';

export type PlannerCurrentStateSource = 'binary' | 'stepped' | 'target' | 'unknown';
export type PlannerPendingInfluence = 'none' | 'present_but_not_applied';

export type ResolvedCurrentState = {
  currentState: string;
  isOn: boolean | null;
  source: PlannerCurrentStateSource;
  reasonCode: string;
  pendingInfluence: PlannerPendingInfluence;
};

type ResolveCurrentStateOptions = {
  pendingPresent?: boolean;
};

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
  device: CurrentStateInput;
  pendingInfluence: PlannerPendingInfluence;
}): ResolvedCurrentState {
  const { device, pendingInfluence } = params;
  // A device WITH binary control resolves to its observed on/off; a device with
  // no binary control (target-only / non-binary) is the guard's else-branch —
  // mirroring the old absent-`currentOn` target branch, with no nullable value.
  if (isBinaryControlled(device)) {
    const on = getBinaryOn(device);
    return {
      currentState: 'not_applicable',
      isOn: on,
      source: 'binary',
      reasonCode: on
        ? 'observed_binary_on_not_applicable'
        : 'observed_binary_off_not_applicable',
      pendingInfluence,
    };
  }
  return {
    currentState: 'not_applicable',
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
  const stepped = isSteppedLoadSnapshot(device);

  if (currentState === 'on' || currentState === 'off') {
    return buildBinaryResolvedCurrentState({ currentState, stepped, pendingInfluence });
  }

  if (currentState === 'not_applicable') {
    return buildNotApplicableResolvedCurrentState({ device, pendingInfluence });
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
