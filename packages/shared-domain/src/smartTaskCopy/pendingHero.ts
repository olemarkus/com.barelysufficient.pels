// The detail page's pending hero: what a waiting or paused smart task shows,
// and the recourse button that goes with it.
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from '../objectiveWriteStrings';
import { SMART_TASK_BANNER_UNAVAILABLE_TITLE } from './listCopy';
import {
  PENDING_REASON_MISSING_CAPACITY_COPY,
  SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
  SMART_TASK_DEVICE_UNMANAGED_WHY,
  WAITING_FOR_CAR_ASSOCIATION,
} from './pendingReasons';

// Whether tomorrow's prices arrive via a user-managed Flow (`external_flow`,
// the `flow` price scheme) or via PELS' own fetcher (`managed`, e.g. Norway
// spot or Homey Energy). `unknown` is the safe fallback when scheme can't be
// resolved — copy treats it like `managed` (passive wait).
export type DeadlinePendingPriceSource = 'external_flow' | 'managed' | 'unknown';

export type DeadlinePendingContext = {
  priceSource: DeadlinePendingPriceSource;
  // Whether PELS has a price for the current hour. Without one it has no
  // prices at all, which waiting for tomorrow's prices will not fix.
  hasCurrentPrice: boolean;
  // Pre-formatted local time of the last successful price refresh (e.g. "14:32"),
  // or null when no refresh has happened yet. Formatting lives in the caller so
  // shared-domain stays free of locale/Date helpers.
  lastFetchedShort: string | null;
  // Active task's device id (e.g. "homey:device:abc123"). Empty string when
  // the device snapshot hasn't loaded yet; device-side pending resolvers
  // (`device_data_missing`, `invalid_session`, `missing_capacity`) stamp this
  // onto the recourse so the click dispatcher can deep-link into the
  // device-settings overlay in one tap — matching the cannot-meet recourse
  // pattern (see `DeadlineCannotMeetRecourse.deviceId`).
  deviceId: string;
  // Device name (e.g. "Connected 300") so the per-reason headlineReason copy
  // can name the source of the stall ("PELS can't read the current temperature
  // from {device}"). Empty string is a safe fallback when the device snapshot
  // hasn't loaded yet; resolvers degrade to a kind-only sentence.
  deviceName: string;
  // Pre-formatted local time of the deadline (e.g. "07:00"), used by the
  // `awaiting_horizon_plan` resolver to surface the horizon the planner is
  // waiting on. Caller resolves so shared-domain stays free of locale helpers.
  deadlineTime: string;
};

// Recourse action surfaced under the cannot-finish hero body and the pending
// hero. The producer resolves a stable `targetTab` slug
// (Homey settings-UI shell tab id) so the view just forwards it to the click
// dispatcher without branching on cause codes. Adding a new action means
// adding a label here, picking a target tab, and the dispatcher in
// `deadlinePlanMount.ts` already handles the click → `showTab(targetTab)`
// flow.
//
// Cannot-meet branches (resolved in `resolveCannotMeetRecourse`):
//   daily-budget-exhausted        → `targetTab: 'budget'`
//                                   (per `feedback_hard_cap_is_physical.md`,
//                                   the recourse path is "lower the daily
//                                   budget," not "raise the hard cap").
//   device-side shortfall / other → `targetTab: 'overview'`
//                                   (where the device card hosts the in-app
//                                   detail drawer; reaching across surfaces
//                                   to the device-detail overlay directly
//                                   from the smart-task panel would couple
//                                   two otherwise-independent panels).
//
// Pending branches: `device_data_missing` and `missing_capacity` point at
// `targetTab: 'overview'` (same device-card surface). `invalid_session`
// (EV unplugged) and `awaiting_horizon_plan` carry no recourse — both
// resolve on their own when the user plugs in / when prices land.
export type DeadlineCannotMeetRecourse = {
  label: string;
  targetTab: string;
  // Optional deep-link target. When present, the click dispatcher fires the
  // `open-device-detail` custom event *after* landing on `targetTab` so the
  // user lands on the device-settings overlay in a single click. Carried as
  // a producer-resolved field so the consumer never branches on history-entry
  // source / evidence (per `feedback_layering_resolution_in_producer.md`).
  // Used today by the missed-history "Review device" recourse — the
  // user reads the postmortem and tapping the recourse opens the device that
  // missed, not just a tab list. Live-hero recourses leave this absent.
  deviceId?: string;
};

// `headlineReason` is the subline rendered below the pending headline — a
// short one-sentence answer to "why is this still building?". `recourse` is
// the actionable next step (when there is one); rendered as the same
// button shape PR 2 uses for the cannot-meet hero, with the same shell-tab
// dispatcher in `deadlinePlanMount.ts`. Both fields are nullable so a
// resolver can decline to fabricate either when honest absence is the right
// answer (e.g. `awaiting_horizon_plan` has no user-side recourse — the
// planner runs every ~5 min on its own).
export type DeadlinePendingCopy = {
  headline: string;
  body: string;
  headlineReason: string | null;
  recourse: DeadlineCannotMeetRecourse | null;
};

export type DeadlinePendingCopyResolver = (ctx: DeadlinePendingContext) => DeadlinePendingCopy;

const withLastFetched = (base: string, lastFetchedShort: string | null): string => (
  lastFetchedShort ? `${base} Last price update: ${lastFetchedShort}.` : base
);

// Recourse target for the pending-hero device-side branches
// (`device_data_missing`, `invalid_session`, `missing_capacity`). The Overview
// tab hosts the device card where the user verifies status / capacity. We
// pick a single, kind-aware label so the button reads as "where the device
// lives", not "Adjust device" (which the cannot-meet branch already uses for
// the post-plan-failure case and would mislead in a pre-plan pending state).
// Resolvers spread `deviceId` from the pending context so the click dispatcher
// deep-links to the device-settings overlay in one tap (mirrors the live
// cannot-meet recourse).
const OVERVIEW_DEVICE_RECOURSE_BASE = { label: 'Open device in Overview', targetTab: 'overview' };
export const overviewDeviceRecourse = (deviceId: string): DeadlineCannotMeetRecourse => (
  { ...OVERVIEW_DEVICE_RECOURSE_BASE, deviceId }
);

export const separateMeterUnavailableResolver: DeadlinePendingCopyResolver = () => ({
  headline: SMART_TASK_BANNER_UNAVAILABLE_TITLE,
  body: SMART_TASK_SUB_HOME_UNAVAILABLE,
  headlineReason: null,
  recourse: null,
});

// Kind-agnostic: nothing about this pause is thermal or EV, and the remedy is
// the same switch on the same panel either way. Unlike the sub-home resolver
// this one DOES carry a recourse — the Overview device card deep-links to the
// device settings overlay that holds "Managed by PELS", so the user is one tap
// from resuming the task.
export const deviceUnmanagedResolver: DeadlinePendingCopyResolver = (ctx) => ({
  // The chip directly above already says "Paused — not managed", so the four
  // hero slots carry four distinct facts: state (chip), what is paused
  // (headline), why (headlineReason), and what to do (body). Repeating the
  // chip here — or the why-sentence in the body — spends a slot on nothing.
  headline: 'Smart task paused',
  body: SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
  headlineReason: SMART_TASK_DEVICE_UNMANAGED_WHY,
  recourse: overviewDeviceRecourse(ctx.deviceId),
});

// `awaiting_horizon_plan` is the most common pending reason — the planner
// runs every ~5 min and needs prices through the deadline. `headlineReason`
// repeats the salient horizon time at headline height so the user knows what
// they're waiting on; `recourse` is null because the planner replans itself
// when prices arrive (no user action).
// `not_yet_planned` is the no-blocker pending state: the task was just created
// or edited and the allocator has not run yet. It resolves within a lifecycle
// tick, so the copy describes work in progress and names no cause the user
// could act on — the failure it replaces was claiming a price wait that was not
// happening. `recourse` is null for the same reason `awaiting_horizon_plan`
// has none: there is nothing for the user to do.
//
// The body stays silent about whether prices are in hand. This state is seeded
// before any diagnostic exists, so it cannot know: a task created while prices
// really are missing would be told PELS is working "from the prices it already
// has", trading the price-wait overclaim this fix removes for its mirror image.
// The first lifecycle tick states the real reason either way.
type SmartTaskPlanNoun = 'heat plan' | 'cooling plan' | 'temperature plan' | 'charging plan' | 'schedule';

export const notYetPlannedCopy = (kindNoun: SmartTaskPlanNoun): DeadlinePendingCopyResolver => (
  () => ({
    headline: 'Choosing when to run',
    body: `PELS is working out the ${kindNoun}. `
      + 'This normally lands within a minute.',
    headlineReason: null,
    recourse: null,
  })
);

// No prices at all: the price source is not set up, has none for this home, or
// its fetch fails, so the recourse goes where prices come from.
const NO_PRICES_RECOURSE: DeadlineCannotMeetRecourse = { label: 'Check prices', targetTab: 'electricity-prices' };

export const awaitingHorizonCopy = (kindNoun: SmartTaskPlanNoun): DeadlinePendingCopyResolver => (
  (ctx) => {
    const isFlow = ctx.priceSource === 'external_flow';
    // A Flow price source keeps its own copy below: the Flow is what to check.
    if (!ctx.hasCurrentPrice && !isFlow) {
      return {
        headline: 'PELS has no electricity prices',
        body: withLastFetched(
          `PELS builds a ${kindNoun} from electricity prices, and it has none right now. `
            + 'Check where prices come from under Electricity prices.',
          ctx.lastFetchedShort,
        ),
        headlineReason: `Need prices through ${ctx.deadlineTime} before the smart task can start.`,
        recourse: NO_PRICES_RECOURSE,
      };
    }
    const body = isFlow
      ? `PELS needs prices through the deadline before it can build a ${kindNoun}. `
        + 'In flow price mode, prices arrive only when a Flow calls the '
        + '“Set external prices (tomorrow)” action. Check the Flow that publishes prices '
        + 'if this message stays up after tomorrow’s prices should have arrived.'
      : `PELS will build a ${kindNoun} as soon as prices through the deadline are available.`;
    return {
      headline: isFlow ? 'Waiting for tomorrow’s prices from your Flow' : 'Waiting for tomorrow’s prices',
      body: withLastFetched(body, ctx.lastFetchedShort),
      // Avoid restating "Waiting for tomorrow’s prices" from the headline; the
      // panic-visitor's actionable detail is the horizon time the planner
      // needs to cover.
      headlineReason: `Need prices through ${ctx.deadlineTime} before the smart task can start.`,
      recourse: null,
    };
  }
);

// Price-aware optimisation is off: no plan can be built until it is on again.
export const priceFeatureDisabledCopy = (kindNoun: SmartTaskPlanNoun): DeadlinePendingCopyResolver => (
  () => ({
    headline: 'Price-aware optimisation is off',
    body: `Enable price-aware optimisation in Settings → Electricity prices to compute a ${kindNoun}.`,
    headlineReason: 'Price-aware optimisation is off in Settings.',
    recourse: { label: 'Open Settings', targetTab: 'settings' },
  })
);

export const waitingForCarCopy: DeadlinePendingCopyResolver = (ctx) => ({
  headline: WAITING_FOR_CAR_ASSOCIATION,
  body: 'Confirm the connected car on the charger’s device page or with a Flow.',
  headlineReason: null,
  recourse: overviewDeviceRecourse(ctx.deviceId),
});

// `device_data_missing` / `missing_capacity` (and the thermal fall-through
// for `invalid_session`) share one resolver — same headline, same body, same
// recourse — keyed by the kind's reading-word + device-noun fallback.
// Shared with structured-log breadcrumbs (`feedback_ui_text_shared_with_logs`).
const deviceDataMissingResolver = (
  headline: string,
  body: string,
  readingNoun: 'current temperature' | 'state of charge' | 'power use',
  fallbackDeviceNoun: 'the heater' | 'the cooling device' | 'this device' | 'the EV' | 'the device',
): DeadlinePendingCopyResolver => (ctx) => ({
  headline,
  body,
  headlineReason: `PELS can’t read the ${readingNoun} from `
    + `${ctx.deviceName.trim() || fallbackDeviceNoun}.`,
  recourse: overviewDeviceRecourse(ctx.deviceId),
});

// Split `PENDING_REASON_MISSING_CAPACITY_COPY` into the headline tag and the
// metaLine sentence at the em-dash separator, then re-capitalise the body so
// it reads as a complete sentence in the muted metaLine slot. Done once at
// module load so the constant stays the canonical user-facing string and the
// resolver doesn't drift if the wording is tweaked later. The asserted shape
// is `<headline> — <body-fragment>` (em-dash + space on each side); the
// constant lives in `pendingReasons.ts` with the same shape.
// A constant that lost its separator would split into a single part: the whole
// copy is then the headline, and there is no body fragment to re-capitalise.
const [headlinePart, bodyFragment] = PENDING_REASON_MISSING_CAPACITY_COPY.split(' — ');
export const MISSING_CAPACITY_HEADLINE = headlinePart ?? PENDING_REASON_MISSING_CAPACITY_COPY;
export const MISSING_CAPACITY_BODY = bodyFragment === undefined
  ? ''
  : `${bodyFragment.charAt(0).toUpperCase()}${bodyFragment.slice(1)}`;

export const HEATER_DEVICE_DATA_MISSING = deviceDataMissingResolver(
  'Waiting for a reading from the device',
  'PELS needs a current temperature, a useful capacity, or a recent observation '
    + 'from this heater before it can plan the smart task.',
  'current temperature',
  'the heater',
);

export const COOLING_DEVICE_DATA_MISSING = deviceDataMissingResolver(
  'Waiting for a reading from the device',
  'PELS needs a current temperature, useful capacity, or a recent observation '
    + 'from this cooling device before it can plan the smart task.',
  'current temperature',
  'the cooling device',
);

export const TEMPERATURE_DEVICE_DATA_MISSING = deviceDataMissingResolver(
  'Waiting for a reading from the device',
  'PELS needs a current temperature, useful capacity, or a recent observation '
    + 'from this device before it can plan the smart task.',
  'current temperature',
  'this device',
);

export const EV_DEVICE_DATA_MISSING = deviceDataMissingResolver(
  'Waiting for a reading from the EV',
  'PELS needs a current state of charge, a charge rate, or a recent observation '
    + 'from this EV before it can plan the smart task.',
  'state of charge',
  'the EV',
);

// An energy task counts the energy the device takes, so the one reading it needs
// is the device's power. Reached only while the device has no power reading
// (it then drops out of the smart-task roster); an energy task has no rate to
// learn and its device cannot be unplugged, so `missing_capacity` and
// `invalid_session` are unreachable and share this copy as their safety net.
export const ENERGY_DEVICE_DATA_MISSING = deviceDataMissingResolver(
  'Waiting for a power reading from the device',
  'PELS counts the energy this device takes from its power readings, and needs one '
    + 'before it can plan the smart task.',
  'power use',
  'the device',
);
