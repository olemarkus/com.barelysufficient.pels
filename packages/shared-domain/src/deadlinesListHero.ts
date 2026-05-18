// Smart-tasks list populated-state hero: single-signal headline + one named
// subline. Producer-side resolver (per `feedback_layering_resolution_in_producer.md`)
// so the view layer never branches on `statusId` to pick copy.
//
// Mission of the page: "are my deadlines on track?". The hero answers that in
// one sentence (headline) and names the most-actionable card (subline).
//
// Resolution rules:
//   - All cards on-track-equivalent (`on_track`, `queued`, `building_plan`,
//     `satisfied`)        → `N deadlines on track.`
//                          + subline names the soonest deadline with its
//                            kind verb and (optionally) the first-action time.
//   - One or more at-risk (`at_risk`, `cannot_meet`, `paused_unplugged`)
//                          → `N deadlines at risk.` (N = at-risk count)
//                          + subline names the soonest at-risk deadline with
//                            its status label as the reason.
//
// Empty cards return `null` so the existing empty-state stanza stays in charge
// — this resolver only owns the populated-state hero.
//
// Time formatting is provider-supplied (`formatTime`) so shared-domain stays
// free of locale / Date helpers, matching the rest of the deadline copy.

import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
import type { SmartTaskListStatusId } from './deadlineLabels.js';

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

// Status ids that escalate the hero's tonal voice. `paused_unplugged` is
// classified as warn because the smart task can't progress until the user
// plugs the EV back in — it's actionable, not "on track".
const AT_RISK_STATUSES: ReadonlySet<SmartTaskListStatusId> = new Set([
  'at_risk',
  'cannot_meet',
  'paused_unplugged',
]);

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
// inlined as a reason after an em-dash ("Tesla due 06:30 — paused —
// unplugged."). The hero subline needs a clause that flows after the em-dash
// separator; this map provides exactly that.
const HERO_REASON_BY_STATUS: Partial<Record<SmartTaskListStatusId, string>> = {
  at_risk: 'at risk',
  cannot_meet: 'cannot finish in time',
  paused_unplugged: 'car unplugged',
};

const pluralize = (count: number, singular: string, plural: string): string => (
  count === 1 ? singular : plural
);

// Caller passes the sorted-by-deadline cards (the list already sorts ascending
// by `deadlineAtMs`); this resolver does not re-sort to keep things cheap and
// to honour whatever ordering the producer chose. Empty input returns null.
export const resolveDeadlinesListHero = (params: {
  cards: ReadonlyArray<DeadlinesListHeroCard>;
  formatTime: (ms: number) => string;
}): DeadlinesListHeroCopy | null => {
  const { cards, formatTime } = params;
  if (cards.length === 0) return null;

  const atRiskCards = cards.filter((card) => AT_RISK_STATUSES.has(card.statusId));
  const hasAtRisk = atRiskCards.length > 0;

  if (hasAtRisk) {
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
      ? `${atRiskCards.length} of ${cards.length} ${pluralize(cards.length, 'deadline', 'deadlines')} at risk.`
      : `${atRiskCards.length} ${pluralize(atRiskCards.length, 'deadline', 'deadlines')} at risk.`;
    const deviceName = subjectCard.deviceName.trim() || KIND_NAME_FALLBACK[subjectCard.kind];
    const reason = HERO_REASON_BY_STATUS[subjectCard.statusId] ?? 'at risk';
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

  // On-track branch — name the soonest deadline. When a first-action time is
  // known we surface it ("…, charging from 02:00") so the subline answers
  // "what runs next?" without the user opening the card.
  const soonest = cards[0];
  const headline = `${cards.length} ${pluralize(cards.length, 'deadline', 'deadlines')} on track.`;
  const deviceName = soonest.deviceName.trim() || KIND_NAME_FALLBACK[soonest.kind];
  const verb = KIND_VERB[soonest.kind];
  const readyByPart = `${deviceName} ready by ${formatTime(soonest.deadlineAtMs)}`;
  const subline = soonest.firstActionAtMs !== null
    ? `${readyByPart}, ${verb} from ${formatTime(soonest.firstActionAtMs)}.`
    : `${readyByPart}.`;
  return {
    eyebrow: 'Smart tasks',
    headline,
    subline,
    tone: 'good',
    sublineTarget: { deviceId: soonest.deviceId },
  };
};
