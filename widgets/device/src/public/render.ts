import {
  DEVICE_WIDGET_COPY,
  formatDeviceWidgetFigure,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import { hide, setLine, setVisible } from '../../../_shared/widgetDom';
import type { FlowTargets } from '../../../_shared/smartTaskCreate/flowView';
import type { DeviceStatus } from '../../../../packages/contracts/src/deviceStatus';
import type { DeviceWidgetPayload, DeviceWidgetTask } from '../deviceWidgetTypes';

const C = DEVICE_WIDGET_COPY;

// The Device widget: one device's tile, and the shared creation flow
// (`widgets/_shared/smartTaskCreate`) behind its "+ Smart task".
export type RenderTargets = FlowTargets & {
  root: HTMLElement;
  tileView: HTMLElement;
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
  tileFoot: HTMLElement;
  tileAddTaskBtn: HTMLButtonElement;
  tileAddTaskLabel: HTMLElement;
  tileMessage: HTMLElement;
};

// What the tile shows: the device's read, a message in its place (no device
// chosen yet, the read failed), or nothing yet while the first read is out.
export type TileState =
  | { kind: 'loading' }
  | { kind: 'payload'; payload: DeviceWidgetPayload }
  | { kind: 'message'; text: string };

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
  tileTaskGoal.textContent = `${C.smartTaskTitle} · ${task.goalLabel}`;
  if (task.kind === 'active') {
    tileTaskChip.textContent = task.statusLabel;
    tileTaskChip.dataset.tone = task.tone;
    setLine(tileTaskDeadline, task.deadlineLabel);
    setLine(tileTaskWhy, task.whyLabel);
    setLine(tileTaskNext, task.nextRunLabel);
    return;
  }
  tileTaskChip.textContent = task.outcomeLabel;
  tileTaskChip.dataset.tone = task.tone;
  setLine(tileTaskDeadline, null);
  setLine(tileTaskWhy, task.detailLabel);
  setLine(tileTaskNext, null);
};

const renderDevice = (targets: RenderTargets, payload: Extract<DeviceWidgetPayload, { state: 'ready' }>): void => {
  const { device, task, createDevice } = payload;
  const { status } = device;
  const { tileName, tileChip, tileReason, tileFact, tileFoot, tileAddTaskLabel } = targets;
  tileName.textContent = device.name;
  setVisible(tileName, true);
  tileChip.textContent = status.label;
  tileChip.dataset.tone = status.tone;
  setVisible(tileChip, true);
  renderHero(targets, status, device.carName);
  setLine(tileReason, status.reason?.text ?? null);
  tileReason.dataset.tone = status.limited ? 'warn' : 'muted';
  // With a reading, the fact line words the figure the tile already leads with
  // ("54.0 °C · target 65 °C", "Charging · 58 % · level 16 A"); the chip carries
  // the state. Without one it is the tile's only fact ("Unplugged").
  setLine(tileFact, status.reading === null ? status.factText : null);
  renderTask(targets, task);
  tileAddTaskLabel.textContent = C.addSmartTask;
  setVisible(tileFoot, createDevice !== null);
};

const hideDevice = (targets: RenderTargets): void => {
  for (const element of [
    targets.tileChip, targets.tileHero, targets.tileReason, targets.tileFact, targets.tileTask, targets.tileFoot,
  ]) hide(element);
};

const resolveMessage = (state: Exclude<TileState, { kind: 'loading' }>): string | null => {
  if (state.kind === 'message') return state.text;
  if (state.payload.state === 'not_managed') return C.notManaged;
  return state.payload.state === 'starting' ? C.starting : null;
};

/** The tile, shown while the creation flow is closed. */
export const renderTileView = (
  targets: RenderTargets,
  state: TileState,
  deviceName: string | null,
  visible: boolean,
): void => {
  setVisible(targets.tileView, visible);
  if (!visible) return;
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
