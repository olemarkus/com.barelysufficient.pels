import { render, type ComponentChildren } from 'preact';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { ChevronRightIcon } from './icons.tsx';
import {
  deadlineLabels,
  formatSmartTaskListConfidenceChipLabel,
  resolveSmartTaskListReadyByTone,
  resolveSmartTaskListReadyByStatusWord,
  SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL,
  SMART_TASK_LIST_EMPTY_COPY,
  SMART_TASK_LIST_ROW_LABELS,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  type SmartTaskListStatusId,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatTimeInTimeZone } from '../../../../shared-domain/src/utils/dateUtils.ts';
import {
  DEADLINES_LIST_BASELINE_EYEBROW,
  DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE,
  DEADLINES_LIST_BETWEEN_RUNS_BODY,
  resolveDeadlinesListHero,
  type DeadlinesListBaselineState,
  type DeadlinesListHeroCopy,
} from '../../../../shared-domain/src/deadlinesListHero.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { resolveBrowserTimeZone } from '../deadlinePlanHistoryFetch.ts';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { ObjectiveProfileConfidence } from '../../../../contracts/src/objectiveProfileTypes.ts';

export type DeadlinesListCard = {
  deviceId: string;
  deviceName: string;
  kind: DeferredObjectiveSettingsKind;
  targetTemperatureC: number | null;
  targetPercent: number | null;
  firstActionAtMs: number | null;
  deadlineAtMs: number;
  href: string;
  statusId: SmartTaskListStatusId;
  // Confidence band attached to the latest revision; `null` when no
  // confidence has been computed yet (pending plan or no learned profile).
  // Mirrors the live hero's confidence chip so the two surfaces stay aligned.
  confidence: ObjectiveProfileConfidence | null;
  // True only during genuine cold-start; gates the "Estimating" chip so a
  // learned-but-forever-`low` thermal rate doesn't nag a settled task.
  learning: boolean;
  extraPermissionsValue: string | null;
  // Pre-rendered "currently 18.5 °C" / "currently 45 %" sentence; `null` when
  // the device's current value is unknown. Resolved at the producer so the
  // view layer never branches on the device kind for unit formatting.
  currentValueLine: string | null;
};

export type DeadlinesListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  // `historyPresent` distinguishes the two zero-active-card empty states: a
  // true first run (no active cards AND no past-tasks history) keeps the
  // "Add your first smart task" invitation + Flow setup copy, whereas a
  // between-runs lull (no active cards but the Past tasks archive has finished
  // runs) renders the calmer "No smart tasks scheduled" header + a pointer to
  // Past tasks. Optional because the history fetch resolves independently of —
  // and must not gate — the active list's first paint; `undefined` means
  // "history not known yet", which renders the conservative first-run copy
  // until the history fetch lands and the controller re-renders. Ignored when
  // `cards` is non-empty (the populated hero owns that case).
  | { status: 'ready'; cards: DeadlinesListCard[]; historyPresent?: boolean };

// Route both list surfaces (active + past) through the same shared formatter
// so the date/time shape can't drift again. Time-zone is resolved at render
// time via the existing `resolveBrowserTimeZone` helper so the past-tasks
// surface (which gets its zone plumbed via `DeadlinesHistoryListState.timeZone`)
// stays consistent with the active list.
const formatWhen = (ms: number): string => formatSmartTaskListDateTime(ms, resolveBrowserTimeZone());

// Short HH:MM formatter for the populated-state hero subline. The hero is a
// glance read ("EV ready by 06:30, charging from 02:00") so the full
// "Sat 16 May 06:30" date stamp from `formatWhen` would crowd the line — the
// user is looking at *today's* upcoming deadlines, not picking a date.
const formatHourMinute = (ms: number): string => {
  const zone = resolveBrowserTimeZone();
  return formatTimeInTimeZone(
    new Date(ms),
    { hour: '2-digit', minute: '2-digit', hour12: false },
    zone,
  );
};

const formatTarget = (card: DeadlinesListCard): string => {
  const labels = deadlineLabels(card.kind);
  if (card.kind === 'temperature' && card.targetTemperatureC !== null) {
    const value = Number.isInteger(card.targetTemperatureC)
      ? String(card.targetTemperatureC)
      : card.targetTemperatureC.toFixed(1);
    return `${value} ${labels.targetUnit}`;
  }
  if (card.kind === 'ev_soc' && card.targetPercent !== null) {
    return `${Math.round(card.targetPercent)} ${labels.targetUnit}`;
  }
  return '—';
};

const StatusChip = ({ statusId }: { statusId: SmartTaskListStatusId }) => {
  const label = SMART_TASK_LIST_STATUS_LABELS[statusId];
  const variant = SMART_TASK_LIST_STATUS_CHIP_VARIANT[statusId];
  // Opacity pulse signals the planner is still working — the same chip can
  // sit "Building plan…" for tens of seconds while prices/samples arrive, and
  // a static pill reads identically whether planning just started or has
  // been stuck. Only the building_plan state carries the pulse; every other
  // list status is a settled state. Same `data-pulse` attribute the pending
  // hero chip uses so the CSS rule (`packages/settings-ui/public/style.css`,
  // `.plan-chip[data-pulse="true"]`) lights both surfaces uniformly.
  const pulse = statusId === 'building_plan' ? 'true' : undefined;
  return (
    <span class={`plan-chip plan-chip--${variant}`} data-pulse={pulse}>{label}</span>
  );
};

// Canonical chip order: [kind, status, ?confidence]. The confidence chip
// matches the live hero's styling (`muted` tone) so the same trust signal
// lands on both surfaces. Suppressed when no confidence chip copy is available
// (pending plans, high confidence, no learned profile, or cannot-finish cards)
// rather than fabricating a label.
//
// The "Ready by" accent row mirrors the status chip tone so an at-risk /
// cannot-meet card never paints the deadline in success-green next to a
// red / amber pill. Resolved producer-side so the view dispatches on a
// stable slug instead of branching on `statusId`.
const Card = ({ card }: { card: DeadlinesListCard }) => {
  const labels = deadlineLabels(card.kind);
  const confidenceLabel = formatSmartTaskListConfidenceChipLabel({
    confidence: card.confidence,
    statusId: card.statusId,
    learning: card.learning,
  });
  const readyByTone = resolveSmartTaskListReadyByTone(card.statusId);
  // Inline status word for non-healthy states so the at-risk / cannot-finish /
  // paused signal on the Ready-by line isn't carried by colour alone. null for
  // healthy / pending / queued / satisfied (resolved producer-side; the view
  // never branches on `statusId`).
  const readyByStatusWord = resolveSmartTaskListReadyByStatusWord(card.statusId);
  return (
    <a class="pels-surface-card deadline-list-card clickable" href={card.href} data-device-id={card.deviceId} data-interactive>
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />
      <div class="deadline-list-card__header">
        <h3 class="deadline-list-card__title pels-text-card-title">{formatDisplayDeviceName(card.deviceName)}</h3>
        {/* Chips live in their own flex group so at 320 px they wrap below the
            title as a coherent block instead of one chip dangling beside it.
            Within the group they wrap among themselves; the group never splits
            a single chip onto the title's row. */}
        <div class="deadline-list-card__chips">
          <span class="plan-chip plan-chip--muted">{labels.kindChipLabel}</span>
          <StatusChip statusId={card.statusId} />
          {confidenceLabel !== null && (
            <span class="plan-chip plan-chip--muted">{confidenceLabel}</span>
          )}
        </div>
      </div>
      <div class="deadline-list-card__target">
        <span class="deadline-list-card__target-label">{SMART_TASK_LIST_ROW_LABELS.target}</span>
        <span class="deadline-list-card__target-value">{formatTarget(card)}</span>
        {card.currentValueLine !== null && (
          <span class="deadline-list-card__current">{card.currentValueLine}</span>
        )}
      </div>
      <dl class="deadline-list-card__when">
        {card.firstActionAtMs !== null && (
          <div class="deadline-list-card__when-row">
            <dt>{SMART_TASK_LIST_ROW_LABELS.starts}</dt>
            <dd>{formatWhen(card.firstActionAtMs)}</dd>
          </div>
        )}
        <div class={`deadline-list-card__when-row deadline-list-card__when-row--${readyByTone}`}>
          <dt>{SMART_TASK_LIST_ROW_LABELS.readyBy}</dt>
          <dd>
            {formatWhen(card.deadlineAtMs)}
            {readyByStatusWord !== null && ` — ${readyByStatusWord}`}
          </dd>
        </div>
      </dl>
      {/* Extra permissions are pulled out of the timestamp `<dl>` because the
          joined value ("May go over daily budget · May limit lower-priority
          devices") is much longer than any `dd` in that grid and previously
          wrapped into a narrow ragged column — reading as overflow rather
          than deliberate metadata. The strip spans the content column so the
          value gets the full card width with a muted eyebrow label, and at
          320 px portrait the value wraps cleanly on its own line instead of
          fighting the dt/dd grid. */}
      {card.extraPermissionsValue !== null && (
        <div class="deadline-list-card__extras">
          <span class="deadline-list-card__extras-label eyebrow">
            {SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL}
          </span>
          <span class="deadline-list-card__extras-value">
            {card.extraPermissionsValue}
          </span>
        </div>
      )}
      <ChevronRightIcon class="deadline-list-card__chevron" />
    </a>
  );
};

// When the hero subline names a specific card, scroll that card into view.
// The cards in the list each carry `data-device-id`; the resolver forwards
// the deviceId via `sublineTarget` so this handler can locate the row
// without re-deriving the slug. `scrollIntoView` is no-op in jsdom (tests
// rely on the click landing, not the scroll itself).
const scrollToCardByDeviceId = (deviceId: string): void => {
  // `CSS.escape` is unavailable under jsdom and we can't rely on it across
  // every settings-UI runtime; iterate over the candidate rows and match the
  // attribute directly so any deviceId shape (including ones that aren't
  // valid CSS identifiers) resolves.
  const card = Array.from(
    document.querySelectorAll<HTMLElement>('.deadline-list-card'),
  ).find((el) => el.dataset.deviceId === deviceId);
  if (!card) return;
  // Smooth-scroll only — do not call `card.focus()`. Stealing focus to the
  // anchor moves the focus ring away from the hero button the user just
  // activated and leaves the named card stuck in its hover/focus styling
  // (`.deadline-list-card:focus-visible` paints a permanent accent rim until
  // the user clicks elsewhere). The scroll is the visual target on its own.
  card.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
};

// Populated-state hero. Single-signal headline + one named subline; the
// shape matches the four sibling panels (Overview / Budget / Usage / History
// detail) so the user reads the same answer-on-arrival rhythm everywhere.
// Empty-state stays a plain muted paragraph — the resolver returns `null` in
// that case so this component never renders for new users.
const Hero = ({ copy }: { copy: DeadlinesListHeroCopy }) => {
  const target = copy.sublineTarget;
  return (
    <section
      class="plan-hero pels-hero deadlines-list-hero"
      data-tone={copy.tone}
      aria-labelledby="deadlines-list-hero-headline"
    >
      <div class="plan-hero__section">
        <p class="eyebrow plan-hero__section-label">{copy.eyebrow}</p>
        <h2 class="plan-hero__headline" id="deadlines-list-hero-headline">{copy.headline}</h2>
        {/* Attention heroes (at-risk / cannot-meet / paused) carry their
            severity in the canonical per-card status chip — the hero surface
            itself is a plain neutral card, so the chip is the colour cue. The
            calm `good` hero has no `subjectStatusId` and stays chip-less. */}
        {copy.subjectStatusId !== undefined ? (
          <div class="plan-hero__chips">
            <StatusChip statusId={copy.subjectStatusId} />
          </div>
        ) : null}
        {target !== undefined ? (
          <p class="plan-hero__subline">
            {/* Flat dark-theme text + chevron affordance — no inverted/light
                container. The subline reads as ordinary de-emphasised hero
                body copy (inheriting `.plan-hero__subline` supporting tone);
                the trailing chevron is the only tappability cue, and an
                `MdRipple` supplies press feedback so we don't carry a
                permanent background. The button is the 48dp finger-safe hit
                area (`min-height` token + `position: relative` to anchor the
                ripple). */}
            <button
              type="button"
              class="deadlines-list-hero__nav-target hy-nostyle"
              data-deadline-card-id={target.deviceId}
              onClick={() => scrollToCardByDeviceId(target.deviceId)}
            >
              <MdRipple aria-hidden="true" />
              <span class="deadlines-list-hero__nav-target-text">{copy.subline}</span>
              <span class="deadlines-list-hero__nav-target-chevron" aria-hidden="true">›</span>
            </button>
          </p>
        ) : (
          <p class="plan-hero__subline">{copy.subline}</p>
        )}
      </div>
    </section>
  );
};

// Baseline header rendered in loading / error / empty states. The four sibling
// panels (Overview / Budget / Usage / Settings) all keep a persistent header
// when their body is in a non-populated state; Smart tasks lost that header
// when the v2.7.2 hero PR dropped the static `<h2>Smart tasks</h2>` (TODO
// #1041). Reusing the `.pels-hero` / `.plan-hero` primitive keeps the rhythm
// identical to the populated hero (which already supplies eyebrow + headline),
// so the header height stays consistent as the body swaps below.
//
// Eyebrow is the section label (matching the populated hero's fixed `eyebrow`
// literal via `DEADLINES_LIST_BASELINE_EYEBROW`) and the headline is a short
// state-context line so the two slots don't render the same word twice —
// sibling panels (Modes / Usage / Budget) follow the same eyebrow=section /
// headline=descriptive rhythm. `data-tone` is omitted so the baseline picks up
// the default neutral `.pels-hero` styling (the tone enum is
// `good | warn | alert | info` — see `style.css` `.pels-hero[data-tone="…"]`
// rules — and the baseline intentionally renders no tonal accent).
//
// `children` is the optional in-hero body slot. The empty / between-runs
// states render their instructional copy INSIDE the hero card (PR2 surface
// ladder, spec §5) rather than as a bare `<p class="muted">` floating on the
// page background — the instructions are the most legible block on a first
// run, so they belong on the hero surface at a supporting tone, not the
// dimmest tier on bare canvas.
const BaselineHeader = ({
  state,
  children,
}: {
  state: DeadlinesListBaselineState;
  children?: ComponentChildren;
}) => (
  <header
    class="plan-hero pels-hero deadlines-list-hero"
    aria-labelledby="deadlines-list-baseline-headline"
  >
    <div class="plan-hero__section">
      <p class="eyebrow plan-hero__section-label">{DEADLINES_LIST_BASELINE_EYEBROW}</p>
      <h2 class="plan-hero__headline" id="deadlines-list-baseline-headline">
        {DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE[state]}
      </h2>
      {children}
    </div>
  </header>
);

const LoadingBody = () => (
  <div class="deadlines-list-body" data-state="loading">
    <div class="pels-skeleton-stack" aria-hidden="true">
      <span class="pels-skeleton pels-skeleton--card"></span>
      <span class="pels-skeleton pels-skeleton--card"></span>
    </div>
    <span class="visually-hidden">{DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE.loading}</span>
  </div>
);

const ErrorBody = ({ message }: { message: string }) => (
  <p class="muted deadlines-list-body" data-state="error">{message}</p>
);

// First-run instructional copy. Rendered INSIDE the hero `__section` (PR2
// surface ladder, spec §5/§6) so it sits on the hero card, not bare on the
// page background. The tone is `--action` (primary on-surface, the most
// legible body tier) rather than the dimmest `--muted` — on a first run these
// Flow-setup instructions are the single most important block on the surface,
// so they must read as the loudest copy. Mirrors the pending-hero `metaLine`
// precedent (`.plan-hero__subline--action`) in DeadlinePlan.tsx, which already
// promotes the most-actionable string out of the muted tier.
const EmptyBody = () => (
  <p class="plan-hero__subline plan-hero__subline--action deadlines-list-body" data-state="empty">
    {SMART_TASK_LIST_EMPTY_COPY.intro}{' '}
    <strong>{SMART_TASK_LIST_EMPTY_COPY.heatingAction}</strong>{' '}
    {SMART_TASK_LIST_EMPTY_COPY.actionWord}{' '}
    <em>{SMART_TASK_LIST_EMPTY_COPY.heatingExample}</em>{' '}
    {SMART_TASK_LIST_EMPTY_COPY.conjunction}{' '}
    <strong>{SMART_TASK_LIST_EMPTY_COPY.chargingAction}</strong>{' '}
    {SMART_TASK_LIST_EMPTY_COPY.actionWord}{' '}
    <em>{SMART_TASK_LIST_EMPTY_COPY.chargingExample}</em>{' '}
    {SMART_TASK_LIST_EMPTY_COPY.outro}{' '}
    {SMART_TASK_LIST_EMPTY_COPY.widgetLead}{' '}
    <strong>{SMART_TASK_LIST_EMPTY_COPY.widgetName}</strong>{' '}
    {SMART_TASK_LIST_EMPTY_COPY.widgetOutro}
  </p>
);

// Between-runs body: no active tasks, but the Past tasks archive below has
// finished runs. The user has used smart tasks before, so the first-run Flow
// setup instructions would be condescending and the "first" / "yet" framing
// would erase their history. A single calm sentence points them at the archive
// instead. Copy is sourced from shared-domain so runtime log breadcrumbs and
// the UI render the same string (Rule 4 — UI text shared with logs). Rendered
// in the hero `__section` at the supporting tone (PR2 surface ladder) so it
// reads as ordinary hero body copy rather than bare muted text on the canvas.
const BetweenRunsBody = () => (
  <p class="plan-hero__subline deadlines-list-body" data-state="empty-between-runs">
    {DEADLINES_LIST_BETWEEN_RUNS_BODY}
  </p>
);

const DeadlinesListRoot = ({ state }: { state: DeadlinesListState }) => {
  if (state.status === 'loading') {
    return (
      <>
        <BaselineHeader state="loading" />
        <LoadingBody />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <BaselineHeader state="error" />
        <ErrorBody message={state.message} />
      </>
    );
  }
  if (state.cards.length === 0) {
    // No active cards. Branch on whether the Past tasks archive has finished
    // runs: a true first run (no history) keeps the "Add your first smart
    // task" invitation + Flow setup copy, while a between-runs lull (history
    // exists) renders the calmer "No smart tasks scheduled" header + a pointer
    // to Past tasks — never "first" / "yet". `historyPresent` is undefined
    // until the independent history fetch resolves, so the conservative
    // first-run copy shows until the controller re-renders with the flag.
    if (state.historyPresent === true) {
      return (
        <BaselineHeader state="empty_between_runs">
          <BetweenRunsBody />
        </BaselineHeader>
      );
    }
    return (
      <BaselineHeader state="empty">
        <EmptyBody />
      </BaselineHeader>
    );
  }
  const heroCopy = resolveDeadlinesListHero({
    cards: state.cards,
    formatTime: formatHourMinute,
  });
  // Populated hero already owns the eyebrow "Smart tasks" + headline slot, so
  // the baseline header is suppressed here to avoid a double-header. If the
  // resolver returns `null` for any future card shape, fall back to the
  // baseline header (reusing the `empty` headline copy — it reads as a calm
  // "you have smart tasks; here they are" prompt without claiming a state).
  return (
    <>
      {heroCopy !== null ? <Hero copy={heroCopy} /> : <BaselineHeader state="empty" />}
      <div class="deadline-list">
        {state.cards.map((card) => (
          <Card key={card.deviceId} card={card} />
        ))}
      </div>
    </>
  );
};

export const renderDeadlinesList = (surface: HTMLElement, state: DeadlinesListState): void => {
  render(<DeadlinesListRoot state={state} />, surface);
};
