import type { DevicePowerControlMode, DevicePowerControlModes } from '../../../../contracts/src/types.ts';
import { DEVICE_POWER_CONTROL_MODES } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import { normalizeDevicePowerControlModes } from '../../../../shared-domain/src/settings/devicePowerControlModes.ts';
import { isAutomaticPowerControlActive } from '../deviceControlProfiles.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { findLatestDevice, state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

type PowerControlDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };
type PowerControlSelect = HTMLElement & { value: string; disabled: boolean };
const dialog = document.querySelector<PowerControlDialog>('#power-control-confirm-dialog');
const select = document.querySelector<PowerControlSelect>('#device-detail-power-control-mode');
const row = document.getElementById('device-detail-power-control-row');
const hint = document.getElementById('device-detail-power-control-hint');
const range = document.getElementById('device-detail-power-control-range');
const runSerializedWrite = createSerializedAsyncRunner();
let saving = false;

const kw = (watts: number): string => String(Math.round(watts / 10) / 100);

export function automaticPowerRangeLabel(device: SettingsUiDeviceDetailItem): string {
  const positive = device.automaticPowerControl?.profile.steps.filter((step) => step.planningPowerW > 0) ?? [];
  if (positive.length === 0) return '';
  const powers = positive.map((step) => step.planningPowerW);
  return `${kw(Math.min(...powers))}–${kw(Math.max(...powers))} kW`;
}

/** Name the actual change before the owner activates a different control path. */
export function automaticPowerControlConsequences(device: SettingsUiDeviceDetailItem): string[] {
  const saved = state.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig;
  const consequences = ['PELS will determine power levels from the device settings.'];
  if (saved?.max === undefined) consequences.push(`Automatic range: ${automaticPowerRangeLabel(device)}.`);
  if (saved?.preset) {
    const phase = saved.preset === 'ev_charger_3_phase' ? 'EV 3-phase' : 'EV 1-phase';
    consequences.push(`Your ${phase} model will not be used in Automatic.`);
  } else if (saved || state.deviceControlProfiles[device.id]) {
    consequences.push('Your saved PELS power levels will not be used in Automatic.');
  }
  if (saved?.max !== undefined) {
    consequences.push(`Your PELS maximum of ${kw(saved.max)} kW will not apply. `
      + `Automatic range: ${automaticPowerRangeLabel(device)}.`);
  }
  const usesChargerPowerTarget = device.automaticPowerControl?.profile.steps
    .every((step) => step.planningCurrentA === undefined);
  if (device.isEvCharger && usesChargerPowerTarget) {
    consequences.push('Your manual charging-current setup will not be used.');
  }
  return consequences;
}

async function confirmAutomaticPowerControl(device: SettingsUiDeviceDetailItem): Promise<boolean> {
  const message = document.getElementById('power-control-confirm-message');
  const consequences = document.getElementById('power-control-confirm-consequences');
  if (!dialog || !message || !consequences || dialog.open) return false;
  message.textContent = `Review what changes for ${device.name}:`;
  consequences.replaceChildren(...automaticPowerControlConsequences(device).map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  const currentDialog = dialog;
  currentDialog.returnValue = '';
  return new Promise<boolean>((resolve) => {
    currentDialog.addEventListener('close', () => resolve(currentDialog.returnValue === 'confirm'), { once: true });
    currentDialog.show();
  });
}

dialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') event.stopPropagation();
});

export function renderAutomaticPowerControl(device: SettingsUiDeviceDetailItem): void {
  if (!row || !select) return;
  row.hidden = !device.automaticPowerControl;
  if (!device.automaticPowerControl) return;
  const automatic = isAutomaticPowerControlActive(device);
  select.value = automatic ? 'automatic' : 'manual';
  select.disabled = saving || !device.managed || !state.devicePowerControlModesLoaded;
  if (hint) hint.textContent = automatic
    ? `PELS determines the power levels from ${device.isEvCharger ? 'your charger’s' : 'the device’s'} settings.`
    : 'PELS uses your manual setup below. Switching to Automatic keeps these settings for later.';
  if (range) {
    range.hidden = !automatic;
    range.textContent = `${device.isEvCharger ? 'Charging' : 'Power'} range: ${automaticPowerRangeLabel(device)}`;
  }
}

export function initAutomaticPowerControlHandlers(
  getCurrentDeviceId: () => string | null,
  refresh: () => void,
): void {
  select?.addEventListener('change', async () => {
    const id = getCurrentDeviceId();
    const device = id ? findLatestDevice(id) : undefined;
    const next = select.value;
    if (!device?.automaticPowerControl || saving || !state.devicePowerControlModesLoaded
      || (next !== 'automatic' && next !== 'manual')) return;
    const current: DevicePowerControlMode = isAutomaticPowerControlActive(device) ? 'automatic' : 'manual';
    if (next === current) return;
    // Keep showing the active choice while review is open or the save is pending.
    select.value = current;
    if (next === 'automatic' && !await confirmAutomaticPowerControl(device)) return;
    saving = true;
    select.disabled = true;
    try {
      await runSerializedWrite(() => writeFreshSetting<DevicePowerControlModes>({
        key: DEVICE_POWER_CONTROL_MODES,
        context: 'device detail',
        logMessage: 'Failed to save device control choice',
        toastMessage: 'Could not save the control choice.',
        fallbackValue: state.devicePowerControlModes,
        readFresh: normalizeDevicePowerControlModes,
        mutate: (modes) => ({ ...modes, [device.id]: next }),
        commit: (modes) => { state.devicePowerControlModes = modes; },
      }));
    } finally {
      saving = false;
      refresh();
    }
  });
}
