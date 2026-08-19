/**
 * Desired-state vocabulary for the executor-facing intent types.
 *
 * WHY THIS EXISTS: the executor converges observed state onto DESIRED state.
 * *Why* a desired state was chosen is planner business and must not cross the
 * boundary (`lib/executor/AGENTS.md`). The planner's shed-policy discriminant
 * left in PR #2150 — its name is deliberately not repeated here, so that
 * guard's grep stays empty. This is how the remaining classification vocabulary
 * follows it: the executor is handed the end state directly instead of a
 * category it has to re-derive one from.
 *
 * **Membership is the answer, not a field.** The planner emits the set of
 * devices it is driving, and a device it is not driving is simply absent from
 * that set — an axis with no command has no command object, and a device with
 * no command for an axis has no key for it (`ExecutableDeviceIntent`). So there
 * is no probe, no regrouper, and no "not driven" sentinel anywhere in this
 * seam. That is why `desiredOn` is a strict `boolean` and never `boolean |
 * null`: the producer knows which is which, and a nullable would hand the
 * executor back the question the planner already answered.
 *
 * Only the binary axis lives here so far. The step and target axes still reach
 * the executor as `ExecutableSteppedLoadIntent.purpose` / the `desired` bag and
 * `ExecutableTargetIntent.purpose`; their end-state kinds land with that
 * migration rather than sitting here unused.
 */

/** The binary axis a command drives: what the plan wants the on/off handle to be. */
export type DesiredBinaryKind = {
  desiredOn: boolean;
};

/**
 * Narrows to a command whose binary axis the plan DRIVES this cycle.
 *
 * The runtime predicate is the producer-resolved presence of `desiredOn`,
 * mirroring `isBinaryPlanDevice`. Absence is not "off" and not "unknown": it is
 * "this cycle's decision does not move the on/off axis", which for a stepped
 * device is the ordinary steady / step-up / step-down case where the plan only
 * has something to say about the step.
 */
export const isBinaryDrivenIntent = <T extends object>(
  intent: T,
): intent is T & DesiredBinaryKind => (
  'desiredOn' in intent && typeof (intent as DesiredBinaryKind).desiredOn === 'boolean'
);
