import { render } from 'preact';
import { useState } from 'preact/hooks';
import {
  BATTERY_RECOVERY_PATH, type BatteryRecovery, type BatteryRecoveryRequest,
} from '../../../../contracts/src/batteryRecovery.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { callApi } from '../homey.ts';
import { isBatteryControlReadable, resolveManagedState } from '../state.ts';
import { formatSettingsError } from '../toast.ts';
import { MdFilledButton, MdFilledSelect, MdOutlinedButton, MdSelectOption } from '../views/materialWebJSX.tsx';

type BatteryRecoveryAction = Omit<Extract<BatteryRecoveryRequest, { action: 'hand_back' }>, 'claimedAtMs'>
  | { action: 'acknowledge' };

type BatteryRecoveryProps = {
  recovery: BatteryRecovery;
  deviceId: string;
  canRecover: boolean;
};

export function BatteryRecoveryControls({ recovery, deviceId, canRecover }: BatteryRecoveryProps) {
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState('');
  if (restored) return <p role="status">Battery restored. Managed by PELS is off.</p>;
  const disabled = !canRecover || busy;
  const submit = async (action: BatteryRecoveryAction): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const request: BatteryRecoveryRequest = { ...action, claimedAtMs: recovery.claimedAtMs };
      await callApi('POST', `${BATTERY_RECOVERY_PATH}/${encodeURIComponent(deviceId)}`, request);
      setRestored(true);
    } catch (failure) {
      setError(formatSettingsError(failure, 'PELS could not finish restoring this battery. Try again.'));
    } finally {
      setBusy(false);
      document.dispatchEvent(new Event('battery-recovery-updated'));
    }
  };
  return <div class="pels-notice-warning" role="group" aria-labelledby="battery-recovery-heading">
    <h4 id="battery-recovery-heading">Restore the battery’s own control</h4>
    <p>PELS previously managed this battery. Confirm which plant it managed or restore it in the battery’s app.</p>
    {!canRecover && <p>Turn off Managed by PELS before restoring this battery.</p>}
    {recovery.candidates.length > 0 && <>
      <MdFilledSelect label="Original plant" value={targetId} disabled={disabled}
        onChange={(event: Event) => setTargetId((event.currentTarget as HTMLSelectElement).value)}>
        <MdSelectOption value="" selected={targetId === ''}>
          <div slot="headline">Choose a plant</div>
        </MdSelectOption>
        {recovery.candidates.map(({ id, name }) => (
          <MdSelectOption key={id} value={id} selected={targetId === id}>
            <div slot="headline">{name}</div>
          </MdSelectOption>
        ))}
      </MdFilledSelect>
      <div class="form__actions">
        <MdFilledButton disabled={disabled || !recovery.candidates.some(({ id }) => id === targetId)}
          onClick={() => submit({ action: 'hand_back', targetId })}>Restore selected plant</MdFilledButton>
      </div>
    </>}
    <p class="field__hint">
      If the original plant is missing from the list, check its name in Homey and the Homey API key below.
      Give plants different names so you can tell them apart.
    </p>
    <p>
      To restore it yourself, turn off remote EMS on the original plant in the battery’s app
      and remove both charge and discharge limits set by PELS.
    </p>
    <div class="form__actions">
      <MdOutlinedButton disabled={disabled} onClick={() => submit({ action: 'acknowledge' })}>
        I restored it manually
      </MdOutlinedButton>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function renderBatteryRecovery(device: SettingsUiDeviceDetailItem | null): void {
  const container = document.getElementById('device-detail-battery-recovery');
  if (!container) return;
  const recovery = device?.batteryRecovery;
  container.hidden = recovery === undefined;
  render(device && recovery ? (
    <BatteryRecoveryControls key={`${device.id}:${recovery.claimedAtMs}`}
      deviceId={device.id} recovery={recovery}
      canRecover={isBatteryControlReadable() && !resolveManagedState(device.id)} />
  ) : null, container);
}
