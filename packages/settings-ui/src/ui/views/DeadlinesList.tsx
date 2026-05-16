import { render } from 'preact';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { ChevronRightIcon } from './icons.tsx';
import {
  deadlineLabels,
  formatConfidenceChipLabel,
  resolveSmartTaskListReadyByTone,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  type SmartTaskListStatusId,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatSmartTaskListDateTime } from '../../../../shared-domain/src/deferredPlanHistory.ts';
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
// lands on both surfaces. Suppressed when no confidence band is available
// (pending plans, no learned profile yet) rather than fabricating a label.
//
// The "Ready by" accent row mirrors the status chip tone so an at-risk /
// cannot-meet card never paints the deadline in success-green next to a
// red / amber pill. Resolved producer-side so the view dispatches on a
// stable slug instead of branching on `statusId`.
const Card = ({ card }: { card: DeadlinesListCard }) => {
  const labels = deadlineLabels(card.kind);
  const confidenceLabel = formatConfidenceChipLabel(card.confidence);
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

const DeadlinesListRoot = ({ state }: { state: DeadlinesListState }) => {
  if (state.status === 'loading') {
    return <p class="muted">Loading smart tasks…</p>;
  }
  if (state.status === 'error') {
    return <p class="muted">{state.message}</p>;
  }
  if (state.cards.length === 0) {
    return (
      <p class="muted">
        No smart tasks yet. Open the Flow editor and add the
        {' '}<strong>Add heating task</strong> action
        (<em>Heat … to … °C by Ready by</em>) or the
        {' '}<strong>Add charging task</strong> action
        (<em>Charge … to … % by Ready by</em>) to schedule a device
        for a specific ready-by time.
      </p>
    );
  }
  return (
    <div class="deadline-list">
      {state.cards.map((card) => (
        <Card key={card.deviceId} card={card} />
      ))}
    </div>
  );
};

export const renderDeadlinesList = (surface: HTMLElement, state: DeadlinesListState): void => {
  render(<DeadlinesListRoot state={state} />, surface);
};
