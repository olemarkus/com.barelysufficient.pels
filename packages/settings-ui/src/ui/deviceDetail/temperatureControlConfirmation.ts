import type { TemperatureControlMode } from '../../../../shared-domain/src/settings/temperatureControl.ts';
import { supportsPowerDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { isSteppedLoadControlModel } from '../deviceKind.ts';
import { state } from '../state.ts';
import { resolveShedBehavior } from '../../../../shared-domain/src/settings/shedBehaviors.ts';

type ControlDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };
const dialog = document.querySelector<ControlDialog>('#temperature-control-confirm-dialog');
const message = document.querySelector<HTMLElement>('#temperature-control-confirm-message');
const consequences = document.querySelector<HTMLElement>('#temperature-control-confirm-consequences');

// Let the native dialog dismiss without also closing the device panel underneath.
dialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') event.stopPropagation();
});

/** What "Keep the new temperature" does to limiting: one sentence, or nothing to say. */
function limitingWarnings(device: SettingsUiDeviceDetailItem): string[] {
  if (!supportsPowerDevice(device)) return [];
  const stepped = isSteppedLoadControlModel(device);
  const temperatureOnly = device.binaryControllable !== true && !stepped;
  if (temperatureOnly) return ['PELS will no longer be able to limit this device’s power.'];
  if (resolveShedBehavior(state.shedBehaviors, device.id).action !== 'set_temperature') return [];
  if (stepped && device.binaryControllable === true) {
    return ['When limiting power, PELS will lower power levels and may turn this device off. '
      + 'It will not change the temperature.'];
  }
  return [stepped
    ? 'When limiting power, PELS will use this device’s power levels instead of changing its temperature.'
    : 'When limiting power, PELS will turn this device off instead of changing its temperature.'];
}

/** Everything the owner should hear before the policy changes, in the order it matters. */
function policyChangeWarnings(
  device: SettingsUiDeviceDetailItem,
  next: Exclude<TemperatureControlMode, 'mode'>,
): string[] {
  const warnings: string[] = next === 'external' ? limitingWarnings(device) : [];
  if (next === 'update_mode' && resolveShedBehavior(state.shedBehaviors, device.id).action === 'set_temperature') {
    warnings.push(
      'While PELS is limiting this device’s temperature, a change made outside PELS is not saved as the mode target.',
    );
  }
  const price = state.priceOptimizationSettings[device.id];
  if (price?.enabled) warnings.push('Price-based temperature adjustments will stop.');
  if (price?.surplusWilling) warnings.push('Solar-surplus temperature adjustments will stop.');
  return warnings;
}

/**
 * Confirm the consequences before the auto-saving selector writes its new policy.
 *
 * Only "Keep the new temperature" takes limiting away — PELS then writes no
 * setpoint at all. "Save as current mode target" keeps the owner's limit in
 * force; what it changes for limiting is that a temperature the owner sets by
 * hand WHILE the device is limited is not saved, because that is a reaction to
 * the limit rather than a preference.
 */
export async function confirmTemperatureControlChange(
  device: SettingsUiDeviceDetailItem,
  next: Exclude<TemperatureControlMode, 'mode'>,
): Promise<boolean> {
  const warnings = policyChangeWarnings(device, next);
  if (warnings.length === 0) return true;
  if (!dialog || !message || !consequences || dialog.open) return false;

  const label = next === 'update_mode' ? 'Save as current mode target' : 'Keep the new temperature';
  message.textContent = `Choosing “${label}” will change how PELS manages ${device.name}:`;
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
