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

/**
 * Shared by both kinds: a smart task with a deadline outranks this setting, and
 * an owner who has set one needs to know which of the two is deciding.
 */
export const SURPLUS_TRACKING_SMART_TASK_NOTE
  = 'A smart task with a deadline on this device decides instead, while it is running.';

