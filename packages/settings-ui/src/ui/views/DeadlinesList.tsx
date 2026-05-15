import { render } from 'preact';
import { MdElevation, MdRipple } from './materialWebJSX.tsx';
import { ChevronRightIcon } from './icons.tsx';
import {
  deadlineLabels,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  type SmartTaskListStatusId,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';

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
};

export type DeadlinesListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; cards: DeadlinesListCard[] };

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

const formatWhen = (ms: number): string => new Date(ms).toLocaleString([], DATE_TIME_OPTIONS);

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

// Canonical chip order: [kind (identity), status (live signal)].
const Card = ({ card }: { card: DeadlinesListCard }) => {
  const labels = deadlineLabels(card.kind);
  return (
    <a class="deadline-list-card clickable" href={card.href} data-device-id={card.deviceId}>
      <MdElevation aria-hidden="true" />
      <MdRipple aria-hidden="true" />
      <div class="deadline-list-card__header">
        <h3 class="deadline-list-card__title">{card.deviceName}</h3>
        <span class="plan-chip plan-chip--info">{labels.kindChipLabel}</span>
        <StatusChip statusId={card.statusId} />
      </div>
      <div class="deadline-list-card__target">
        <span class="deadline-list-card__target-label">Target</span>
        <span class="deadline-list-card__target-value">{formatTarget(card)}</span>
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
        <div class="deadline-list-card__when-row deadline-list-card__when-row--accent">
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
        No smart tasks yet. Open the Flow editor and add a heating or charging smart task
        to schedule a device for a specific ready-by time.
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
