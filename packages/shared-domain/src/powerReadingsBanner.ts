import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './powerFreshness';
import type { SilentMeterDirective } from '../../contracts/src/meterOutage';

/**
 * The one staleness surface (owner ruling 2026-08-31: banner only). The
 * runtime publishes no freshness label anywhere — the power payload carries a
 * producer-resolved readings FACT (`never` | `received` + stamp), and this
 * resolver ages it against the freshness threshold to render the global
 * warning banner above the home-scope bar.
 *
 * Copy rules (`notes/ui-terminology.md` § "The no-readings banner"): say
 * what happens ("No new power readings…", never "stale"/"data outdated"); name
 * controls as settings ("Whole-home meter" under "Limits & safety"); name the
 * Flow card by its registered name — **Report power usage** — so the words on
 * the banner are findable in the Flow editor. There is no separate
 * onboarding arm ("PELS needs to know where to read…"): an install with no
 * source chosen runs on Flow and has received nothing, and that arm already
 * names both remedies.
 */

export type PowerReadingsBannerContent = { text: string; actionLabel: string };

export type BannerPowerSource = 'homey_energy' | 'flow';

const NONE_YET_LEAD = 'No power readings yet.';
// Meter first: it is the path with nothing to build, and most homes have one.
const HINT_FLOW_NONE_YET = 'Pick a whole-home meter under Limits & safety, or set up a Flow '
  + 'with the Report power usage action.';
// A meter that keeps repeating one frozen value is still "available" and still
// "reporting power", so both stopped-hints name what it fails: the reading moving.
const HINT_FLOW_STALE = 'Check the Flow that runs Report power usage and the meter it reads from.';
const HINT_METER_CHOSEN = 'Check that the selected whole-home meter is available in Homey Energy '
  + 'and its reading is changing.';
const HINT_METER_NOT_CHOSEN = 'Pick a whole-home meter under Limits & safety.';

type BannerHintInput = {
  source: BannerPowerSource;
  meterChosen: boolean;
  neverReceived: boolean;
};

/**
 * The remedy once readings that had arrived stop, for a source whose meter
 * name is not to hand: the banner without a Homey Energy name, and the
 * runtime's timeline notice (`lib/power/meterSilenceNotice.ts`).
 */
export const resolveStoppedReadingsHint = (source: BannerPowerSource): string => (
  resolveHint({ source, meterChosen: true, neverReceived: false })
);

const resolveHint = (input: BannerHintInput): string => {
  if (input.source === 'homey_energy') {
    return input.meterChosen ? HINT_METER_CHOSEN : HINT_METER_NOT_CHOSEN;
  }
  // Flow, never received: the exact state detection leaves an install with
  // nothing findable in — the one arm where naming BOTH remedies is honest.
  return input.neverReceived ? HINT_FLOW_NONE_YET : HINT_FLOW_STALE;
};

// The power owner also ages a reading that repeats while the load changes.
export const readingAge = (elapsedMs: number): string => {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
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
  /** Display name from Homey when available for the selected meter. */
  meterName: string | null;
  /** Homey Energy only: whether a whole-home meter is chosen yet. */
  meterChosen: boolean;
  /**
   * What the current plan's silent-meter pass did, or `null` while the plan is
   * measured. Fresh readings still win (the next admitted sample rebuilds, and
   * the plan catches up a cycle later), so this only sharpens the lead while
   * the banner is showing anyway.
   */
  silentMeterPass: SilentMeterDirective | null;
};

const resolveConsequence = (pass: SilentMeterDirective | null): string => {
  if (pass === 'shed') return 'PELS plans to keep managed devices limited until a new reading arrives.';
  if (pass === 'hold') {
    return 'No limit is on, so PELS leaves managed devices as they are, apart from solar-surplus loads, '
      + 'until a new reading arrives.';
  }
  return 'PELS uses the last reading for its power plan.';
};

const resolveReadingsLead = (readings: PowerReadingsFact, nowMs: number): string | null => {
  if (readings.state === 'never') return NONE_YET_LEAD;
  const elapsed = nowMs - readings.lastPowerUpdateMs;
  return elapsed <= POWER_SAMPLE_STALE_THRESHOLD_MS ? null : `Last new power reading ${readingAge(elapsed)} ago.`;
};

/** `null` = fresh readings; the banner hides. */
export const resolvePowerReadingsBannerContent = (
  input: PowerReadingsBannerInput,
): PowerReadingsBannerContent | null => {
  const { readings, source, meterChosen } = input;
  const lead = resolveReadingsLead(readings, input.nowMs);
  if (lead === null) return null;
  if (readings.state === 'never') {
    const hint = resolveHint({ source, meterChosen, neverReceived: true });
    return { text: `${lead} ${hint}`, actionLabel: 'Check power source' };
  }
  const consequence = resolveConsequence(input.silentMeterPass);
  const hint = source === 'homey_energy' && meterChosen && input.meterName
    ? `Check that ${input.meterName} is available in Homey Energy and its reading is changing.`
    : resolveHint({ source, meterChosen, neverReceived: false });
  return {
    text: `${lead} ${consequence} ${hint}`,
    actionLabel: 'Check meter',
  };
};

/** The area's readings describe its own meter, independently of Main's setup and plan. */
export const resolveAreaPowerReadingsBannerContent = (
  readings: PowerReadingsFact,
  nowMs: number,
  areaName: string,
): PowerReadingsBannerContent | null => {
  const lead = resolveReadingsLead(readings, nowMs);
  return lead === null ? null : {
    text: `${lead} Check that the meter for ${areaName} is available in Homey Energy and its reading is changing.`,
    actionLabel: 'Check meter',
  };
};
