import type { InverterCurtailmentDevices } from '../../../../shared-domain/src/settings/inverterCurtailment.ts';
import { isInverterCurtailmentEnabled } from '../../../../shared-domain/src/settings/inverterCurtailment.ts';
import { MdOutlinedButton, MdSwitch } from './materialWebJSX.tsx';

export type InverterSettingsRead = {
  devices: { id: string; name: string }[];
  selected: InverterCurtailmentDevices;
};

export type InverterCurtailmentSettingsProps = {
  read: InverterSettingsRead | null;
  busy: boolean;
  error: string;
  onEnabledChange(deviceId: string, enabled: boolean): void;
  onRetry(): void;
};

/** Native inverter opt-in, beside the contract whose price drives it. */
export function InverterCurtailmentSettings({
  read, busy, error, onEnabledChange, onRetry,
}: InverterCurtailmentSettingsProps) {
  return (
    <section class="form-grid" aria-label="Avoid paying to export">
      <h4 class="section-title">Avoid paying to export</h4>
      <p>
        PELS reduces excess solar when your export price is below zero. Your home can still
        use solar, and your inverter returns to its previous setting afterwards.
        Include per-kWh fees and credits in the export price.
      </p>
      {read !== null && read.devices.length === 0 && (
        <p>No compatible inverter found. Its Homey app needs to offer a production limit.</p>
      )}
      {read?.devices.map((device) => (
        <label class="md-switch-row" key={device.id}>
          {/* Material 2.5 keeps the clicked checkbox dirty after a remote value change. */}
          <MdSwitch
            key={String(isInverterCurtailmentEnabled(read.selected, device.id))}
            aria-label={`Avoid paying to export with ${device.name}`}
            selected={isInverterCurtailmentEnabled(read.selected, device.id)}
            disabled={busy}
            onChange={(event) => {
              onEnabledChange(device.id, (event.currentTarget as HTMLElement & { selected: boolean }).selected);
            }}
          />
          <span class="md-switch-row__content">
            <span class="md-switch-row__label pels-text-settings-label">{device.name}</span>
          </span>
        </label>
      ))}
      {error && <p role="status">{error}</p>}
      {((error && read === null) || read?.devices.length === 0) && (
        <MdOutlinedButton onClick={onRetry}>{read === null ? 'Retry' : 'Refresh'}</MdOutlinedButton>
      )}
    </section>
  );
}
