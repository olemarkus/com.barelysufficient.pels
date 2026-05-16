import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../contracts/src/deferredObjectiveActivePlans.js';

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

// Display label for a smart task list card's status chip.
export type SmartTaskListStatusId =
  | 'building_plan'   // pending, no allocation yet
  | 'queued'          // plan ready, first hour in the future
  | 'paused_unplugged' // EV: car unplugged / session ended
  | 'on_track'
  | 'at_risk'
  | 'cannot_meet'
  | 'satisfied';

// Stable chip label strings for list card status — kind-agnostic.
// Sourced here (shared-domain) so runtime logging and UI use the same strings.
export const SMART_TASK_LIST_STATUS_LABELS: Record<SmartTaskListStatusId, string> = {
  building_plan: 'Building plan…',
  queued: 'Queued',
  paused_unplugged: 'Paused — unplugged',
  on_track: 'On track',
  at_risk: 'At risk',
  cannot_meet: 'Cannot finish',
  satisfied: 'Satisfied',
};

// CSS modifier class suffix for each list status id (appended to `plan-chip--`).
export const SMART_TASK_LIST_STATUS_CHIP_VARIANT: Record<SmartTaskListStatusId, string> = {
  building_plan: 'muted',
  queued: 'muted',
  paused_unplugged: 'warn',
  on_track: 'ok',
  at_risk: 'warn',
  cannot_meet: 'alert',
  satisfied: 'ok',
};

// Resolve the list card status id from plan data.
// `nowMs` is used to distinguish "Queued" (plan ready, first action in future)
// from other non-pending states.
//
// `diagnosticReasonCode` carries the recorder's "current cause" signal — it
// is set even on plans with a cached `latest` revision (e.g. EV unplugged
// mid-plan). When present, it takes precedence over `planStatus` so the chip
// matches the device-card line.
export const resolveSmartTaskListStatus = (params: {
  pending: boolean;
  pendingReason: DeferredObjectiveActivePlanPendingReason | undefined;
  diagnosticReasonCode: DeferredObjectiveActivePlanDiagnosticReason | undefined;
  planStatus: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied' | undefined;
  firstActionAtMs: number | null;
  nowMs: number;
}): SmartTaskListStatusId => {
  const { pending, pendingReason, diagnosticReasonCode, planStatus, firstActionAtMs, nowMs } = params;

  // Unplugged-mid-plan: the recorder refreshes `diagnosticReasonCode` even on
  // non-pending plans so this branch fires regardless of whether `latest` is
  // still cached. Without this, the list chip would say "On track" while the
  // device-card line said "Charging plan paused — car unplugged".
  if (diagnosticReasonCode === 'objective_invalid_session') return 'paused_unplugged';

  if (pending || planStatus === undefined) {
    if (pendingReason === 'invalid_session') return 'paused_unplugged';
    return 'building_plan';
  }

  // Plan is ready — check if the first action is in the future (queued).
  if (firstActionAtMs !== null && firstActionAtMs > nowMs) return 'queued';

  if (planStatus === 'satisfied') return 'satisfied';
  if (planStatus === 'cannot_meet') return 'cannot_meet';
  if (planStatus === 'at_risk') return 'at_risk';
  // 'invalid' collapses to on_track at the list level; the detail page shows more.
  return 'on_track';
};

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
  // User-friendly tooltip line for hours that were revised. Keys are the
  // revision reasons emitted by the active-plan recorder. Reasons that are not
  // expected to appear on revised hours (device_unavailable, measured_deviation)
  // are omitted; callers fall back to null for unknown keys.
  revisionReasonTooltipLine: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>>;
};

// Shared across all objective kinds — revision reasons are recorder-level
// concepts that don't vary by device category.
const REVISION_REASON_TOOLTIP_LINE: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>> = {
  flow_card: 'Revised because a flow card fired',
  prices_arrived: 'Revised because prices became available',
  objective_changed: 'Revised because the target changed',
  prices_revised: 'Revised because new prices arrived',
  rate_refined: 'Revised because rates were refined',
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
    revisionReasonTooltipLine: REVISION_REASON_TOOLTIP_LINE,
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
    revisionReasonTooltipLine: REVISION_REASON_TOOLTIP_LINE,
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];

// ─── EV device-card state lines ───────────────────────────────────────────────

const EV_CARD_HOUR_MS = 60 * 60 * 1000;

export type EvCardStateLine =
  | { kind: 'next_start'; text: string }
  | { kind: 'active_charging'; text: string }
  | { kind: 'plug_out_paused'; text: string }
  | { kind: 'none' };

// Resolve the most-actionable EV state line for a device card.
//
// Priority (most actionable first):
//   1. Active charging: current bucket is planned → show planned finish time.
//   2. Next planned start: a future first bucket exists → show its start time.
//   3. Plug-out paused: session is invalid (car unplugged) → static message.
//
// `isPlugOutPaused` comes from the diagnostic reason `objective_invalid_session`.
// `formatTime` is supplied by the caller (UI layer) so shared-domain stays
// free of locale/Date helpers — see the rule on `DeadlinePendingContext`.
export const resolveEvCardStateLine = (params: {
  hours: ReadonlyArray<{ startsAtMs: number }>;
  nowMs: number;
  isPlugOutPaused: boolean;
  formatTime: (ms: number) => string;
}): EvCardStateLine => {
  const { hours, nowMs, isPlugOutPaused, formatTime } = params;

  if (hours.length > 0) {
    const lastHour = hours[hours.length - 1];
    const lastHourEndMs = lastHour.startsAtMs + EV_CARD_HOUR_MS;
    // Active charging requires `nowMs` to fall inside one of the planned
    // hour buckets, not just between first and last. EV schedules can be
    // non-contiguous (e.g. planned hours at 01:00 and 05:00 with `now` at
    // 03:00); during a gap the card should show "Waiting · charging starts
    // HH:MM" with the next planned hour, not the active-charging line.
    const insidePlannedHour = hours.some(
      (hour) => hour.startsAtMs <= nowMs && hour.startsAtMs + EV_CARD_HOUR_MS > nowMs,
    );
    if (insidePlannedHour) {
      return { kind: 'active_charging', text: `Charging · planned finish ${formatTime(lastHourEndMs)}` };
    }
    const nextHour = hours.find((hour) => hour.startsAtMs > nowMs);
    if (nextHour !== undefined) {
      return { kind: 'next_start', text: `Waiting · charging starts ${formatTime(nextHour.startsAtMs)}` };
    }
  }

  if (isPlugOutPaused) {
    return { kind: 'plug_out_paused', text: 'Charging plan paused — car unplugged' };
  }

  return { kind: 'none' };
};

// ─── Smart task status notification text ─────────────────────────────────────

// Stable lowercase ids surfaced by the `deadline_status_changed` flow-card
// `status` token. This is a **frozen public-API contract**: renaming a value
// breaks user flows that filter on it. Repeated here (rather than imported
// from `flowCards/`) because shared-domain must not pull from runtime layers.
//
// Intentionally distinct from `SmartTaskListStatusId` above — that one is the
// richer UI list-card status (with `building_plan`, `queued`,
// `paused_unplugged`, `cannot_meet`) which is allowed to evolve as the UI
// grows. This one collapses those finer states to the five values flow
// authors filter against (`waiting` absorbs the three pending sub-states;
// `unachievable` is the trigger-side name for `cannot_meet`). Do not merge
// the two enums.
export type SmartTaskStatusNotificationId =
  | 'waiting'
  | 'on_track'
  | 'at_risk'
  | 'unachievable'
  | 'satisfied';

const SMART_TASK_STATUS_DISPLAY_LABEL: Record<SmartTaskStatusNotificationId, string> = {
  waiting: 'Waiting',
  on_track: 'On track',
  at_risk: 'At risk',
  unachievable: 'Cannot finish',
  satisfied: 'Satisfied',
};

// Compose the one-line notification body for `deadline_status_changed`.
// Format examples:
//   "Boiler smart task is At risk — target 55 °C by 07:00"
//   "Tesla smart task is On track — target 80 % by 07:00"
//   "Boiler smart task is Waiting"  (target/deadline omitted when unknown)
//
// The text is the value of the `notification_text` flow token; downstream
// users compose final notifications via Logic/text. Display formatting (the
// `Status` label) is composed here once instead of asking every flow author
// to map ids to human strings.
export const composeSmartTaskStatusNotificationText = (params: {
  deviceName: string;
  status: SmartTaskStatusNotificationId;
  targetText: string;
  deadlineLocalTime: string;
}): string => {
  const head = `${params.deviceName} smart task is ${SMART_TASK_STATUS_DISPLAY_LABEL[params.status]}`;
  const target = params.targetText.trim();
  const deadline = params.deadlineLocalTime.trim();
  const detail = [target && `target ${target}`, deadline && `by ${deadline}`].filter(Boolean).join(' ');
  return detail === '' ? head : `${head} — ${detail}`;
};

// ─── EV learning provenance rows ──────────────────────────────────────────────

// A row in the plan-inputs card describing one provenance fact (source, value,
// sample count, confidence, last accepted at). Pre-resolved at this layer so
// the view never branches on `source` / null values.
export type KwhPerUnitProvenanceRow = { label: string; value: string };

// Confidence text is rendered next to the learned mean. Lowercase to fit the
// neighbouring sentence ("12 samples · medium confidence"); the chip surface
// uses sentence-case copy elsewhere.
const CONFIDENCE_TEXT: Record<'low' | 'medium' | 'high', string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

const formatLearnedValue = (kWhPerUnit: number, unitSuffix: DeadlineLabels['perUnitRateUnit']): string => (
  `${kWhPerUnit.toFixed(2)} ${unitSuffix}`
);

const formatSamplesLine = (acceptedSamples: number, confidence: 'low' | 'medium' | 'high' | null): string => {
  const sampleWord = acceptedSamples === 1 ? 'sample' : 'samples';
  const base = `${acceptedSamples} accepted ${sampleWord}`;
  return confidence === null ? base : `${base} · ${CONFIDENCE_TEXT[confidence]}`;
};

// Resolve display rows for the kWhPerUnit provenance snapshot. The caller
// supplies `formatAcceptedAt` because shared-domain stays free of locale and
// timezone helpers — the UI passes a browser-side formatter, while runtime
// callers can pass a timezone-aware `Intl.DateTimeFormat` formatter.
//
// Producer-side resolution: the UI just renders these rows; it never branches
// on `source`, raw kWh values, or null fields.
export const resolveKwhPerUnitProvenanceRows = (params: {
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined;
  unitSuffix: DeadlineLabels['perUnitRateUnit'];
  formatAcceptedAt: (ms: number) => string;
}): KwhPerUnitProvenanceRow[] => {
  const { provenance, unitSuffix, formatAcceptedAt } = params;
  if (!provenance) return [];
  if (provenance.source === 'bootstrap') {
    // Bootstrap rows describe the cold-start state. The plan-inputs row note
    // already says "Estimated — refining as PELS observes charging", so a
    // single Source row is enough here — adding "0 samples" would be noisy.
    return [{ label: 'Source', value: 'Bootstrap estimate' }];
  }
  const rows: KwhPerUnitProvenanceRow[] = [{ label: 'Source', value: 'Learned profile' }];
  if (provenance.kWhPerUnit !== null && Number.isFinite(provenance.kWhPerUnit) && provenance.kWhPerUnit > 0) {
    rows.push({ label: 'Learned rate', value: formatLearnedValue(provenance.kWhPerUnit, unitSuffix) });
  }
  if (provenance.acceptedSamples > 0) {
    rows.push({ label: 'Samples', value: formatSamplesLine(provenance.acceptedSamples, provenance.confidence) });
  }
  if (provenance.lastAcceptedAtMs !== null && Number.isFinite(provenance.lastAcceptedAtMs)) {
    rows.push({ label: 'Last sample', value: formatAcceptedAt(provenance.lastAcceptedAtMs) });
  }
  return rows;
};
