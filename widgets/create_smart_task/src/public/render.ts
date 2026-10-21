import {
  CREATE_SMART_TASK_WIDGET_COPY,
  formatSmartTaskNowValueLine,
  formatSmartTaskUnknownNowValueLine,
} from '../../../../packages/shared-domain/src/deadlineLabels';
import {
  SMART_TASK_DEVICE_PICKER_COPY,
  resolveSmartTaskDeviceGroup,
  resolveSmartTaskDeviceGroupIconLabel,
} from '../../../../packages/shared-domain/src/smartTaskDevicePickerOrder';
import { clearChildren, setLine, setVisible } from '../../../_shared/widgetDom';
import type { FlowTargets } from '../../../_shared/smartTaskCreate/flowView';
import type {
  CreateSmartTaskDevice,
  CreateSmartTaskDevicesPayload,
} from '../createSmartTaskWidgetTypes';

const C = CREATE_SMART_TASK_WIDGET_COPY;

// The Create smart task widget: a device list, and the shared creation flow
// (`widgets/_shared/smartTaskCreate`) for the chosen device.
export type RenderTargets = FlowTargets & {
  root: HTMLElement;
  pickerView: HTMLElement;
  pickerPrompt: HTMLElement;
  pickerCaption: HTMLElement;
  pickerList: HTMLElement;
  pickerEmpty: HTMLElement;
  pickerEmptyHint: HTMLElement;
  pickerRetryBtn: HTMLButtonElement;
  deviceTemplate: HTMLTemplateElement;
};

// ─── Picker ──────────────────────────────────────────────────────────────────

const renderDeviceRow = (
  template: HTMLTemplateElement,
  device: CreateSmartTaskDevice,
): HTMLElement => {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const li = fragment.querySelector('.row');
  if (!(li instanceof HTMLElement)) throw new Error('device template missing .row');
  const button = li.querySelector('[data-device-button]');
  if (button instanceof HTMLElement) {
    button.dataset.deviceId = device.deviceId;
    button.setAttribute('aria-label', `${device.deviceName}, ${C.pickDevicePrompt}`);
  }
  const iconEl = li.querySelector('[data-device-icon]');
  if (iconEl instanceof HTMLElement) {
    // The CSS picks the glyph mask from `data-group`; the aria-label names the
    // device family so the icon isn't an unlabelled image to a screen reader.
    const group = resolveSmartTaskDeviceGroup(device);
    iconEl.dataset.group = group;
    iconEl.setAttribute('aria-label', resolveSmartTaskDeviceGroupIconLabel(group));
  }
  const nameEl = li.querySelector('[data-device-name]');
  const metaEl = li.querySelector('[data-device-meta]');
  if (nameEl instanceof HTMLElement) nameEl.textContent = device.deviceName;
  if (metaEl instanceof HTMLElement) {
    // "Now 42%" / "Now 48 °C" hint (shared formatter), or an explicit unknown
    // state when the device has not reported a reading.
    metaEl.textContent = formatSmartTaskNowValueLine({
      currentValue: device.currentValue,
      unitSymbol: device.unitSymbol,
    }) ?? formatSmartTaskUnknownNowValueLine(device.kind);
  }
  return li;
};

const renderPicker = (targets: RenderTargets, payload: CreateSmartTaskDevicesPayload | null): void => {
  const {
    pickerPrompt, pickerCaption, pickerList, pickerEmpty, pickerEmptyHint, pickerRetryBtn, deviceTemplate,
  } = targets;
  pickerPrompt.textContent = C.pickDevicePrompt;
  clearChildren(pickerList);
  if (!payload || payload.state !== 'ready') {
    // Two non-ready shapes share the empty-state layout but read differently:
    // `error` (a failed fetch, or a null payload before the first load) offers
    // tap-to-retry; `empty` (no eligible devices) is a calm dead-end with an
    // eligibility hint and no retry — retrying would change nothing.
    const isError = !payload || payload.state === 'error';
    // The empty state's own hint already explains eligibility — don't double up
    // with the caption.
    setLine(pickerCaption, null);
    pickerList.hidden = true;
    pickerEmpty.hidden = false;
    pickerEmpty.textContent = payload?.state === 'empty' ? payload.subtitle : C.loadError;
    const hint = payload?.state === 'empty' ? payload.hint : null;
    if (hint) {
      pickerEmptyHint.hidden = false;
      pickerEmptyHint.textContent = hint;
    } else {
      pickerEmptyHint.hidden = true;
    }
    pickerRetryBtn.hidden = !isError;
    pickerRetryBtn.textContent = C.loadErrorRetry;
    return;
  }
  setLine(pickerCaption, SMART_TASK_DEVICE_PICKER_COPY.eligibilityCaption);
  pickerList.hidden = false;
  pickerEmpty.hidden = true;
  pickerEmptyHint.hidden = true;
  pickerRetryBtn.hidden = true;
  for (const device of payload.devices) {
    pickerList.appendChild(renderDeviceRow(deviceTemplate, device));
  }
};

/** The device list, shown while the creation flow is closed. */
export const renderPickerView = (
  targets: RenderTargets,
  payload: CreateSmartTaskDevicesPayload | null,
  visible: boolean,
): void => {
  setVisible(targets.pickerView, visible);
  if (visible) renderPicker(targets, payload);
};
