import type { ReasonContext } from '../../lib/plan/planReasons';
import type { RestoreTiming } from '../../lib/plan/restore/timing';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { restoreTimingFixture } from '../utils/planTestUtils';

/** The restore-timing facts a reason spec sets, laid over the fixture timing. */
type ReasonTimingOverrides = Partial<Pick<RestoreTiming,
  'inCooldown' | 'activeOvershoot' | 'shedCooldownRemainingSec' | 'shedCooldownStartedAtMs' | 'shedCooldownTotalSec'>>;

/**
 * A neutral `ReasonContext` for specs that care about one or two facts at a
 * time. Every field on the production type is required — the defaults that used
 * to sit on the parameter bag existed for exactly this, which put test-shaped
 * optionality on a production contract. It lives here instead. The timing facts
 * a spec sets flat are laid over `restoreTimingFixture`.
 */
export const reasonContext = (
  overrides: Partial<Omit<ReasonContext, 'timing'>> & ReasonTimingOverrides = {},
): ReasonContext => {
  const {
    inCooldown, activeOvershoot, shedCooldownRemainingSec, shedCooldownStartedAtMs, shedCooldownTotalSec,
    ...contextOverrides
  } = overrides;
  return {
    shedReasons: new Map<string, DeviceReason>(),
    guardInShortfall: false,
    timing: restoreTimingFixture({
      inCooldown: inCooldown ?? false,
      activeOvershoot: activeOvershoot ?? false,
      shedCooldownRemainingSec: shedCooldownRemainingSec ?? null,
      shedCooldownStartedAtMs: shedCooldownStartedAtMs ?? null,
      shedCooldownTotalSec: shedCooldownTotalSec ?? null,
    }),
    deferredHoldCauseByDeviceId: new Map(),
    postureHoldReasonById: new Map<string, DeviceReason>(),
    softLimitSource: null,
    physicalLimitBreached: false,
    budgetReleasableHeadroomHold: false,
    hourlyBudgetExhausted: false,
    admissionInputs: null,
    ...contextOverrides,
  };
};
