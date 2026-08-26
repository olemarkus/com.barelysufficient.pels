/**
 * User-facing copy for the "match solar surplus" tracking modality — the third
 * per-device surplus control, alongside the temperature lift's "Use solar
 * surplus" and the dump load's "Run on solar surplus".
 *
 * Lives in shared-domain rather than in the settings UI so the runtime and the
 * screen cannot drift apart on what this feature is called
 * (`notes/ui-terminology.md` § "Solar surplus vocabulary"). The vocabulary rules
 * that apply: say what happens, and keep `dump load`, `posture`, `hold`,
 * `eligible`, `ceiling` and `surplus-absorb` out of anything an owner reads.
 *
 * The label varies by what the device IS, because "what happens" differs: a
 * charger's level is a charging current, a generic stepped load's is a level.
 * The floor copy varies by nothing at all — it must always name the real
 * kilowatts, because that number is the whole reason the setting exists.
 */

/** Which framing the device earns. Resolved by the caller from the device kind. */
export type SurplusTrackingCopyKind = 'ev_charger' | 'stepped';

export const SURPLUS_TRACKING_LABELS: Record<SurplusTrackingCopyKind, string> = {
  ev_charger: 'Charge on solar surplus',
  stepped: 'Match solar surplus',
};

export const SURPLUS_TRACKING_HINTS: Record<SurplusTrackingCopyKind, string> = {
  ev_charger:
    'PELS sets the charging current to match the solar you are exporting, '
    + 'and lowers it again as the sun goes in.',
  stepped:
    'PELS raises and lowers this device to match the solar you are exporting.',
};

export const SURPLUS_TRACKING_LEADS: Record<SurplusTrackingCopyKind, string> = {
  ev_charger:
    'While your home is exporting solar, PELS picks the charging current your surplus covers.',
  stepped:
    'While your home is exporting solar, PELS picks the level your surplus covers.',
};

/**
 * Shared by both kinds: a smart task with a deadline outranks this setting, and
 * an owner who has set one needs to know which of the two is deciding.
 */
export const SURPLUS_TRACKING_SMART_TASK_NOTE
  = 'A smart task with a deadline on this device decides instead, while it is running.';

/**
 * The sentence that names the real floor. This is the honest core of the
 * feature: a charger's lowest usable current is 6 A, which is about 1.4 kW on
 * one phase and about 4.1 kW on three — so "keep going" can mean over four
 * kilowatts of grid import on a three-phase charger. Hiding that behind a
 * neutral toggle label would make the whole control dishonest, so the number is
 * stated whichever way the owner leans.
 *
 * `floorKw` is the device's own lowest running level, taken from its configured
 * levels rather than assumed, so a hand-configured ladder tells the truth too.
 * When it cannot be resolved the sentence degrades to the shape of the choice
 * without inventing a figure.
 */
export const resolveSurplusFloorHint = (
  kind: SurplusTrackingCopyKind,
  floorKw: number | undefined,
): string => {
  const noun = kind === 'ev_charger' ? 'Charging' : 'This device';
  if (floorKw === undefined || !Number.isFinite(floorKw) || floorKw <= 0) {
    return `${noun} has a lowest running level it cannot go below. `
      + 'Choose whether to stop there, or to keep going and take the shortfall from the grid.';
  }
  return `${noun} has no level between off and about ${formatFloorKw(floorKw)}. `
    + `So PELS either stops, or keeps going at about ${formatFloorKw(floorKw)} `
    + 'and takes whatever the sun does not cover from the grid.';
};

const formatFloorKw = (floorKw: number): string => `${floorKw.toFixed(1)} kW`;
