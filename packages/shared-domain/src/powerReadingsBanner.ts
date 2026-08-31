import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './powerFreshness';

/**
 * The one staleness surface (owner ruling 2026-08-31: banner only). Computed
 * client-side from the tracker's own timestamp — the runtime publishes no
 * freshness label anywhere — and rendered as the global warning banner above
 * the home-scope bar.
 *
 * Copy rules (`notes/ui-terminology.md` § "The no-readings banner"): say
 * what happens ("No power readings…", never "stale"/"data outdated"); name
 * controls as settings ("Whole-home meter" under "Limits & safety"); name the
 * Flow card by its registered name — **Report power usage** — so the words on
 * the banner are findable in the Flow editor. The old onboarding arm ("PELS
 * needs to know where to read…") is gone: the boot-time meter-authority
 * migration persists a source on every install, so "no source chosen" is no
 * longer a steady state the banner needs to narrate.
 */

export type PowerReadingsBannerContent = { text: string; actionLabel: string };

type BannerPowerSource = 'homey_energy' | 'flow';

const NONE_YET_LEAD = 'No power readings yet.';
const STALE_LEAD = 'No power readings in the last minute.';
const ACTION_LABEL = 'Check power source';

const HINT_FLOW_NONE_YET = 'Set up a Flow with the Report power usage action, or pick a '
  + 'whole-home meter under Limits & safety.';
const HINT_FLOW_STALE = 'Check the Flow that runs Report power usage.';
const HINT_METER_CHOSEN = 'Check that the selected whole-home meter is available '
  + 'and reporting power in Homey Energy.';
const HINT_METER_NOT_CHOSEN = 'Pick a whole-home meter under Limits & safety.';

type BannerHintInput = {
  source: BannerPowerSource;
  meterChosen: boolean;
  neverReceived: boolean;
};

const resolveHint = (input: BannerHintInput): string => {
  if (input.source === 'homey_energy') {
    return input.meterChosen ? HINT_METER_CHOSEN : HINT_METER_NOT_CHOSEN;
  }
  // Flow, never received: the exact state detection leaves an install with
  // nothing findable in — the one arm where naming BOTH remedies is honest.
  return input.neverReceived ? HINT_FLOW_NONE_YET : HINT_FLOW_STALE;
};

export type PowerReadingsBannerInput = {
  /** The tracker's last sample stamp (status fallback allowed); null = never. */
  lastPowerUpdate: number | null;
  nowMs: number;
  source: BannerPowerSource;
  /** Homey Energy only: whether a whole-home meter is chosen yet. */
  meterChosen: boolean;
};

/** `null` = fresh readings; the banner hides. */
export const resolvePowerReadingsBannerContent = (
  input: PowerReadingsBannerInput,
): PowerReadingsBannerContent | null => {
  const neverReceived = input.lastPowerUpdate === null;
  if (
    input.lastPowerUpdate !== null
    && (input.nowMs - input.lastPowerUpdate) <= POWER_SAMPLE_STALE_THRESHOLD_MS
  ) {
    return null;
  }
  const lead = neverReceived ? NONE_YET_LEAD : STALE_LEAD;
  const hint = resolveHint({ source: input.source, meterChosen: input.meterChosen, neverReceived });
  return { text: `${lead} ${hint}`, actionLabel: ACTION_LABEL };
};
