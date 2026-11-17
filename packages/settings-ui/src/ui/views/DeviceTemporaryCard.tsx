import { OVERRIDE_COPY } from '../deviceOverrideDraft.ts';
import {
  OverrideForm, type DeviceOverrideCardActions, type DeviceOverrideCardState, type OverrideScheduleLink,
} from './DeviceOverrideCard.tsx';
import { MdList, MdListItem } from './materialWebJSX.tsx';

/**
 * The device page's Temporary card, under the status header: what applies to
 * this device for a limited time. One Material list row each for its override,
 * its Smart task and its schedules; the whole row is the action. The Override
 * row opens its form inside the card.
 */
export const TEMPORARY_COPY = {
  title: 'Temporary',
  overrideTitle: 'Override',
  overrideHint: 'Hold a temperature until a time',
  overrideSet: 'Set',
  overrideChange: 'Change',
  smartTaskTitle: 'Smart task',
  smartTaskHint: 'Reach a target by a time, at the cheapest hours',
  smartTaskAdd: 'Add',
  smartTaskView: 'View',
  schedulesTitle: 'Schedules',
  schedulesNone: 'None for this device',
  schedulesAdd: 'Add',
  schedulesView: 'View',
  schedulesUnmanaged: 'not running while Managed is off',
} as const;

export type TemporarySmartTaskRow =
  | { kind: 'open'; deviceId: string; line: string }
  | { kind: 'add'; deviceId: string };

export type TemporarySchedulesRow = {
  deviceId: string;
  count: number;
  /** When the next one runs, as the schedule owner words it; empty when none is due. */
  nextLabel: string;
  /** Schedules that are switched on and have a trigger left. */
  live: number;
  /** Of those, the ones the schedule owner says cannot run. */
  needsAttention: number;
  /** Whether PELS manages the device; a schedule for an unmanaged device does not run. */
  managed: boolean;
  /** What a new schedule for the device starts as, when it has an Override row. */
  override: OverrideScheduleLink | null;
};

export type DeviceTemporaryCardProps = {
  override: DeviceOverrideCardState | null;
  smartTask: TemporarySmartTaskRow | null;
  schedules: TemporarySchedulesRow | null;
  actions: DeviceOverrideCardActions;
};

type RowProps = {
  title: string;
  line: string;
  action: string | null;
  /** Attributes and handlers for the row; a row without an action is plain text. */
  target?: Record<string, unknown>;
};

const Row = ({ title, line, action, target }: RowProps) => (
  <MdListItem type={action === null ? 'text' : 'button'} class="device-detail-temporary__row" {...target}>
    <span slot="headline">{title}</span>
    <span slot="supporting-text">{line}</span>
    {action !== null && <span slot="trailing-supporting-text" class="device-detail-temporary__action">{action}</span>}
  </MdListItem>
);

const OverrideRow = ({ state, actions }: { state: DeviceOverrideCardState; actions: DeviceOverrideCardActions }) => {
  const title = TEMPORARY_COPY.overrideTitle;
  if (state.kind === 'blocked') return <Row title={title} line={OVERRIDE_COPY.blocked} action={null} />;
  const target = { 'data-override-action': 'start', onClick: actions.onStart };
  if (state.kind === 'active') {
    return (
      <Row title={title} line={state.line} action={TEMPORARY_COPY.overrideChange}
        target={{ ...target, 'data-override-active': '' }} />
    );
  }
  return <Row title={title} line={TEMPORARY_COPY.overrideHint} action={TEMPORARY_COPY.overrideSet} target={target} />;
};

const SmartTaskRow = ({ row }: { row: TemporarySmartTaskRow }) => (row.kind === 'open'
  ? <Row title={TEMPORARY_COPY.smartTaskTitle} line={row.line} action={TEMPORARY_COPY.smartTaskView}
    target={{ 'data-smart-task-view': row.deviceId }} />
  : <Row title={TEMPORARY_COPY.smartTaskTitle} line={TEMPORARY_COPY.smartTaskHint}
    action={TEMPORARY_COPY.smartTaskAdd} target={{ 'data-smart-task-create': row.deviceId }} />);

const schedulesLine = (row: TemporarySchedulesRow): string => {
  if (row.count === 0) return TEMPORARY_COPY.schedulesNone;
  const count = `${row.count} for this device`;
  // A schedule that will not run says so here, on the page that holds the
  // Managed switch, before the night it was meant for.
  if (row.live > 0 && !row.managed) return `${count} · ${TEMPORARY_COPY.schedulesUnmanaged}`;
  if (row.needsAttention > 0) {
    return `${count} · ${row.needsAttention} ${row.needsAttention === 1 ? 'needs' : 'need'} attention`;
  }
  return row.nextLabel === '' ? count : `${count} · next ${row.nextLabel}`;
};

const SchedulesRow = ({ row }: { row: TemporarySchedulesRow }) => {
  if (row.count > 0) {
    return (
      <Row title={TEMPORARY_COPY.schedulesTitle} line={schedulesLine(row)} action={TEMPORARY_COPY.schedulesView}
        target={{ 'data-open-schedules': '', 'data-temporary-schedules': 'view' }} />
    );
  }
  const target = {
    'data-open-schedules': '', 'data-temporary-schedules': 'add', 'data-schedule-device': row.deviceId,
    ...(row.override ? {
      'data-schedule-action': 'override', 'data-schedule-temperature': row.override.temperatureC ?? undefined,
    } : {}),
  };
  return (
    <Row title={TEMPORARY_COPY.schedulesTitle} line={schedulesLine(row)} action={TEMPORARY_COPY.schedulesAdd}
      target={target} />
  );
};

export const DeviceTemporaryCard = ({ override, smartTask, schedules, actions }: DeviceTemporaryCardProps) => {
  const editing = override?.kind === 'editing' ? override : null;
  return (
    <>
      <h3 class="pels-text-card-title">{TEMPORARY_COPY.title}</h3>
      {editing
        ? <>
          <p class="pels-text-settings-label">{TEMPORARY_COPY.overrideTitle}</p>
          <OverrideForm state={editing} actions={actions} />
        </>
        : <MdList class="device-detail-temporary__list">
          {override && <OverrideRow state={override} actions={actions} />}
          {smartTask && <SmartTaskRow row={smartTask} />}
          {schedules && <SchedulesRow row={schedules} />}
        </MdList>}
    </>
  );
};
