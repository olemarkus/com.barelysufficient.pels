import type { DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes.js';
import type { PlanInputDevice } from './planInputDevice.js';

/**
 * One-shot release intent emitted when a cap-off device's smart task leaves a
 * plannable status (or the device is in an idle bucket). Binary-controlled
 * devices map to `binary_restore` / `binary_release` (the dedicated binary
 * executor path); everything else maps to `shed_release`, which fires the
 * device's configured shedBehavior once.
 *
 * Defined here (planner I/O package) so both the producing smart-task controller
 * (`lib/objectives`) and the consuming planner (`lib/plan`) agree on the type
 * without the consumer importing the controller. Mirrors the inline union on
 * `DevicePlanDevice.deferredReleaseIntent`.
 */
export type DeferredReleaseIntent = 'binary_restore' | 'binary_release' | 'shed_release';

/**
 * The per-cycle planner context the smart-task controller needs to decorate the
 * device list. `dailyBudgetSnapshot` is passed in (rather than read from a
 * getter) so the controller and the planner's shedding lane see the exact same
 * snapshot within one cycle. The remaining household context (power tracker,
 * price-optimization flag, hard cap) is read live by the controller through its
 * own construction-time getters.
 */
export type DeferredDecorationInput = {
  devices: PlanInputDevice[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  nowTs: number;
};

/**
 * The decorated planner input the smart-task controller returns. The planner
 * consumes this bundle and stays smart-task-agnostic:
 *
 * - `admittedDevices`: the device list with deferred-objective admission applied
 *   (cap-off devices flipped `controllable` for the cycle, budget exemptions,
 *   forced boost, deadline thermostat floors stamped on as flat fields).
 * - `forceShedSet`: device ids the shedding lane must seed into its shed-set
 *   (idle-hour holds).
 * - `deferredAvoidDeviceIds`: devices paused this hour because a cheaper hour can
 *   carry the load — on-track devices with no allocated energy this hour, AND
 *   price-deferral releases (a booked `avoid` current hour whose residual the
 *   producer proved fits cheaper later hours). The planner renders the "Waiting
 *   for cheaper hours" reason instead of a capacity/daily-budget fallback.
 * - `deferredReleaseIntentByDeviceId`: terminal/idle release intents for the
 *   executor.
 */
export type DeferredDecorationBundle = {
  admittedDevices: PlanInputDevice[];
  forceShedSet: Set<string>;
  deferredAvoidDeviceIds: Set<string>;
  deferredReleaseIntentByDeviceId: Record<string, DeferredReleaseIntent>;
};
