import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './powerFreshness';

/**
 * The one staleness surface (owner ruling 2026-08-31: banner only). The
 * runtime publishes no freshness label anywhere — the power payload carries a
 * producer-resolved readings FACT (`never` | `received` + stamp), and this
 * resolver ages it against the freshness threshold to render the global
 * warning banner above the home-scope bar.
 *
 * Copy rules (`notes/ui-terminology.md` § "The no-readings banner"): say
 * what happens ("No power readings…", never "stale"/"data outdated"); name
 * controls as settings ("Whole-home meter" under "Limits & safety"); name the
 * Flow card by its registered name — **Report power usage** — so the words on
 * the banner are findable in the Flow editor. There is no separate
 * onboarding arm ("PELS needs to know where to read…"): an install with no
 * source chosen runs on Flow and has received nothing, and that arm already
 * names both remedies.
 */

export type PowerReadingsBannerContent = { text: string; actionLabel: string };

type BannerPowerSource = 'homey_energy' | 'flow';

const NONE_YET_LEAD = 'No power readings yet.';
const STALE_LEAD = 'No power readings in the last minute.';
// The plan behind the page was built without a measurement: the meter has been
// silent past the 10-minute shed timeout and PELS ran its one fail-closed pass.
// The hero draws nothing for that cycle (owner ruling 2026-09-02), so this is
// the only line on the page that connects the cause (no readings) to what the
// owner sees below it (every managed device `Limited`). "Limited" is the
// canonical word (`notes/ui-terminology.md`); "stay" says nothing will change
// until readings return, which is exactly the silence block's rule.
const UNMEASURED_LEAD = 'No power readings for over 10 minutes. Managed devices stay limited until readings return.';
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

const resolveLead = (input: { neverReceived: boolean; planUnmeasured: boolean }): string => {
  if (input.neverReceived) return NONE_YET_LEAD;
  return input.planUnmeasured ? UNMEASURED_LEAD : STALE_LEAD;
};

/**
 * The producer-resolved readings fact (`SettingsUiPowerReadings` on the power
 * payload, re-declared browser-safe here): the one boolean-plus-stamp the UI
 * holds about power, with no nullable spelling.
 */
export type PowerReadingsFact =
  | { readonly state: 'never' }
  | { readonly state: 'received'; readonly lastPowerUpdateMs: number };

/**
 * Classify an UNTRUSTED readings value (a realtime push, a cached payload)
 * into the fact, or `null` when the value carries no valid fact — the caller
 * then keeps its last-known fact instead of fabricating `never`.
 */
export const classifyPowerReadingsFact = (value: unknown): PowerReadingsFact | null => {
  if (!value || typeof value !== 'object') return null;
  const readings = value as { state?: unknown; lastPowerUpdateMs?: unknown };
  if (readings.state === 'never') return { state: 'never' };
  if (
    readings.state === 'received'
    && typeof readings.lastPowerUpdateMs === 'number'
    && Number.isFinite(readings.lastPowerUpdateMs)
  ) {
    return { state: 'received', lastPowerUpdateMs: readings.lastPowerUpdateMs };
  }
  return null;
};

export type PowerReadingsBannerInput = {
  readings: PowerReadingsFact;
  nowMs: number;
  source: BannerPowerSource;
  /** Homey Energy only: whether a whole-home meter is chosen yet. */
  meterChosen: boolean;
  /**
   * The current plan's `powerIsMeasured` is false: the silent-meter
   * fail-closed pass. Fresh readings still win (the next admitted sample
   * rebuilds, and the plan catches up a cycle later), so this only sharpens
   * the lead while the banner is showing anyway.
   */
  planUnmeasured: boolean;
};

/** `null` = fresh readings; the banner hides. */
export const resolvePowerReadingsBannerContent = (
  input: PowerReadingsBannerInput,
): PowerReadingsBannerContent | null => {
  const neverReceived = input.readings.state === 'never';
  if (
    input.readings.state === 'received'
    && (input.nowMs - input.readings.lastPowerUpdateMs) <= POWER_SAMPLE_STALE_THRESHOLD_MS
  ) {
    return null;
  }
  const lead = resolveLead({ neverReceived, planUnmeasured: input.planUnmeasured });
  const hint = resolveHint({ source: input.source, meterChosen: input.meterChosen, neverReceived });
  return { text: `${lead} ${hint}`, actionLabel: ACTION_LABEL };
};
