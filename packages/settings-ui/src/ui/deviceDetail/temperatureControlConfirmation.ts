import type { TemperatureControlMode } from '../../../../shared-domain/src/settings/temperatureControl.ts';
import { supportsPowerDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { isSteppedLoadControlModel } from '../deviceKind.ts';
import { state } from '../state.ts';

type ControlDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };
const dialog = document.querySelector<ControlDialog>('#temperature-control-confirm-dialog');
const message = document.querySelector<HTMLElement>('#temperature-control-confirm-message');
const consequences = document.querySelector<HTMLElement>('#temperature-control-confirm-consequences');

// Let the native dialog dismiss without also closing the device panel underneath.
dialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') event.stopPropagation();
});

function limitingConsequence(device: SettingsUiDeviceDetailItem): string | undefined {
  if (!supportsPowerDevice(device)) return undefined;
  const stepped = isSteppedLoadControlModel(device);
  const temperatureOnly = device.binaryControllable !== true && !stepped;
  if (!temperatureOnly && state.shedBehaviors[device.id]?.action !== 'set_temperature') return undefined;
  if (temperatureOnly) return 'PELS will no longer be able to limit this device’s power.';
  if (stepped && device.binaryControllable === true) {
    return 'When limiting power, PELS will lower power levels and may turn this device off. '
      + 'It will not change the temperature.';
  }
  return stepped
    ? 'When limiting power, PELS will use this device’s power levels instead of changing its temperature.'
    : 'When limiting power, PELS will turn this device off instead of changing its temperature.';
}

/** Confirm the consequences before the auto-saving selector writes its new policy. */
export async function confirmTemperatureControlChange(
  device: SettingsUiDeviceDetailItem,
  next: Exclude<TemperatureControlMode, 'mode'>,
): Promise<boolean> {
  const warnings: string[] = [];
  const limiting = limitingConsequence(device);
  if (limiting) warnings.push(limiting);
  const price = state.priceOptimizationSettings[device.id];
  if (price?.enabled) warnings.push('Price-based temperature adjustments will stop.');
  if (price?.surplusWilling) warnings.push('Solar-surplus temperature adjustments will stop.');
  if (warnings.length === 0) return true;
  if (!dialog || !message || !consequences || dialog.open) return false;

  const label = next === 'update_mode' ? 'Update mode target' : 'Leave temperature to you';
  message.textContent = `${label} will change how PELS controls ${device.name}:`;
  consequences.replaceChildren(...warnings.map((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    return item;
  }));
  const currentDialog = dialog;
  // Escape and scrim dismissal must never reuse a previous confirmation.
  currentDialog.returnValue = '';
  return new Promise<boolean>((resolve) => {
    currentDialog.addEventListener('close', () => resolve(currentDialog.returnValue === 'confirm'), { once: true });
    currentDialog.show();
  });
}
