/**
 * A device's shed behaviour: how far the owner allows PELS to limit it.
 * Persisted under `OVERSHOOT_BEHAVIORS`, read by the key's owner
 * (`readShedBehaviors`, `packages/shared-domain/src/settings/shedBehaviors.ts`)
 * and resolved every plan cycle through `getShedBehavior`, which collapses the
 * configured heating and cooling limits to the one for the device's direction.
 *
 * Discriminated on `action`, so `set_temperature` always carries its setpoint.
 * The producer already validated it (finite, clamped into its range); consumers narrow
 * on `action` and read `temperature` inside the branch — they must not
 * re-validate, and there is no longer a temperature-less `set_temperature` to
 * fall through on. That fall-through used to send a device configured for
 * setpoint limiting down the turn-off axis instead.
 *
 * `set_step` carries no step id on purpose: the producer never stores one, and
 * every consumer that wants a rung resolves it from the device's own ladder
 * (`getSteppedLoadLowestActiveStep`). Note this is the FLOOR — the deepest a
 * cycle may go — not a decision; the delivered rung is `shedStepTargets`
 * (`lib/plan/shedding/AGENTS.md`).
 */
export type ShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_temperature'; temperature: number }
  | { action: 'set_step' };
