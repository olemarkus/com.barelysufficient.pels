import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'no_useful_power'
  | 'no_energy_estimate'
  | 'no_horizon_hours'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing';

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  waitingChipLabel: string;
  deviceSeriesName: string;
  backgroundSeriesName: string;
  planTooltipActive: string;
  planTooltipIdle: string;
  pendingHeroHeadline: string;
  pendingHeroBody: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, { headline: string; body: string }>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
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
    deviceSeriesName: 'Heating',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Heat',
    planTooltipIdle: 'Idle',
    pendingHeroHeadline: 'Waiting for tomorrow’s prices',
    pendingHeroBody: 'The heat plan is computed once tomorrow’s prices arrive.',
    pendingHeroByReason: {
      awaiting_horizon_plan: {
        headline: 'Waiting for tomorrow’s prices',
        body: 'The heat plan is computed once the price horizon covers the deadline.',
      },
      price_feature_disabled: {
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a heat plan.',
      },
      device_data_missing: {
        headline: 'Waiting for a reading from the device',
        body: 'PELS needs a current temperature, a useful capacity, or a recent observation '
          + 'from this heater before it can plan the deadline.',
      },
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first temperature reading',
        body: 'The plan will appear once the device reports its current temperature.',
      },
      no_useful_power: {
        headline: 'No planning power configured',
        body: 'PELS does not yet know how much power this heater draws. Configure its expected load to compute a plan.',
      },
      no_energy_estimate: {
        headline: 'No energy estimate yet',
        body: 'PELS needs a learned heating profile or an allocated plan to estimate energy. '
          + 'Run a heating cycle so the device can be profiled.',
      },
      no_horizon_hours: {
        headline: 'No price horizon for this deadline',
        body: 'The price horizon does not cover the time between now and the deadline.',
      },
      already_satisfied: {
        headline: 'Already at the target temperature',
        body: 'PELS will not schedule any heating because the current temperature already meets '
          + 'the deadline target. The plan reactivates if the temperature drops below target.',
      },
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
    deviceSeriesName: 'Charging',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Charge',
    planTooltipIdle: 'Idle',
    pendingHeroHeadline: 'Waiting for tomorrow’s prices',
    pendingHeroBody: 'The charging plan is computed once tomorrow’s prices arrive.',
    pendingHeroByReason: {
      awaiting_horizon_plan: {
        headline: 'Waiting for tomorrow’s prices',
        body: 'The charging plan is computed once the price horizon covers the deadline.',
      },
      price_feature_disabled: {
        headline: 'Price-aware optimisation is off',
        body: 'Enable price-aware optimisation in Settings → Electricity prices to compute a charging plan.',
      },
      device_data_missing: {
        headline: 'Waiting for a reading from the EV',
        body: 'PELS needs a current state of charge, a charge rate, or a recent observation '
          + 'from this EV before it can plan the deadline.',
      },
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first state-of-charge reading',
        body: 'The plan will appear once the EV reports its current state of charge.',
      },
      no_useful_power: {
        headline: 'No planning power configured',
        body: 'PELS does not yet know how fast this EV charges. Configure its expected load to compute a plan.',
      },
      no_energy_estimate: {
        headline: 'No energy estimate yet',
        body: 'PELS needs a learned charging profile or an allocated plan to estimate energy. '
          + 'Run a charging cycle so the EV can be profiled.',
      },
      no_horizon_hours: {
        headline: 'No price horizon for this deadline',
        body: 'The price horizon does not cover the time between now and the deadline.',
      },
      already_satisfied: {
        headline: 'Already at the target state of charge',
        body: 'PELS will not schedule any charging because the EV is already at or above the '
          + 'deadline target. The plan reactivates if the state of charge drops below target.',
      },
    },
    targetUnit: '%',
    planInputsCardTitle: 'Plan inputs',
    planInputsRateRowLabel: 'Energy per unit',
    planInputsMaxPowerRowLabel: 'Max power per hour',
    perUnitRateUnit: 'kWh/%',
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];
