import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing';

export type DeadlinePlanCompletedReason = 'deadline_passed';

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  waitingChipLabel: string;
  cannotMeetChipLabel: string;
  deviceSeriesName: string;
  originalDeviceSeriesName: string;
  backgroundSeriesName: string;
  planTooltipActive: string;
  planTooltipIdle: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, { headline: string; body: string }>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
  cannotMeetShortfall: (shortfallLabel: string) => string;
  cannotMeetFallback: string;
  completedHero: { headline: string; body: string };
  targetUnit: '°C' | '%';
  planInputsCardTitle: string;
  planInputsRateRowLabel: string;
  planInputsMaxPowerRowLabel: string;
  perUnitRateUnit: 'kWh/°C' | 'kWh/%';
};

const DEADLINE_LABELS: Record<DeferredObjectiveSettingsKind, DeadlineLabels> = {
  temperature: {
    kindChipLabel: 'Temperature',
    activeChipLabel: 'Heating',
    waitingChipLabel: 'Heat queued',
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Heating',
    originalDeviceSeriesName: 'Original Heating',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Heat',
    planTooltipIdle: 'Idle',
    pendingHeroByReason: {
      awaiting_horizon_plan: {
        headline: 'Waiting for tomorrow’s prices',
        body: 'PELS will plan this task once prices are available through the selected time.',
      },
      price_feature_disabled: {
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a heat plan.',
      },
      device_data_missing: {
        headline: 'Waiting for a reading from the device',
        body: 'PELS needs a current temperature, a useful capacity, or a recent observation '
          + 'from this heater before it can plan the smart task.',
      },
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
    completedHero: {
      headline: 'Smart task finished',
      body: 'See History for the outcome.',
    },
    targetUnit: '°C',
    planInputsCardTitle: 'Plan inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
    perUnitRateUnit: 'kWh/°C',
  },
  ev_soc: {
    kindChipLabel: 'EV',
    activeChipLabel: 'Charging',
    waitingChipLabel: 'Charge queued',
    cannotMeetChipLabel: 'Cannot finish',
    deviceSeriesName: 'Charging',
    originalDeviceSeriesName: 'Original Charging',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Charge',
    planTooltipIdle: 'Idle',
    pendingHeroByReason: {
      awaiting_horizon_plan: {
        headline: 'Waiting for tomorrow’s prices',
        body: 'PELS will plan this task once prices are available through the selected time.',
      },
      price_feature_disabled: {
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a charging plan.',
      },
      device_data_missing: {
        headline: 'Waiting for a reading from the EV',
        body: 'PELS needs a current state of charge, a charge rate, or a recent observation '
          + 'from this EV before it can plan the smart task.',
      },
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
    completedHero: {
      headline: 'Smart task finished',
      body: 'See History for the outcome.',
    },
    targetUnit: '%',
    planInputsCardTitle: 'Plan inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
    perUnitRateUnit: 'kWh/%',
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];
