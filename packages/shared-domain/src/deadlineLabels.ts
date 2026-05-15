import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing'
  // EV plugged-out / discharging session — runtime diagnostics emit
  // `objective_invalid_session`; UI surfaces it as a paused state so the user
  // knows the plan resumes once they plug back in.
  | 'invalid_session'
  // Thermal devices have no shipped bootstrap kWh/°C, so a new device sits
  // pending until the energy profile is learned from power readings.
  | 'missing_capacity';

// Hero/list "live" status variants. Sits next to the kind chip and identifies
// the current operational state in plain language. `building_plan` /
// `queued` / `paused_unplugged` are the three disambiguated `Waiting` cases;
// `active` covers "Charging now"/"Heating now"; `ok` is the on-track no-op
// state when there is no active hour yet but a plan exists.
export type DeadlineLiveState =
  | 'active'
  | 'building_plan'
  | 'queued'
  | 'paused_unplugged'
  | 'ok';

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
  // Live-state chip labels (kind-aware). The hero, smart-task list, and device
  // card all draw from this map so the three surfaces stay in sync. Replaces
  // the prior single `waitingChipLabel`; see `DeadlineLiveState`.
  liveStateChipLabel: Record<DeadlineLiveState, string>;
  cannotMeetChipLabel: string;
  // Honest fallback for `Cannot finish` when no specific reason is available.
  // Never paired with the chip alone — the meta line always names a reason so
  // users are never left with a warning chip and no explanation.
  cannotMeetUnknownReason: string;
  deviceSeriesName: string;
  originalDeviceSeriesName: string;
  actualDeviceSeriesName: string;
  backgroundSeriesName: string;
  planTooltipActive: string;
  planTooltipIdle: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, DeadlinePendingCopyResolver>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
  cannotMeetShortfall: (shortfallLabel: string) => string;
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
    liveStateChipLabel: {
      active: 'Heating',
      building_plan: 'Building plan…',
      queued: 'Queued',
      // Thermal devices can't be unplugged; the variant is unreachable here
      // and falls back to the generic queued copy if the resolver ever hands
      // a stale value through.
      paused_unplugged: 'Queued',
      ok: 'On track',
    },
    cannotMeetChipLabel: 'Cannot finish',
    cannotMeetUnknownReason: 'PELS can\'t determine why this task is at risk. '
      + 'Check this heater\'s power readings and setpoint range.',
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
      // Thermal kinds can't go invalid the way an EV session can; if a future
      // diagnostic ever surfaces this reason for a thermostat, treat it the
      // same as `device_data_missing` rather than leaking EV-specific copy.
      invalid_session: () => ({
        headline: 'Waiting for a reading from the device',
        body: 'PELS needs a current temperature, a useful capacity, or a recent observation '
          + 'from this heater before it can plan the smart task.',
      }),
      // Thermal devices have no shipped bootstrap kWh/°C, so a new device sits
      // pending until samples accumulate. Tell the user what's blocking and
      // what unblocks it — without this they see "Waiting" indefinitely with
      // no explanation.
      missing_capacity: () => ({
        headline: 'Learning energy use',
        body: 'PELS needs power readings from this heater while it heats so it can learn how '
          + 'many kWh raise the temperature by one degree. The plan will appear once that is '
          + 'available.',
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
    liveStateChipLabel: {
      active: 'Charging',
      building_plan: 'Building plan…',
      queued: 'Queued',
      paused_unplugged: 'Paused — unplugged',
      ok: 'On track',
    },
    cannotMeetChipLabel: 'Cannot finish',
    cannotMeetUnknownReason: 'PELS can\'t determine why this charging task is at risk. '
      + 'Check the EV charger\'s power readings and charge-rate configuration.',
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
      // EV plugged out (or session reported as discharging). The plan is
      // intentionally paused — it resumes the next time PELS sees a valid
      // session. Telling the user this prevents the "is PELS broken?" worry
      // when they plug back in and expect immediate charging.
      invalid_session: () => ({
        headline: 'Charging plan paused — EV unplugged',
        body: 'PELS will resume the plan once the EV is plugged in and reports a valid charging '
          + 'session.',
      }),
      // EV objectives always have the bootstrap kWh-per-percent fallback, so
      // `missing_capacity` should never actually fire for EVs; keep an
      // equivalent device-data-missing copy as a safety net in case the
      // upstream invariant changes.
      missing_capacity: () => ({
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
