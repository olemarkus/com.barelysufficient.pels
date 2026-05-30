// Smart-tasks list populated-state hero: single-signal headline + one named
// subline. Producer-side resolver (per `feedback_layering_resolution_in_producer.md`)
// so the view layer never branches on `statusId` to pick copy.
//
// Mission of the page: "are my deadlines on track?". The hero answers that in
// one sentence (headline) and names the most-actionable card (subline).
//
// Each card classifies into exactly one of five buckets — kept as explicit
// sets so the previous "everything not at-risk is on-track" lump (which
// silently counted `building_plan` and `satisfied` cards under "on track")
// can't grow back:
//
//   on-track  : `on_track`
//   pending   : `building_plan`, `queued`
//   paused    : `paused_unplugged`
//   at-risk   : `at_risk`, `cannot_meet`
//   satisfied : `satisfied`
//
// Headline precedence (worst-wins, then split clause):
//   1. Any at-risk card                  → `N deadlines at risk.` (worst-wins;
//                                          tone escalates to `alert` when any
//                                          card is `cannot_meet`). Mixed
//                                          cohorts use the `N of M` framing.
//   2. Any paused card (no at-risk)      → `N deadlines paused.` with `warn`
//                                          tone. Mixed cohorts use the
//                                          `N of M` framing. Paused outranks
//                                          on-track / pending / satisfied
//                                          because an unplugged EV needs the
//                                          user to act before the plan can
//                                          deliver — treating it as merely
//                                          "planning" understates that.
//   3. Mixed on-track / pending / satisfied
//                                        → split-clause headline:
//                                          `X on track, Y planning, Z complete.`
//                                          (clauses present only for non-zero
//                                          buckets, in the order on-track →
//                                          pending → satisfied).
//   4. All on-track                      → `N deadlines on track.`
//   5. All pending                       → `Planning N deadlines.`
//   6. All satisfied                     → `N deadlines complete.`
//
// Subline always names the soonest relevant card:
//   - at-risk branch: soonest `cannot_meet` (under alert tone) or soonest
//     `at_risk`, with the status reason after the em-dash;
//   - paused branch: soonest `paused_unplugged` card, using the
//     "due HH:MM — car unplugged." framing so the subline never claims
//     "ready by HH:MM" for a smart task the device can't deliver until the
//     user plugs back in;
//   - every other non-at-risk / non-paused branch: soonest card overall,
//     using the "ready by HH:MM[, verb from HH:MM]" framing.
//
// Empty cards return `null` so the existing empty-state stanza stays in charge
// — this resolver only owns the populated-state hero.
//
// Time formatting is provider-supplied (`formatTime`) so shared-domain stays
// free of locale / Date helpers, matching the rest of the deadline copy.

import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import type { SmartTaskListStatusId } from './deadlineLabels';

// Minimal card payload the hero consumes. Mirrors the relevant subset of
// `DeadlinesListCard` so the renderer (settings-ui) can pass cards through
// without coupling shared-domain to the view's full card type.
//
// `deviceId` is the stable list identifier the renderer attaches as
// `data-device-id`; the hero only forwards it so the named-subline affordance
// can scroll-to the matching card without the view re-deriving the slug.
export type DeadlinesListHeroCard = {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly kind: DeferredObjectiveSettingsKind;
  readonly deadlineAtMs: number;
  readonly firstActionAtMs: number | null;
  readonly statusId: SmartTaskListStatusId;
};

// Subline navigation target — when the subline names a specific card, the
// view renders a quiet affordance that scrolls to it. `null`/absent means the
// subline stays plain text (e.g. empty cards before the hero suppresses).
export type DeadlinesListHeroSublineTarget = {
  readonly deviceId: string;
};

export type DeadlinesListHeroCopy = {
  readonly eyebrow: 'Smart tasks';
  readonly headline: string;
  readonly subline: string;
  readonly tone: 'good' | 'warn' | 'alert';
  // Present whenever the subline names a card (both on-track and at-risk
  // branches name the soonest relevant card). Absent only on degenerate
  // future branches that don't name a specific card.
  readonly sublineTarget?: DeadlinesListHeroSublineTarget;
};

// States the Smart tasks panel renders a baseline (non-populated) header for.
// Shared so the producer constant and the view's prop type cannot drift.
//
// `empty` and `empty_between_runs` are two distinct zero-active-card states:
//   - `empty`            : true first run — no active cards AND no past-tasks
//                          history. The header invites the user to add their
//                          first task and the body carries the Flow setup copy.
//   - `empty_between_runs`: no active cards, but the Past tasks archive below
//                          has finished runs. The user has used smart tasks
//                          before; the header must NOT say "first" / "yet"
//                          (which reads as "you've never done this"). It points
//                          the user at the archive instead.
export type DeadlinesListBaselineState =
  | 'loading'
  | 'error'
  | 'empty'
  | 'empty_between_runs';

// Eyebrow rendered on the baseline Smart tasks header. Kept as the same
// literal the populated hero emits via `DeadlinesListHeroCopy.eyebrow` so
// runtime logs and screenshots quote one canonical label.
export const DEADLINES_LIST_BASELINE_EYEBROW = 'Smart tasks';

// Headlines rendered under the persistent Smart tasks header when the list is
// loading / failing / empty. Sibling panels (Overview / Budget / Usage /
// Settings) keep a persistent header in non-populated states; pulling the
// labels into shared-domain mirrors the populated-hero copy chain so any
// runtime log that references one of these states can quote the same wording
// (Rule 4 — UI text shared with logs).
export const DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE: Record<
  DeadlinesListBaselineState,
  string
> = {
  loading: 'Loading your smart tasks…',
  error: 'Smart tasks unavailable',
  empty: 'Add your first smart task',
  // Between runs: the user has finished tasks in the archive but none are
  // scheduled right now. "No smart tasks scheduled" states the present
  // calmly without the "first" / "yet" framing that would erase their
  // history. The body (`DEADLINES_LIST_BETWEEN_RUNS_BODY`) points down to
  // Past tasks.
  empty_between_runs: 'No smart tasks scheduled',
};

// Body copy for the between-runs empty state. Sits under the
// `empty_between_runs` headline and points the user at the Past tasks archive
// below rather than repeating the first-run Flow setup instructions (they
// already know how — they have finished runs). Kept in shared-domain so
// runtime log breadcrumbs and the UI render the same sentence (Rule 4 — UI
// text shared with logs).
export const DEADLINES_LIST_BETWEEN_RUNS_BODY
  = 'Nothing is scheduled right now. Your finished tasks are in Past tasks below.';

// Five-bucket classification of list card status. Each `SmartTaskListStatusId`
// is assigned to exactly one bucket; the `Record` constraint forces the keys
// to cover the union, so adding a new status id (e.g. a future `cancelled`)
// is a type error here until the classification is updated — no silent
// "everything not in the at-risk set is on-track" lump can grow back.
//
// `paused_unplugged` lives in its own `paused` bucket (not `pending`,
// not `at_risk`) because the smart task is waiting for a physical action
// (plug back in) — not failing to deliver a plan, but also not merely
// "planning". Treating it as `pending` would render a healthy `tone: 'good'`
// hero ("Planning 1 deadline.") for a card that needs user attention; the
// at-risk bucket is reserved for "the plan exists and will miss". The
// `paused` bucket gets its own warn-tone headline so the hero answer aligns
// with the per-card chip (`SMART_TASK_LIST_STATUS_CHIP_VARIANT` paints
// `paused_unplugged` warn) and the ready-by line tone
// (`resolveSmartTaskListReadyByTone` returns `warn` for the same state).
type StatusBucket = 'on_track' | 'pending' | 'paused' | 'at_risk' | 'satisfied';

const STATUS_BUCKET: Record<SmartTaskListStatusId, StatusBucket> = {
  on_track: 'on_track',
  building_plan: 'pending',
  queued: 'pending',
  paused_unplugged: 'paused',
  at_risk: 'at_risk',
  cannot_meet: 'at_risk',
  satisfied: 'satisfied',
};

const isBucket = (bucket: StatusBucket) => (card: DeadlinesListHeroCard): boolean => (
  STATUS_BUCKET[card.statusId] === bucket
);

// At-risk cards carry one of the two at-risk statuses. A type predicate
// here narrows `statusId` for downstream callers (the at-risk branch's
// `HERO_REASON_BY_STATUS` lookup) without an `as` cast.
type AtRiskStatusId = 'at_risk' | 'cannot_meet';
type AtRiskHeroCard = DeadlinesListHeroCard & { readonly statusId: AtRiskStatusId };
const isAtRiskCard = (card: DeadlinesListHeroCard): card is AtRiskHeroCard => (
  STATUS_BUCKET[card.statusId] === 'at_risk'
);

// `Record<DeferredObjectiveSettingsKind, …>` already gives compile-time
// exhaustiveness: adding a new kind forces an update to the literal here.
// Kept as data tables (not switches with `never` guards) so the kind →
// verb / noun mapping reads at a glance.
const KIND_VERB: Record<DeferredObjectiveSettingsKind, 'charging' | 'heating'> = {
  ev_soc: 'charging',
  temperature: 'heating',
};

const KIND_NAME_FALLBACK: Record<DeferredObjectiveSettingsKind, 'EV' | 'Heater'> = {
  ev_soc: 'EV',
  temperature: 'Heater',
};

// Hero-specific reason phrasing for at-risk cards. Distinct from
// `SMART_TASK_LIST_STATUS_LABELS` (used on chips) because chip labels are
// short stand-alone pills ("Paused — unplugged") that read poorly when
// inlined as a reason after an em-dash. The hero subline needs a clause
// that flows after the em-dash separator; this map provides exactly that.
// Only the two at-risk bucket members appear here — `paused_unplugged` is
// in the pending bucket and reaches the subline through the soonest-card
// "ready by" framing, never via this map.
const HERO_REASON_BY_STATUS: Record<AtRiskStatusId, string> = {
  at_risk: 'at risk',
  cannot_meet: 'cannot finish in time',
};

const pluralize = (count: number, singular: string, plural: string): string => (
  count === 1 ? singular : plural
);

const deadlinesNoun = (count: number): string => pluralize(count, 'deadline', 'deadlines');

// Mixed-cohort headline clauses, kept as data so the split-clause assembler
// can iterate in a fixed order (on-track → pending → satisfied) without
// branching per combination. Single-clause callers reuse the same labels so
// pure-state and mixed-state headlines agree on terminology ("planning"
// appears in both `Planning 1 deadline.` and `2 on track, 1 planning.`).
const CLAUSE_LABEL = {
  onTrack: 'on track',
  pending: 'planning',
  satisfied: 'complete',
} as const;

// Build the named-subline for non-at-risk, non-paused branches. Default is
// the on-track framing ("Tesla ready by 06:30[, charging from 02:30].") so
// the soonest card is always the named subject regardless of which branch
// fired. Paused cards never reach this helper — the paused branch owns its
// own subline builder so the hero never promises a delivery for an
// unplugged EV.
const buildSoonestSubline = (card: DeadlinesListHeroCard, formatTime: (ms: number) => string): string => {
  const deviceName = card.deviceName.trim() || KIND_NAME_FALLBACK[card.kind];
  const verb = KIND_VERB[card.kind];
  const readyByPart = `${deviceName} ready by ${formatTime(card.deadlineAtMs)}`;
  return card.firstActionAtMs !== null
    ? `${readyByPart}, ${verb} from ${formatTime(card.firstActionAtMs)}.`
    : `${readyByPart}.`;
};

// Paused-branch subline: "Tesla due 06:30 — car unplugged.". Mirrors the
// shape of the at-risk subline ("due HH:MM — reason.") so the warn-tone
// branches share a recognisable cadence. Only `paused_unplugged` cards
// reach this helper.
const buildPausedSubline = (card: DeadlinesListHeroCard, formatTime: (ms: number) => string): string => {
  const deviceName = card.deviceName.trim() || KIND_NAME_FALLBACK[card.kind];
  return `${deviceName} due ${formatTime(card.deadlineAtMs)} — car unplugged.`;
};

// Compose the non-at-risk headline from the three bucket counts. Two or more
// buckets present → split-clause headline; exactly one bucket → the pure
// single-bucket form for that bucket. Caller has already ruled out the
// at-risk branch and the empty-input case, so at least one count is non-zero.
const buildNonAtRiskHeadline = (counts: {
  onTrack: number;
  pending: number;
  satisfied: number;
}): string => {
  const populatedBuckets = [counts.onTrack, counts.pending, counts.satisfied].filter((n) => n > 0).length;
  if (populatedBuckets > 1) {
    // Split-clause assembly: emit a clause for each non-zero bucket in
    // fixed priority order (on-track → pending → satisfied). Stable order
    // means a 1-on-track-plus-2-pending hero reads `1 on track, 2 planning.`
    // and never `2 planning, 1 on track.`.
    const clauses: string[] = [];
    if (counts.onTrack > 0) clauses.push(`${counts.onTrack} ${CLAUSE_LABEL.onTrack}`);
    if (counts.pending > 0) clauses.push(`${counts.pending} ${CLAUSE_LABEL.pending}`);
    if (counts.satisfied > 0) clauses.push(`${counts.satisfied} ${CLAUSE_LABEL.satisfied}`);
    return `${clauses.join(', ')}.`;
  }
  if (counts.onTrack > 0) return `${counts.onTrack} ${deadlinesNoun(counts.onTrack)} on track.`;
  if (counts.pending > 0) return `Planning ${counts.pending} ${deadlinesNoun(counts.pending)}.`;
  return `${counts.satisfied} ${deadlinesNoun(counts.satisfied)} complete.`;
};

// Caller passes the sorted-by-deadline cards (the list already sorts ascending
// by `deadlineAtMs`); this resolver does not re-sort to keep things cheap and
// to honour whatever ordering the producer chose. Empty input returns null.
export const resolveDeadlinesListHero = (params: {
  cards: ReadonlyArray<DeadlinesListHeroCard>;
  formatTime: (ms: number) => string;
}): DeadlinesListHeroCopy | null => {
  const { cards, formatTime } = params;
  if (cards.length === 0) return null;

  const atRiskCards = cards.filter(isAtRiskCard);
  const pausedCards = cards.filter(isBucket('paused'));
  const onTrackCards = cards.filter(isBucket('on_track'));
  const pendingCards = cards.filter(isBucket('pending'));
  const satisfiedCards = cards.filter(isBucket('satisfied'));

  if (atRiskCards.length > 0) {
    // Tone escalates to `alert` only when at least one card is `cannot_meet`.
    // When that happens the subline must name a `cannot_meet` card too — naming
    // an `at_risk` card under a red banner reads as a tone/reason mismatch
    // ("at risk" beneath an alert hero). So: if any `cannot_meet` exists, the
    // subline picks the soonest `cannot_meet`; otherwise the soonest at-risk
    // card. `atRiskCards` preserves the input deadline ordering, so picking
    // the first match is the soonest of that severity.
    const soonestCannotMeet = atRiskCards.find((card) => card.statusId === 'cannot_meet');
    const subjectCard = soonestCannotMeet ?? atRiskCards[0];
    // Mixed-cohort framing: "4 of 5 deadlines at risk." reads truer than
    // "4 deadlines at risk." when one sibling is healthy. When every card is
    // at risk we keep the bare "N deadlines at risk." form so the headline
    // doesn't add noise ("3 of 3" feels mechanical).
    const headline = atRiskCards.length < cards.length
      ? `${atRiskCards.length} of ${cards.length} ${deadlinesNoun(cards.length)} at risk.`
      : `${atRiskCards.length} ${deadlinesNoun(atRiskCards.length)} at risk.`;
    const deviceName = subjectCard.deviceName.trim() || KIND_NAME_FALLBACK[subjectCard.kind];
    // `subjectCard.statusId` is narrowed to `AtRiskStatusId` via the
    // `isAtRiskCard` predicate, so `HERO_REASON_BY_STATUS` indexes exhaustively
    // with no cast.
    const reason = HERO_REASON_BY_STATUS[subjectCard.statusId];
    const subline = `${deviceName} due ${formatTime(subjectCard.deadlineAtMs)} — ${reason}.`;
    const tone: DeadlinesListHeroCopy['tone'] = soonestCannotMeet !== undefined ? 'alert' : 'warn';
    return {
      eyebrow: 'Smart tasks',
      headline,
      subline,
      tone,
      sublineTarget: { deviceId: subjectCard.deviceId },
    };
  }

  // No at-risk cards but at least one paused card — paused outranks the
  // healthy-tone branches because an unplugged EV needs the user to act
  // before the plan can deliver. Mixed cohorts use the `N of M` framing
  // (mirrors the at-risk branch's mixed framing) so a single paused card
  // alongside healthy siblings reads "1 of 3 deadlines paused." rather than
  // a misleading "Planning 3 deadlines." The subline names the soonest
  // paused card with the "due HH:MM — car unplugged." framing so it never
  // claims a delivery the device can't make.
  if (pausedCards.length > 0) {
    const subjectCard = pausedCards[0];
    const headline = pausedCards.length < cards.length
      ? `${pausedCards.length} of ${cards.length} ${deadlinesNoun(cards.length)} paused.`
      : `${pausedCards.length} ${deadlinesNoun(pausedCards.length)} paused.`;
    return {
      eyebrow: 'Smart tasks',
      headline,
      subline: buildPausedSubline(subjectCard, formatTime),
      tone: 'warn',
      sublineTarget: { deviceId: subjectCard.deviceId },
    };
  }

  // No at-risk or paused cards — compose the headline from bucket counts
  // (pure single bucket vs split-clause) and name the soonest deadline
  // overall on the subline. Cards arrive sorted ascending by `deadlineAtMs`,
  // so the first card is always the right named subject across pure / mixed
  // branches.
  const soonest = cards[0];
  return {
    eyebrow: 'Smart tasks',
    headline: buildNonAtRiskHeadline({
      onTrack: onTrackCards.length,
      pending: pendingCards.length,
      satisfied: satisfiedCards.length,
    }),
    subline: buildSoonestSubline(soonest, formatTime),
    tone: 'good',
    sublineTarget: { deviceId: soonest.deviceId },
  };
};
