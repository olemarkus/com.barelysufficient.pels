import { render } from 'preact';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { ChevronRightIcon } from './icons.tsx';
import {
  deadlineLabels,
  formatSmartTaskListConfidenceChipLabel,
  resolveSmartTaskListReadyByTone,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  type SmartTaskListStatusId,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { formatTimeInTimeZone } from '../../../../shared-domain/src/utils/dateUtils.ts';
import {
  resolveDeadlinesListHero,
  type DeadlinesListHeroCopy,
} from '../../../../shared-domain/src/deadlinesListHero.ts';
import { resolveBrowserTimeZone } from '../deadlinePlanHistoryFetch.ts';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { ObjectiveProfileConfidence } from '../../../../contracts/src/objectiveProfileTypes.ts';

export type DeadlinesListCard = {
  deviceId: string;
  deviceName: string;
  kind: DeferredObjectiveSettingsKind;
  targetTemperatureC: number | null;
  targetPercent: number | null;
  createdAtMs: number;
  firstActionAtMs: number | null;
  deadlineAtMs: number;
  href: string;
  statusId: SmartTaskListStatusId;
  // Confidence band attached to the latest revision; `null` when no
  // confidence has been computed yet (pending plan or no learned profile).
  // Mirrors the live hero's confidence chip so the two surfaces stay aligned.
  confidence: ObjectiveProfileConfidence | null;
  // Pre-rendered "currently 18.5 °C" / "currently 45 %" sentence; `null` when
  // the device's current value is unknown. Resolved at the producer so the
  // view layer never branches on the device kind for unit formatting.
  currentValueLine: string | null;
};

export type DeadlinesListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; cards: DeadlinesListCard[] };

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
  return (
    <span class={`plan-chip plan-chip--${variant}`}>{label}</span>
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
  });
  const readyByTone = resolveSmartTaskListReadyByTone(card.statusId);
  return (
    <a class="deadline-list-card clickable" href={card.href} data-device-id={card.deviceId}>
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />
      <div class="deadline-list-card__header">
        <h3 class="deadline-list-card__title">{card.deviceName}</h3>
        <span class="plan-chip plan-chip--info">{labels.kindChipLabel}</span>
        <StatusChip statusId={card.statusId} />
        {confidenceLabel !== null && (
          <span class="plan-chip plan-chip--muted">{confidenceLabel}</span>
        )}
      </div>
      <div class="deadline-list-card__target">
        <span class="deadline-list-card__target-label">Target</span>
        <span class="deadline-list-card__target-value">{formatTarget(card)}</span>
        {card.currentValueLine !== null && (
          <span class="deadline-list-card__current">{card.currentValueLine}</span>
        )}
      </div>
      <dl class="deadline-list-card__when">
        <div class="deadline-list-card__when-row">
          <dt>Created</dt>
          <dd>{formatWhen(card.createdAtMs)}</dd>
        </div>
        {card.firstActionAtMs !== null && (
          <div class="deadline-list-card__when-row">
            <dt>Starts</dt>
            <dd>{formatWhen(card.firstActionAtMs)}</dd>
          </div>
        )}
        <div class={`deadline-list-card__when-row deadline-list-card__when-row--${readyByTone}`}>
          <dt>Ready by</dt>
          <dd>{formatWhen(card.deadlineAtMs)}</dd>
        </div>
      </dl>
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
        {target !== undefined ? (
          <p class="plan-hero__subline">
            <button
              type="button"
              class="deadlines-list-hero__nav-target"
              data-deadline-card-id={target.deviceId}
              onClick={() => scrollToCardByDeviceId(target.deviceId)}
            >
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
// Eyebrow is the section label ("Smart tasks", matching the populated hero's
// fixed `eyebrow` literal) and the headline is a short state-context line so
// the two slots don't render the same word twice — sibling panels (Modes /
// Usage / Budget) follow the same eyebrow=section / headline=descriptive
// rhythm. `data-tone` is omitted so the baseline picks up the default
// neutral `.pels-hero` styling (the tone enum is `good | warn | alert | info`
// — see `style.css` `.pels-hero[data-tone="…"]` rules — and the baseline
// intentionally renders no tonal accent).
const BASELINE_HEADLINE_BY_STATE: Record<'loading' | 'error' | 'empty', string> = {
  loading: 'Loading your smart tasks…',
  error: 'Smart tasks unavailable',
  empty: 'Schedule a ready-by deadline',
};

const BaselineHeader = ({ state }: { state: 'loading' | 'error' | 'empty' }) => (
  <header
    class="plan-hero pels-hero deadlines-list-hero"
    aria-labelledby="deadlines-list-baseline-headline"
  >
    <div class="plan-hero__section">
      <p class="eyebrow plan-hero__section-label">Smart tasks</p>
      <h2 class="plan-hero__headline" id="deadlines-list-baseline-headline">
        {BASELINE_HEADLINE_BY_STATE[state]}
      </h2>
    </div>
  </header>
);

const LoadingBody = () => (
  <div class="deadlines-list-body" data-state="loading">
    <div class="pels-skeleton-stack" aria-hidden="true">
      <span class="pels-skeleton pels-skeleton--card"></span>
      <span class="pels-skeleton pels-skeleton--card"></span>
    </div>
    <span class="visually-hidden">Loading smart tasks…</span>
  </div>
);

const ErrorBody = ({ message }: { message: string }) => (
  <p class="muted deadlines-list-body" data-state="error">{message}</p>
);

const EmptyBody = () => (
  <p class="muted deadlines-list-body" data-state="empty">
    No smart tasks yet. Open the Flow editor and add the
    {' '}<strong>Add heating task</strong> action
    (<em>Heat … to … °C by Ready by</em>) or the
    {' '}<strong>Add charging task</strong> action
    (<em>Charge … to … % by Ready by</em>) to schedule a device
    for a specific ready-by time.
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
    return (
      <>
        <BaselineHeader state="empty" />
        <EmptyBody />
      </>
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
