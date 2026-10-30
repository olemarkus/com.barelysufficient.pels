// Kind-aware copy for one smart task's detail page: chips, series names, the
// pending, unavailable and cannot-finish heroes, and the plan-inputs card.
import type { DeferredObjectiveActivePlanRevisionReason } from '../../../contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectiveSettingsKind,
  DeferredObjectiveUnit,
} from '../../../contracts/src/deferredObjectiveSettings';
import { SMART_TASK_LIST_STATUS_LABELS, type DeadlineLiveState } from './listStatus';
import {
  awaitingHorizonCopy,
  COOLING_DEVICE_DATA_MISSING,
  ENERGY_DEVICE_DATA_MISSING,
  EV_DEVICE_DATA_MISSING,
  HEATER_DEVICE_DATA_MISSING,
  MISSING_CAPACITY_BODY,
  MISSING_CAPACITY_HEADLINE,
  deviceUnmanagedResolver,
  notYetPlannedCopy,
  overviewDeviceRecourse,
  priceFeatureDisabledCopy,
  separateMeterUnavailableResolver,
  TEMPERATURE_DEVICE_DATA_MISSING,
  waitingForCarCopy,
  type DeadlineCannotMeetRecourse,
  type DeadlinePendingCopyResolver,
} from './pendingHero';
import type { DeadlinePlanPendingReason, DeadlinePlanUnavailableReason } from './pendingReasons';
import { SMART_TASK_GUARANTEE_COPY } from './permissionsCopy';
import { REVISION_REASON_TOOLTIP_LINE } from './revisionReasons';

// Headline-reason copy explaining *why* a queued smart task hasn't started yet.
// Lives in shared-domain so the same strings can also be emitted to the
// structured logger (per `feedback_ui_text_shared_with_logs.md`). Helper is
// pure — locale/Date formatting stays in the caller.
export type DeadlineHeadlineReasonResolverParams = {
  // First planned start time, pre-formatted by the caller (e.g. "16:00").
  // The producer resolves this from `firstChargingHour.startsAtMs`.
  firstPlannedTime: string;
  // True when the latest revision's `computedFromPricesUpTo` does not yet
  // reach the deadline (prices for tomorrow have not arrived). The caller
  // pre-resolves the comparison so shared-domain stays free of arithmetic on
  // optional timestamps.
  pricesShortOfDeadline: boolean;
  // Pre-formatted local time of the deadline (e.g. "16:00") used in the
  // "Waiting for tomorrow's prices through HH:MM" branch. Caller supplies
  // a formatter to keep shared-domain free of locale helpers.
  deadlineTime: string;
  // True when the planned hours' average display price is strictly below the
  // current hour's display price. The producer resolves the comparison from
  // the same per-hour display prices the schedule chart renders (see
  // `resolvePlannedWindowCheaperThanNow` in `deadlinePlanHero.ts`), so the
  // "Cheaper than now" sentence can never contradict the bars. False when the
  // comparison can't be made (no planned hours, no current-hour price).
  plannedWindowCheaperThanNow: boolean;
};

// Returns null when none of the three primary cases apply (e.g. price-aware
// optimisation is off, or the hour was chosen on a non-price basis); the
// view layer suppresses the subline in that case rather than fabricating a
// reason. Honest absence beats invented copy here.
export type DeadlineHeadlineReasonResolver = (
  params: DeadlineHeadlineReasonResolverParams,
) => string | null;

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  // Hero eyebrow / section label. Kind-aware so the user-facing surface uses
  // "EV smart task" / "Heating smart task" instead of the planner-layer noun
  // "EV plan" / "Temperature plan". Per `notes/ui-terminology.md` §"Plan vs
  // deadline terminology".
  sectionLabel: string;
  // Live-state chip labels (kind-aware). The hero, smart-task list, and device
  // card all draw from this map so the three surfaces stay in sync. Replaces
  // the prior single `waitingChipLabel`; see `DeadlineLiveState`.
  liveStateChipLabel: Record<DeadlineLiveState, string>;
  atRiskChipLabel: string;
  cannotMeetChipLabel: string;
  deviceSeriesName: string;
  originalDeviceSeriesName: string;
  actualDeviceSeriesName: string;
  backgroundSeriesName: string;
  // Legend / series name for the target-progress line on the deadline-plan
  // chart. Kind-aware so users see "Charge level" for EV or "Temperature" for
  // thermal instead of the planner-layer "Target progress".
  progressSeriesName: string;
  // Chart-tooltip word for idle (not-planned) hours. Planned hours are already
  // identified by the device-series line ("Heating 2.0 kWh", "Cooling 2.0 kWh",
  // or "Charging 2.0 kWh"), so only the idle case needs its own copy line.
  planTooltipIdle: string;
  pendingHeroByReason: Record<DeadlinePlanPendingReason, DeadlinePendingCopyResolver>;
  unavailableByReason: Record<DeadlinePlanUnavailableReason, { headline: string; body: string }>;
  // Shortfall sentence for cannot-meet. The producer passes raw progress-unit
  // values (°C / %) only when they communicate something meaningful — energy
  // and time shortfalls render via this sentence too. We avoid rendering raw
  // °C deltas (e.g. "Short by about 41.9 °C") because users read those as a
  // device anomaly; the underlying truth is "the smart task can't reach the
  // target temperature in time", which the copy now states directly.
  cannotMeetShortfall: () => string;
  // Replaces the shortfall/fallback cannot-meet copy when the diagnostic
  // reports that the daily budget cap had been hit before the deadline.
  // Surfaces the budget — not the device or schedule — as the constraint so
  // the user knows where to look. The hard-cap-is-physical guideline forbids
  // suggesting the user raise their capacity hard cap; the recommended remedy
  // is a lower daily budget so future days reserve available power earlier.
  cannotMeetDailyBudgetExhausted: string;
  // The budget squeezed the schedule but lifting it would not close the gap.
  // Kept distinct from the line above because that one promises a fix ("lower
  // it... or move the deadline") which is not true here - the target misses even
  // uncapped. It names the "May go over daily budget" permission verbatim AND the
  // path to it — the toggle lives behind Edit → Extra permissions, collapsed and
  // off by default, so it is neither above the hero nor on screen. The
  // cannot-finish recourse stays suppressed for this case: a button that opened
  // the device overlay would land on the standing per-device exemption, a
  // different control with a confusingly similar name.
  cannotMeetDailyBudgetContributed: string;
  // Recourse-action labels for the cannot-finish hero. The producer resolves
  // which `kind` to surface based on the cause; the view renders one button
  // per call. Both labels live here so the strings stay in sync with the rest
  // of the smart-task copy (kind chip / device-card lines).
  //
  // `openOverview` omits `deviceId` — the producer
  // (`resolveCannotMeetRecourse`) spreads the active task's device id onto
  // the payload so the click dispatcher deep-links to the device-settings
  // overlay (mirrors `MISSED_HISTORY_RECOURSE_SHORTFALL` for history-detail).
  cannotMeetRecourse: {
    openBudget: DeadlineCannotMeetRecourse;
    openOverview: Omit<DeadlineCannotMeetRecourse, 'deviceId'>;
  };
  // Resolver for the "why is the smart task starting at HH:MM" subline that
  // sits below the queued headline. Branches resolve in this order:
  //   1. prices_short_of_deadline → "Waiting for tomorrow's prices through HH:MM."
  //   2. planned avg < now price  → "Cheaper than now — starts at HH:MM."
  //   3. otherwise                → "Scheduled for the cheapest times it can use — starts at HH:MM."
  resolveQueuedHeadlineReason: DeadlineHeadlineReasonResolver;
  completedHero: { headline: string; body: string };
  targetUnit: DeferredObjectiveUnit;
  planInputsCardTitle: string;
  planInputsRateRowLabel: string;
  planInputsMaxPowerRowLabel: string;
  planInputsDetailsTitle: string;
  planInputsDetailsNote: string;
  // Subtext shown next to the "Energy per unit" row when the planner is using
  // a bootstrap kWh-per-unit value (no learned profile yet). `null` when the
  // kind has no bootstrap path — only EV SoC ships with one in v1.
  planInputsRateBootstrapNote: string | null;
  // User-friendly tooltip line for hours that were revised. Keys are the
  // revision reasons emitted by the active-plan recorder. Reasons that are not
  // expected to appear on revised hours (device_unavailable, measured_deviation)
  // are omitted; callers fall back to null for unknown keys.
  revisionReasonTooltipLine: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>>;
};

// Shared across both kinds — the "why is the smart task starting at HH:MM"
// resolver branches on data the planner already publishes
// (`computedFromPricesUpTo` vs `deadlineAtMs`). The caller resolves the
// comparisons to flat booleans so this stays free of timestamp math.
const resolveQueuedHeadlineReason: DeadlineHeadlineReasonResolver = (params) => {
  if (params.pricesShortOfDeadline) {
    return `Waiting for tomorrow’s prices through ${params.deadlineTime}.`;
  }
  // "Cheaper than now" is a verifiable claim, so it only renders when the
  // producer-resolved price comparison proves it — the schedule chart sits
  // directly below this line and would otherwise show the disproof (the
  // current hour can be the cheapest bar). When the comparison doesn't hold
  // (or can't be made), fall back to a claim that's true by construction:
  // this branch is only reachable for price-selected plans (branch 1 absorbs
  // every missing/short-price case, and at-risk/cannot-meet plans never call
  // this resolver), and the planner's price-banded fill picks the cheapest
  // hours among the hours it may use. "it can use" (the cheapest-hours
  // caption's eligibility vocabulary) absorbs the cases where "now" is the
  // cheapest bar but ineligible — the line makes no comparison to now, so
  // the chart cannot contradict it.
  if (params.plannedWindowCheaperThanNow) {
    return `Cheaper than now — starts at ${params.firstPlannedTime}.`;
  }
  return `Scheduled for the cheapest times it can use — starts at ${params.firstPlannedTime}.`;
};

// Shared recourse-action labels + target tabs across both kinds. The producer
// picks which one to surface based on cause; the chosen object is the only
// payload the view layer sees. Both `targetTab` values resolve to shell tab
// ids defined in `packages/settings-ui/public/index.html` (`#shell-nav
// [data-tab]`); keep this list in sync if those tab ids change.
//
// `openOverview` omits `deviceId` here so the producer (`resolveCannotMeetRecourse`
// in `deadlinePlanHero.ts`) can spread the active task's device id onto the
// payload — mirroring the history-detail "Review device" pattern in
// `MISSED_HISTORY_RECOURSE_SHORTFALL` so one click closes the panel and opens
// the device-settings overlay instead of dead-ending on the Overview tab.
const CANNOT_MEET_RECOURSE: {
  openBudget: DeadlineCannotMeetRecourse;
  openOverview: Omit<DeadlineCannotMeetRecourse, 'deviceId'>;
} = {
  openBudget: { label: 'Open Budget', targetTab: 'budget' },
  openOverview: { label: 'Adjust device', targetTab: 'overview' },
};

// Live-state chip labels that read the same for every task kind; each kind adds
// its own `active` and `paused_unplugged` words.
const KIND_INVARIANT_LIVE_STATE_CHIP_LABELS = {
  building_plan: 'Building plan…',
  queued: 'On track',
  unavailable: SMART_TASK_LIST_STATUS_LABELS.unavailable,
  // Reachable on any kind: the owner can stop managing a heater too.
  paused_unmanaged: SMART_TASK_LIST_STATUS_LABELS.paused_unmanaged,
  // Only a charger reports the `ok` state; the other kinds never reach it and
  // read the generic on-track copy if a stale value ever comes through.
  ok: 'On track',
} satisfies Partial<Record<DeadlineLiveState, string>>;

// Copy that reads the same for every task kind.
const KIND_INVARIANT_LABELS = {
  atRiskChipLabel: SMART_TASK_LIST_STATUS_LABELS.at_risk,
  cannotMeetChipLabel: 'Cannot finish',
  backgroundSeriesName: 'Background usage',
  planTooltipIdle: 'Idle',
  cannotMeetDailyBudgetExhausted: 'Today\'s daily budget is fully booked. '
    + 'Lower it so future days reserve power earlier, or move the deadline.',
  cannotMeetDailyBudgetContributed: 'Today’s daily budget is holding part of this back, '
    + 'but there is not enough time to finish even without it. '
    + 'Edit the task and turn on “May go over daily budget” under Extra permissions to help; '
    + 'it will not be enough on its own.',
  cannotMeetRecourse: CANNOT_MEET_RECOURSE,
  resolveQueuedHeadlineReason,
  completedHero: {
    headline: 'Smart task finished',
    body: 'See Smart tasks for the outcome.',
  },
  planInputsMaxPowerRowLabel: 'Guaranteed power',
  planInputsDetailsTitle: SMART_TASK_GUARANTEE_COPY.learningDetails,
  planInputsDetailsNote: SMART_TASK_GUARANTEE_COPY.learningScope,
  revisionReasonTooltipLine: REVISION_REASON_TOOLTIP_LINE,
} satisfies Partial<DeadlineLabels>;

const DEADLINE_LABELS: Record<DeferredObjectiveSettingsKind, DeadlineLabels> = {
  temperature: {
    ...KIND_INVARIANT_LABELS,
    kindChipLabel: 'Temperature',
    activeChipLabel: 'Heating',
    sectionLabel: 'Heating smart task',
    liveStateChipLabel: {
      ...KIND_INVARIANT_LIVE_STATE_CHIP_LABELS,
      active: 'Heating',
      // Thermal devices can't be unplugged; the variant is unreachable here
      // and falls back to the generic on-track copy if the resolver ever
      // hands a stale value through.
      paused_unplugged: 'On track',
    },
    deviceSeriesName: 'Heating',
    originalDeviceSeriesName: 'Original Heating',
    actualDeviceSeriesName: 'Measured Heating',
    progressSeriesName: 'Temperature',
    // Thermal `invalid_session` is unreachable today (heaters can't be
    // unplugged); we map it to `device_data_missing` so a future diagnostic
    // can't leak EV-specific copy. `missing_capacity` is the cold-start
    // "learning energy profile" state — no shipped bootstrap kWh/°C — and
    // recourse lands on Overview where the user can verify the heater is
    // actually running and reporting power.
    pendingHeroByReason: {
      not_yet_planned: notYetPlannedCopy('heat plan'),
      awaiting_horizon_plan: awaitingHorizonCopy('heat plan'),
      price_feature_disabled: priceFeatureDisabledCopy('heat plan'),
      device_data_missing: HEATER_DEVICE_DATA_MISSING,
      waiting_for_car: HEATER_DEVICE_DATA_MISSING,
      invalid_session: HEATER_DEVICE_DATA_MISSING,
      // Thermal devices aren't chargers; unreachable here, kept as a safety net
      // so a future diagnostic can't leak EV-specific copy onto a heater.
      device_in_sub_home: separateMeterUnavailableResolver,
      device_unmanaged: deviceUnmanagedResolver,
      // Cold-start `missing_capacity` collapses to a single user-facing line —
      // headline + metaLine combined parse as `PENDING_REASON_MISSING_CAPACITY_COPY`
      // ("Learning energy use — PELS learns how much energy each degree takes …").
      // Earlier copy split the explanation across body + headlineReason, which
      // buried what unblocks the plan in a paragraph. The pending-reason path
      // here intentionally addresses only `objective_missing_capacity`
      // (no-profile cold-start); the thermal `objective_missing_charge_rate`
      // fall-through still routes to this resolver via `THERMAL_LEARNING_CAPACITY_REASON_CODES`
      // in the recorder, which is the same "still learning" user state from
      // their point of view.
      missing_capacity: (ctx) => ({
        headline: MISSING_CAPACITY_HEADLINE,
        body: MISSING_CAPACITY_BODY,
        headlineReason: null,
        recourse: overviewDeviceRecourse(ctx.deviceId),
      }),
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first temperature reading',
        body: 'The schedule will appear once the device reports its current temperature.',
      },
      direction_unavailable: {
        headline: 'Waiting for thermostat mode',
        body: 'PELS needs to know whether this thermostat is heating or cooling to interpret progress.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The current temperature already meets the smart task target. PELS will schedule it '
          + 'again if the temperature drops below target.',
      },
    },
    // Drops the raw progress-unit delta ("Short by about 41.9 °C") that users
    // misread as a wild temperature anomaly. The underlying shortfall is energy
    // / time against the plan, not a raw temperature gap; the chip + headline
    // already say the verdict ("Cannot finish"); body states the cause and the
    // user-side levers. The magnitude (needs N kWh, estimated cost) now lives
    // in the hero stat pairs (Needs / Estimated cost), so this reason line
    // carries only the diagnosis — no appended "Needs N kWh · hours left" tail.
    // Recourse copy names the two levers that aren't the daily budget; the
    // budget remedy is handled by the dedicated
    // `cannotMeetDailyBudgetExhausted` branch above.
    cannotMeetShortfall: () => (
      'Not enough time for this target. Lower the target or move the deadline.'
    ),
    targetUnit: '°C',
    planInputsCardTitle: 'About this estimate',
    planInputsRateRowLabel: 'Energy for each 1 °C',
    planInputsRateBootstrapNote: null,
  },
  ev_soc: {
    ...KIND_INVARIANT_LABELS,
    kindChipLabel: 'EV',
    activeChipLabel: 'Charging',
    sectionLabel: 'EV smart task',
    liveStateChipLabel: {
      ...KIND_INVARIANT_LIVE_STATE_CHIP_LABELS,
      active: 'Charging',
      paused_unplugged: 'Paused — unplugged',
    },
    deviceSeriesName: 'Charging',
    originalDeviceSeriesName: 'Original Charging',
    actualDeviceSeriesName: 'Measured Charging',
    progressSeriesName: 'Charge level',
    // EV `invalid_session` is the plugged-out / discharging pause state. The
    // body already says "PELS will resume…", the headlineReason restates the
    // *cause* at headline height, and recourse is null because plugging in
    // is a physical action with no in-app tab to land on. EV
    // `missing_capacity` should never fire (bootstrap fallback exists); the
    // device-data-missing copy is kept as a safety net.
    pendingHeroByReason: {
      not_yet_planned: notYetPlannedCopy('charging plan'),
      awaiting_horizon_plan: awaitingHorizonCopy('charging plan'),
      price_feature_disabled: priceFeatureDisabledCopy('charging plan'),
      device_data_missing: EV_DEVICE_DATA_MISSING,
      waiting_for_car: waitingForCarCopy,
      invalid_session: () => ({
        headline: 'Charging paused — EV unplugged',
        body: 'PELS will resume the schedule once the EV is plugged in and reports a valid '
          + 'charging session.',
        headlineReason: 'Charger reports the car isn’t plugged in.',
        recourse: null,
      }),
      missing_capacity: EV_DEVICE_DATA_MISSING,
      device_in_sub_home: separateMeterUnavailableResolver,
      device_unmanaged: deviceUnmanagedResolver,
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first state-of-charge reading',
        body: 'The schedule will appear once the EV reports its current state of charge.',
      },
      direction_unavailable: {
        headline: 'Progress direction unavailable',
        body: 'PELS could not resolve the EV charge direction.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The EV is already at or above the smart task target. PELS will schedule it again '
          + 'if the battery level drops below target.',
      },
    },
    // EV mirrors the thermal copy: drop the raw % shortfall figure (users can
    // read it as "the car lost 30 % of charge") in favour of plain-language
    // recourse. The meta line continues to carry the energy/duration magnitude.
    cannotMeetShortfall: () => (
      'Not enough time or charging power for this target. Lower the target or move the deadline.'
    ),
    targetUnit: '%',
    planInputsCardTitle: 'About this estimate',
    planInputsRateRowLabel: 'Energy for each 1%',
    planInputsRateBootstrapNote: 'Estimated — refining as PELS observes charging.',
  },
  // "Deliver N kWh to this device by the deadline." Only a pure on/off device
  // carries one (a relay switching a water heater, with no temperature reading),
  // so no copy here names heating or charging: what the task does is run the
  // device, and its progress is the energy it has taken. Such a device cannot be
  // unplugged: `invalid_session` / `paused_unplugged` are unreachable and fall
  // back as they do for heaters.
  energy: {
    ...KIND_INVARIANT_LABELS,
    kindChipLabel: 'Energy',
    activeChipLabel: 'Running',
    sectionLabel: 'Energy smart task',
    liveStateChipLabel: {
      ...KIND_INVARIANT_LIVE_STATE_CHIP_LABELS,
      active: 'Running',
      // Unreachable on a pure on/off device; the generic on-track fallback.
      paused_unplugged: 'On track',
    },
    deviceSeriesName: 'Running',
    originalDeviceSeriesName: 'Original energy',
    actualDeviceSeriesName: 'Measured energy',
    progressSeriesName: 'Energy delivered',
    pendingHeroByReason: {
      not_yet_planned: notYetPlannedCopy('schedule'),
      awaiting_horizon_plan: awaitingHorizonCopy('schedule'),
      price_feature_disabled: priceFeatureDisabledCopy('schedule'),
      device_data_missing: ENERGY_DEVICE_DATA_MISSING,
      waiting_for_car: ENERGY_DEVICE_DATA_MISSING,
      invalid_session: ENERGY_DEVICE_DATA_MISSING,
      missing_capacity: ENERGY_DEVICE_DATA_MISSING,
      device_in_sub_home: separateMeterUnavailableResolver,
      device_unmanaged: deviceUnmanagedResolver,
    },
    unavailableByReason: {
      no_current_reading: {
        headline: 'Waiting for the first power reading',
        body: 'The schedule will appear once the device reports its power use.',
      },
      // Unreachable: an amount of energy delivered only ever rises.
      direction_unavailable: {
        headline: 'Progress direction unavailable',
        body: 'PELS could not resolve how this smart task makes progress.',
      },
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The device has already taken the energy this smart task asked for.',
      },
    },
    // A device with its own thermostat (a water heater on a relay) stops
    // drawing once it is hot, and no schedule can deliver it more; the shortfall
    // sentence says so, because "not enough time" alone would send the owner to
    // move a deadline that is not the problem.
    cannotMeetShortfall: () => (
      'Not enough time or power for this amount of energy. Lower the target or move the deadline. '
      + 'If the device switches itself off when it is done, like a water heater that is already hot, '
      + 'it may already be full.'
    ),
    targetUnit: 'kWh',
    planInputsCardTitle: 'About this estimate',
    // The rate is exact (one kWh fed is one kWh of progress); the row exists
    // for the other kinds' learned rate and has nothing to teach here.
    planInputsRateRowLabel: 'Energy needed per kWh',
    planInputsDetailsTitle: 'Measurement details',
    planInputsDetailsNote: 'Energy delivered is counted from power readings. No learned conversion rate is needed.',
    planInputsRateBootstrapNote: null,
  },
};

// Added to a satisfied task's page while its device's card shows the done
// task holding it ("Smart task done, held until its ready-by time"). With price
// optimisation off, or in an hour the task booked, nothing holds the device, so
// the page does not say so.
export const SMART_TASK_SATISFIED_HOLD_SENTENCE = 'PELS holds the device until the ready-by time.';

export const deadlineLabels = (
  kind: DeferredObjectiveSettingsKind,
  progressDirection: 'increasing' | 'decreasing' | 'unknown' = 'increasing',
): DeadlineLabels => {
  const labels = DEADLINE_LABELS[kind];
  if (kind !== 'temperature') return labels;
  if (progressDirection === 'unknown') {
    return {
      ...labels,
      activeChipLabel: 'Temperature',
      sectionLabel: 'Temperature smart task',
      liveStateChipLabel: { ...labels.liveStateChipLabel, active: 'Temperature' },
      deviceSeriesName: 'Temperature',
      originalDeviceSeriesName: 'Original temperature',
      actualDeviceSeriesName: 'Measured temperature',
      pendingHeroByReason: {
        ...labels.pendingHeroByReason,
        not_yet_planned: notYetPlannedCopy('temperature plan'),
        awaiting_horizon_plan: awaitingHorizonCopy('temperature plan'),
        price_feature_disabled: priceFeatureDisabledCopy('temperature plan'),
        device_data_missing: TEMPERATURE_DEVICE_DATA_MISSING,
        waiting_for_car: TEMPERATURE_DEVICE_DATA_MISSING,
        invalid_session: TEMPERATURE_DEVICE_DATA_MISSING,
      },
      unavailableByReason: {
        ...labels.unavailableByReason,
        already_satisfied: {
          headline: 'Satisfied',
          body: 'The current temperature already meets the smart task target.',
        },
      },
      cannotMeetShortfall: () => (
        'Not enough time for this target. Choose a temperature target closer to the current temperature '
          + 'or move the deadline.'
      ),
    };
  }
  if (progressDirection !== 'decreasing') return labels;
  return {
    ...labels,
    activeChipLabel: 'Cooling',
    sectionLabel: 'Cooling smart task',
    liveStateChipLabel: { ...labels.liveStateChipLabel, active: 'Cooling' },
    deviceSeriesName: 'Cooling',
    originalDeviceSeriesName: 'Original Cooling',
    actualDeviceSeriesName: 'Measured Cooling',
    pendingHeroByReason: {
      ...labels.pendingHeroByReason,
      not_yet_planned: notYetPlannedCopy('cooling plan'),
      awaiting_horizon_plan: awaitingHorizonCopy('cooling plan'),
      price_feature_disabled: priceFeatureDisabledCopy('cooling plan'),
      device_data_missing: COOLING_DEVICE_DATA_MISSING,
      waiting_for_car: COOLING_DEVICE_DATA_MISSING,
      invalid_session: COOLING_DEVICE_DATA_MISSING,
    },
    unavailableByReason: {
      ...labels.unavailableByReason,
      already_satisfied: {
        headline: 'Satisfied',
        body: 'The current temperature already meets the smart task target. PELS will schedule it '
          + 'again if the temperature rises above target.',
      },
    },
    cannotMeetShortfall: () => (
      'Not enough time for this target. Raise the temperature target or move the deadline.'
    ),
  };
};
