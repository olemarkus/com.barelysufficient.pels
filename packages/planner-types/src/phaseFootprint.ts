export type PhaseName = 'L1' | 'L2' | 'L3';

/**
 * Which phases of the main fuse a device loads, resolved by
 * `lib/phaseFootprint/`. `unknown` is a real answer: the device may be on any
 * phase, so limiting it cannot be counted on for a given one.
 * `self_balancing` moves its own load between phases, so PELS does not spend it
 * against a single phase.
 */
export type PhaseFootprint =
  | { kind: 'all_three' }
  | { kind: 'single'; phase: PhaseName }
  | { kind: 'unknown' }
  | { kind: 'self_balancing' };

/**
 * The phases a car draws on through its charger, resolved by
 * `lib/phaseFootprint/`. A three-phase charger can carry a one-phase car, which
 * then takes a third of the power its ladder names per amp. `ladder` is the
 * answer without that evidence: the ladder's own geometry stands.
 */
export type ChargingDrawPhases =
  | { kind: 'ladder' }
  | { kind: 'observed'; phases: 1 | 2 | 3 };
