import { useLayoutEffect, useState } from 'preact/hooks';
import type { TargetCapabilitySnapshot } from '../../../../contracts/src/types.ts';
import type { DeferredObjectiveTemperatureSettingsEntry } from '../../../../contracts/src/deferredObjectiveSettings.ts';

export type DeviceDeadlineObjectiveCardProps = {
  deviceName: string;
  entry: DeferredObjectiveTemperatureSettingsEntry | null;
  planHref: string;
  target: TargetCapabilitySnapshot | null;
  saving: boolean;
  error: string | null;
  onSave: (params: { enabled: boolean; targetTemperatureC: number; deadlineLocalTime: string }) => void;
  onClear: () => void;
};

const formatNumberInputValue = (value: number | null): string => (
  typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
);

export const DeviceDeadlineObjectiveCard = ({
  deviceName,
  entry,
  planHref,
  target,
  saving,
  error,
  onSave,
  onClear,
}: DeviceDeadlineObjectiveCardProps) => {
  const initialTemperature = entry?.targetTemperatureC
    ?? (typeof target?.value === 'number' && Number.isFinite(target.value) ? target.value : null);
  const initialTime = entry?.deadlineLocalTime ?? '08:00';
  const min = typeof target?.min === 'number' && Number.isFinite(target.min) ? target.min : -50;
  const max = typeof target?.max === 'number' && Number.isFinite(target.max) ? target.max : 100;
  const step = typeof target?.step === 'number' && Number.isFinite(target.step) && target.step > 0
    ? target.step
    : 0.5;
  const initialTemperatureValue = formatNumberInputValue(initialTemperature);
  const [enabled, setEnabled] = useState(entry?.enabled ?? false);
  const [targetTemperatureValue, setTargetTemperatureValue] = useState(initialTemperatureValue);
  const [deadlineLocalTime, setDeadlineLocalTime] = useState(initialTime);

  useLayoutEffect(() => {
    setEnabled(entry?.enabled ?? false);
    setTargetTemperatureValue(initialTemperatureValue);
    setDeadlineLocalTime(initialTime);
  }, [
    entry?.enabled,
    entry?.targetTemperatureC,
    entry?.deadlineLocalTime,
    initialTemperatureValue,
    initialTime,
  ]);

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    onSave({
      enabled: formData.get('enabled') === 'on',
      targetTemperatureC: Number(formData.get('targetTemperatureC')),
      deadlineLocalTime: String(formData.get('deadlineLocalTime') ?? '').trim(),
    });
  };

  return (
    <section class="detail-section" aria-label={`Deadline target for ${deviceName}`}>
      <details class="settings-collapse detail-collapse" open>
        <summary>
          <h3 class="section-title">Deadline target</h3>
          <span class="section-hint">Soft temperature target</span>
        </summary>
        <form class="collapse-content detail-deadline-form" onSubmit={handleSubmit}>
          <label class="field checkbox-field">
            <input
              type="checkbox"
              name="enabled"
              checked={enabled}
              disabled={saving}
              onInput={(event) => {
                setEnabled((event.currentTarget as HTMLInputElement).checked);
              }}
            />
            <span class="checkbox-field__content">
              <span class="field__label">Use deadline target</span>
              <small class="field__hint">Schedules when this device should heat toward the target.</small>
            </span>
          </label>

          <div class="form-grid">
            <label class="field">
              <span class="field__label">Target temperature (°C)</span>
              <input
                name="targetTemperatureC"
                type="number"
                inputMode="decimal"
                step={step}
                min={min}
                max={max}
                value={targetTemperatureValue}
                disabled={saving}
                required
                onInput={(event) => {
                  setTargetTemperatureValue((event.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
            <label class="field">
              <span class="field__label">Ready by</span>
              <input
                name="deadlineLocalTime"
                type="time"
                value={deadlineLocalTime}
                disabled={saving}
                required
                onInput={(event) => {
                  setDeadlineLocalTime((event.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
          </div>

          <small class="field__hint">
            Planned hours use normal PELS behavior. Outside planned hours, capacity-based control decides whether
            normal PELS behavior still applies or the device is kept idle by plan.
          </small>
          {error && <p class="muted detail-deadline-error" role="alert">{error}</p>}
          <div class="detail-actions">
            <button type="submit" class="btn primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save target'}
            </button>
            <a class="btn secondary" href={planHref}>
              View plan
            </a>
            <button type="button" class="btn ghost" disabled={saving || !entry} onClick={onClear}>
              Clear
            </button>
          </div>
        </form>
      </details>
    </section>
  );
};
