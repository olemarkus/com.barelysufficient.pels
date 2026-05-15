import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing';

export type DeadlinePlanCompletedReason = 'deadline_passed';

// Whether tomorrow's prices arrive via a user-managed Flow (`external_flow`,
// the `flow` price scheme) or via PELS' own fetcher (`managed`, e.g. Norway
// spot or Homey Energy). `unknown` is the safe fallback when scheme can't be
// resolved — copy treats it like `managed` (passive wait).
export type DeadlinePendingPriceSource = 'external_flow' | 'managed' | 'unknown';

export type DeadlinePendingContext = {
  priceSource: DeadlinePendingPriceSource;
  // Pre-formatted local time of the last successful price refresh (e.g. "14:32"),
  // or null when no refresh has happened yet. Formatting lives in the caller so
  // shared-domain stays free of locale/Date helpers.
  lastFetchedShort: string | null;
};

export type DeadlinePendingCopy = { headline: string; body: string };

export type DeadlinePendingCopyResolver = (ctx: DeadlinePendingContext) => DeadlinePendingCopy;

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  waitingChipLabel: string;
  cannotMeetChipLabel: string;
  deviceSeriesName: string;
  originalDeviceSeriesName: string;
  actualDeviceSeriesName: string;
  backgroundSeriesName: string;
  planTooltipActive: string;
  planTooltipIdle: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, DeadlinePendingCopyResolver>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
  cannotMeetShortfall: (shortfallLabel: string) => string;
  cannotMeetFallback: string;
  // Replaces the shortfall/fallback cannot-meet copy when the diagnostic
  // reports that the daily budget cap had been hit before the deadline.
  // Surfaces the budget — not the device or schedule — as the constraint so
  // the user knows where to look. The hard-cap-is-physical guideline forbids
  // suggesting the user raise their capacity hard cap; the recommended remedy
  // is a lower daily budget so future days reserve available power earlier.
  cannotMeetDailyBudgetExhausted: string;
  completedHero: { headline: string; body: string };
  targetUnit: '°C' | '%';
  planInputsCardTitle: string;
  planInputsRateRowLabel: string;
  planInputsMaxPowerRowLabel: string;
  perUnitRateUnit: 'kWh/°C' | 'kWh/%';
  // Subtext shown next to the "Energy per unit" row when the planner is using
  // a bootstrap kWh-per-unit value (no learned profile yet). `null` when the
  // kind has no bootstrap path — only EV SoC ships with one in v1.
  planInputsRateBootstrapNote: string | null;
};

const withLastFetched = (base: string, lastFetchedShort: string | null): string => (
  lastFetchedShort ? `${base} Last price update: ${lastFetchedShort}.` : base
);

const awaitingHorizonCopy = (kindNoun: 'heat plan' | 'charging plan'): DeadlinePendingCopyResolver => (
  (ctx) => {
    if (ctx.priceSource === 'external_flow') {
      return {
        headline: 'Waiting for tomorrow’s prices from your Flow',
        body: withLastFetched(
          `PELS needs prices through the deadline before it can build a ${kindNoun}. `
            + 'In flow price mode, prices arrive only when a Flow calls the '
            + '“Set external prices (tomorrow)” action. Check the Flow that publishes prices '
            + 'if this message stays up after tomorrow’s prices should have arrived.',
          ctx.lastFetchedShort,
        ),
      };
    }
    return {
      headline: 'Waiting for tomorrow’s prices',
      body: withLastFetched(
        `PELS will build a ${kindNoun} as soon as prices through the deadline are available.`,
        ctx.lastFetchedShort,
      ),
    };
  }
);

const DEADLINE_LABELS: Record<DeferredObjectiveSettingsKind, DeadlineLabels> = {
  temperature: {
    kindChipLabel: 'Temperature',
    activeChipLabel: 'Heating',
    waitingChipLabel: 'Heat queued',
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Heating',
    originalDeviceSeriesName: 'Original Heating',
    actualDeviceSeriesName: 'Measured Heating',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Heat',
    planTooltipIdle: 'Idle',
    pendingHeroByReason: {
      awaiting_horizon_plan: awaitingHorizonCopy('heat plan'),
      price_feature_disabled: () => ({
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a heat plan.',
      }),
      device_data_missing: () => ({
        headline: 'Waiting for a reading from the device',
        body: 'PELS needs a current temperature, a useful capacity, or a recent observation '
          + 'from this heater before it can plan the smart task.',
      }),
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first temperature reading',
        body: 'The plan will appear once the device reports its current temperature.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The current temperature already meets the smart task target. PELS will plan again '
          + 'if the temperature drops below target.',
      },
    },
    cannotMeetShortfall: (shortfallLabel) => (
      `There may not be enough time or available power to finish. Short by about ${shortfallLabel}.`
    ),
    cannotMeetFallback: 'There may not be enough time or available power to finish.',
    cannotMeetDailyBudgetExhausted: 'The daily energy budget is already used up for the rest of the day, so '
      + 'PELS can\'t reserve more for heating before the deadline. Lower the daily budget so future '
      + 'days reserve available power earlier, or move the deadline to a later day.',
    completedHero: {
      headline: 'Smart task finished',
      body: 'See History for the outcome.',
    },
    targetUnit: '°C',
    planInputsCardTitle: 'Smart task inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
    perUnitRateUnit: 'kWh/°C',
    planInputsRateBootstrapNote: null,
  },
  ev_soc: {
    kindChipLabel: 'EV',
    activeChipLabel: 'Charging',
    waitingChipLabel: 'Charge queued',
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Charging',
    originalDeviceSeriesName: 'Original Charging',
    actualDeviceSeriesName: 'Measured Charging',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Charge',
    planTooltipIdle: 'Idle',
    pendingHeroByReason: {
      awaiting_horizon_plan: awaitingHorizonCopy('charging plan'),
      price_feature_disabled: () => ({
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a charging plan.',
      }),
      device_data_missing: () => ({
        headline: 'Waiting for a reading from the EV',
        body: 'PELS needs a current state of charge, a charge rate, or a recent observation '
          + 'from this EV before it can plan the smart task.',
      }),
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first state-of-charge reading',
        body: 'The plan will appear once the EV reports its current state of charge.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The EV is already at or above the smart task target. PELS will plan again if the '
          + 'state of charge drops below target.',
      },
    },
    cannotMeetShortfall: (shortfallLabel) => (
      `There may not be enough time or available power to finish. Short by about ${shortfallLabel}.`
    ),
    cannotMeetFallback: 'There may not be enough time or available power to finish.',
    cannotMeetDailyBudgetExhausted: 'The daily energy budget is already used up for the rest of the day, so '
      + 'PELS can\'t reserve more for charging before the deadline. Lower the daily budget so future '
      + 'days reserve available power earlier, or move the deadline to a later day.',
    completedHero: {
      headline: 'Smart task finished',
      body: 'See History for the outcome.',
    },
    targetUnit: '%',
    planInputsCardTitle: 'Smart task inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
    perUnitRateUnit: 'kWh/%',
    planInputsRateBootstrapNote: 'Estimated — refining as PELS observes charging.',
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];
