import type { ReasonContext } from '../../lib/plan/planReasons';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

/**
 * A neutral `ReasonContext` for specs that care about one or two facts at a
 * time. Every field on the production type is required — the defaults that used
 * to sit on the parameter bag existed for exactly this, which put test-shaped
 * optionality on a production contract. It lives here instead.
 */
export const reasonContext = (overrides: Partial<ReasonContext> = {}): ReasonContext => ({
  shedReasons: new Map<string, DeviceReason>(),
  guardInShortfall: false,
  headroomRaw: 0,
  inCooldown: false,
  activeOvershoot: false,
  shedCooldownRemainingSec: null,
  shedCooldownStartedAtMs: null,
  shedCooldownTotalSec: null,
  deferredObjectiveAvoidDeviceIds: new Set<string>(),
  surplusHoldReasonById: new Map<string, DeviceReason>(),
  softLimitSource: null,
  capacityBreached: false,
  budgetReleasableHeadroomHold: false,
  hourlyBudgetExhausted: false,
  admissionInputs: null,
  ...overrides,
});
