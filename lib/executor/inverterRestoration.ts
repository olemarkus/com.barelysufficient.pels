import type { InverterControlSurface } from '../../packages/contracts/src/inverterControl';
import type { InverterClaim, InverterReleaseTarget } from '../ports/inverterControl';
import { inverterBindingsMatch, inverterRestorationLimitW } from '../planContract/inverterDecision';

/** One executable hand-back target, also used to judge its confirming reports. */
export function resolveInverterReleaseTarget(
  claim: InverterClaim, control: InverterControlSurface | undefined,
): InverterReleaseTarget | null {
  if (claim.previousMode.kind !== 'direct' && control?.authority === 'limit_and_release'
    && claim.restoration.kind === 'native' && inverterBindingsMatch(claim.restoration.binding, control)) {
    return { kind: 'watts_and_mode',
      limitW: inverterRestorationLimitW(claim.previousLimitW, control), binding: control, mode: claim.previousMode };
  }
  if (claim.previousMode.kind === 'autonomous') {
    // In autonomous mode target_power may be a dormant zero, not a ceiling.
    // Withdrawing PELS without a safe enum restore must free production instead.
    const priorBinding = claim.restoration.kind === 'native' ? claim.restoration.binding : control;
    if (!priorBinding) return null;
    return { kind: 'watts_only',
      limitW: inverterRestorationLimitW(priorBinding.maxW, control ?? priorBinding) };
  }
  return { kind: 'watts_only', limitW: control
    ? inverterRestorationLimitW(claim.previousLimitW, control) : claim.previousLimitW };
}
