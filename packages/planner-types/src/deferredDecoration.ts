import type { DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes.js';
import type { PlanInputDevice } from './planInputDevice.js';

/**
 * Per-cycle plan intent for a planned binary restore or an idle-bucket release.
 * Binary-controlled devices map to `binary_restore` / `binary_release` (the
 * dedicated binary executor path); everything else maps to `shed_release`.
 * Terminal fallback is lifecycle-clock-owned and never enters this contract.
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
 *   (devices PELS has no standing authority over gain `commandAuthority` for the
 *   cycle, budget exemptions,
 *   forced boost, deadline thermostat floors stamped on as flat fields).
 * - `forceShedSet`: device ids the shedding lane must seed into its shed-set
 *   (idle-hour holds).
 * - `deferredAvoidDeviceIds`: devices paused this hour because a cheaper hour can
 *   carry the load — on-track devices with no allocated energy this hour, AND
 *   price-deferral releases (a booked `avoid` current hour whose residual the
 *   producer proved fits cheaper later hours). The planner renders the "Waiting
 *   for cheaper hours" reason instead of a capacity/daily-budget fallback.
 * - `deferredReleaseIntentByDeviceId`: planned restores and idle-bucket release
 *   intents for the executor; terminal fallback stays off the plan path.
 * - `admittedDeviceIds`: flat set of devices whose deferred objective is
 *   currently governing them (a `planned` or `idle` admission decision this
 *   cycle — not `inactive`). The planner's surplus dump-load hold excludes
 *   these ids so a standing "Run on solar surplus" hold can never fight an
 *   active smart task (smart-task precedence, plan-side).
 *
 * The narrower "a task is actively DRIVING this device" fact — a `planned`
 * decision — does not travel here: it rides the device itself as
 * `PlanInputDevice.startPolicyHoldLifted`, because a device that is already OFF
 * never enters the shed set and the readers that must still see the lift only
 * ever hold the device.
 */
export type DeferredDecorationBundle = {
  admittedDevices: PlanInputDevice[];
  forceShedSet: Set<string>;
  deferredAvoidDeviceIds: Set<string>;
  deferredReleaseIntentByDeviceId: Record<string, DeferredReleaseIntent>;
  admittedDeviceIds: ReadonlySet<string>;
};
