import {
  DEVICE_WIDGET_COPY,
  formatDeviceWidgetEndedDetail,
  formatDeviceWidgetFigure,
  formatSmartTaskGoalValue,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import { hide, setLine, setVisible } from '../../../_shared/widgetDom';
import type { FlowTargets } from '../../../_shared/smartTaskCreate/flowView';
import type { CreateSmartTaskDevice } from '../../../_shared/smartTaskCreate/types';
import {
  renderActiveDetail,
  type DetailTargets,
} from '../../../_shared/smartTaskDetail/detailRender';
import type { DeviceStatus } from '../../../../packages/contracts/src/deviceStatus';
import type { DeviceWidgetPayload, DeviceWidgetTask } from '../deviceWidgetTypes';

const C = DEVICE_WIDGET_COPY;

// The Device insight widget: one device's tile, the shared smart-task detail
// panel (`widgets/_shared/smartTaskDetail`) a tap opens while the device has an
// open task, and the shared creation flow (`widgets/_shared/smartTaskCreate`) a
// tap opens while it has none.
export type RenderTargets = FlowTargets & DetailTargets & {
  root: HTMLElement;
  tileView: HTMLElement;
  tileTap: HTMLElement;
  tileChevron: HTMLElement;
  tileActionText: HTMLElement;
  tileName: HTMLElement;
  tileChip: HTMLElement;
  tileHero: HTMLElement;
  tileFigure: HTMLElement;
  tileFigureContext: HTMLElement;
  tilePower: HTMLElement;
  tileReason: HTMLElement;
  tileFact: HTMLElement;
  tileTask: HTMLElement;
  tileTaskGoal: HTMLElement;
  tileTaskChip: HTMLElement;
  tileTaskDeadline: HTMLElement;
  tileTaskWhy: HTMLElement;
  tileTaskNext: HTMLElement;
  tileMessage: HTMLElement;
};

// What the tile shows: the device's read, a message in its place (no device
// chosen yet, the read failed), or nothing yet while the first read is out.
export type TileState =
  | { kind: 'loading' }
  | { kind: 'payload'; payload: DeviceWidgetPayload }
  | { kind: 'message'; text: string };

// What a tap on the tile does: open the device's open task, start one, or
// nothing (no task support, or nothing to show yet).
export type TileAction =
  | { kind: 'open_task' }
  | { kind: 'start_task'; device: CreateSmartTaskDevice }
  | null;

export const resolveTileAction = (state: TileState): TileAction => {
  if (state.kind !== 'payload' || state.payload.state !== 'ready') return null;
  if (state.payload.task.kind === 'active') return { kind: 'open_task' };
  const { createDevice } = state.payload;
  return createDevice !== null ? { kind: 'start_task', device: createDevice } : null;
};

// The device's status tone on the shared chip: a limited or warning state is
// the only one the chip colours; running, resuming, idle and off read as plain
// status.
const STATUS_CHIP_TONE: Record<DeviceStatus['tone'], string | null> = {
  active: null,
  idle: null,
  neutral: null,
  held: 'warn',
  warning: 'warn',
  resuming: null,
};

const setChipTone = (chip: HTMLElement, tone: string | null): void => {
  /* eslint-disable no-param-reassign -- `chip` is a DOM write sink. */
  if (tone === null) delete chip.dataset.tone;
  else chip.dataset.tone = tone;
  /* eslint-enable no-param-reassign */
};

// The lead figure is the status reading; a device without one leads with its
// draw. The power line beside a reading is the draw too.
const renderHero = (
  targets: RenderTargets,
  status: DeviceStatus,
  carName: string | null,
): void => {
  const { tileHero, tileFigure, tileFigureContext, tilePower } = targets;
  if (status.reading !== null) {
    const figure = formatDeviceWidgetFigure(status.reading, carName);
    tileFigure.textContent = figure.value;
    tileFigureContext.textContent = figure.context;
    setLine(tilePower, status.powerText);
    setVisible(tileHero, true);
    return;
  }
  tileFigureContext.textContent = '';
  hide(tilePower);
  tileFigure.textContent = status.powerText ?? '';
  setVisible(tileHero, status.powerText !== null);
};

const renderTask = (targets: RenderTargets, task: DeviceWidgetTask): void => {
  const { tileTask, tileTaskGoal, tileTaskChip, tileTaskDeadline, tileTaskWhy, tileTaskNext } = targets;
  setVisible(tileTask, task.kind !== 'none');
  if (task.kind === 'none') return;
  const goal = formatSmartTaskGoalValue(task.row.targetValue, task.row.unitSymbol);
  tileTaskGoal.textContent = `${C.smartTaskTitle} · ${task.row.targetActionVerb} ${goal}`;
  if (task.kind === 'active') {
    const { row } = task;
    tileTaskChip.textContent = row.statusLabel;
    setChipTone(tileTaskChip, row.tone);
    setLine(tileTaskDeadline, `${row.etaVerb} ${row.finishLabel}`);
    setLine(tileTaskWhy, row.whyLabel);
    setLine(tileTaskNext, task.nextRunLabel);
    return;
  }
  const { row } = task;
  tileTaskChip.textContent = row.outcomeLabel;
  setChipTone(tileTaskChip, row.outcomeTone);
  setLine(tileTaskDeadline, null);
  setLine(tileTaskWhy, formatDeviceWidgetEndedDetail(row.reachedAtLabel, row.whyLabel, row.finishedLabel));
  setLine(tileTaskNext, null);
};

// The tile is one tap target while it has an action: a button to assistive
// tech, named by its own content plus what a tap does, with a chevron to the
// eye.
const renderTileAction = (targets: RenderTargets, action: TileAction): void => {
  const { tileTap, tileChevron, tileActionText } = targets;
  setVisible(tileChevron, action !== null);
  if (action === null) {
    tileTap.removeAttribute('role');
    tileTap.removeAttribute('tabindex');
    delete tileTap.dataset.action;
    tileActionText.textContent = '';
    return;
  }
  tileTap.setAttribute('role', 'button');
  tileTap.setAttribute('tabindex', '0');
  tileTap.dataset.action = action.kind;
  tileActionText.textContent = action.kind === 'open_task' ? C.openTaskAction : C.startTaskAction;
};

const renderDevice = (targets: RenderTargets, payload: Extract<DeviceWidgetPayload, { state: 'ready' }>): void => {
  const { device, task } = payload;
  const { status } = device;
  const { tileName, tileChip, tileReason, tileFact } = targets;
  tileName.textContent = device.name;
  setVisible(tileName, true);
  tileChip.textContent = status.label;
  setChipTone(tileChip, STATUS_CHIP_TONE[status.tone]);
  setVisible(tileChip, true);
  renderHero(targets, status, device.carName);
  setLine(tileReason, status.reason?.text ?? null);
  tileReason.dataset.tone = status.limited ? 'warn' : 'muted';
  // With a reading, the fact line words the figure the tile already leads with
  // ("54.0 °C · target 65 °C", "Charging · 58 % · level 16 A"); the chip carries
  // the state. Without one it is the tile's only fact ("Unplugged").
  setLine(tileFact, status.reading === null ? status.factText : null);
  renderTask(targets, task);
};

const hideDevice = (targets: RenderTargets): void => {
  for (const element of [
    targets.tileChip, targets.tileHero, targets.tileReason, targets.tileFact, targets.tileTask,
  ]) hide(element);
};

const resolveMessage = (state: Exclude<TileState, { kind: 'loading' }>): string | null => {
  if (state.kind === 'message') return state.text;
  if (state.payload.state === 'not_managed') return C.notManaged;
  return state.payload.state === 'starting' ? C.starting : null;
};

// Which of the widget's views is up: the tile, the open task's detail panel,
// or the creation flow (which renders itself).
export type DeviceView = 'tile' | 'detail' | 'flow';

/** The tile and the detail panel; each is shown only while it is the view. */
export const renderDeviceView = (
  targets: RenderTargets,
  state: TileState,
  deviceName: string | null,
  view: DeviceView,
): void => {
  setVisible(targets.tileView, view === 'tile');
  setVisible(targets.detailView, view === 'detail');
  if (view === 'detail') {
    if (state.kind === 'payload' && state.payload.state === 'ready' && state.payload.task.kind === 'active') {
      renderActiveDetail(targets, state.payload.task.row);
    }
    return;
  }
  if (view === 'flow') return;
  renderTileAction(targets, resolveTileAction(state));
  if (state.kind === 'payload' && state.payload.state === 'ready') {
    hide(targets.tileMessage);
    renderDevice(targets, state.payload);
    return;
  }
  hideDevice(targets);
  // The chosen device's name stays as the heading, so the user knows which
  // tile this is even when PELS has nothing to say about it.
  const { tileName } = targets;
  tileName.textContent = deviceName ?? '';
  setVisible(tileName, deviceName !== null);
  if (state.kind === 'loading') {
    hide(targets.tileMessage);
    return;
  }
  setLine(targets.tileMessage, resolveMessage(state));
};
