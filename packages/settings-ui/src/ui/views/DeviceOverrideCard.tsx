import {
  OVERRIDE_COPY, OVERRIDE_END_OPTIONS, type OverrideDraft, type OverrideTemperatureRange,
} from '../deviceOverrideDraft.ts';
import { MdFilledButton, MdFilledTextField, MdTextButton } from './materialWebJSX.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

export type DeviceOverrideCardState =
  | { kind: 'idle' }
  | { kind: 'blocked' }
  | { kind: 'active'; line: string; busy: boolean }
  | {
    kind: 'editing';
    draft: OverrideDraft;
    range: OverrideTemperatureRange & { step: number };
    error: string | null;
    busy: boolean;
    /** The end the draft resolves to, spelled out; `null` while it has none. */
    endLine: string | null;
    /** An override in force is being changed, not a new one started. */
    changing: boolean;
    /** What the override means for the device's open Smart task; `null` without one. */
    smartTaskNote: string | null;
  };

/** The schedule the Temporary card's Schedules row opens: an override for this device at this temperature. */
export type OverrideScheduleLink = { deviceId: string; temperatureC: number | null };

export type DeviceOverrideCardActions = {
  onStart: () => void;
  onEndNow: () => void;
  onDraftChange: (patch: Partial<OverrideDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
};

const inputValue = (event: Event): string => (event.currentTarget as HTMLInputElement).value;

type EditingState = Extract<DeviceOverrideCardState, { kind: 'editing' }>;

/** The form the Override row opens: a new override, or a change to the one in force. */
export const OverrideForm = ({ state, actions }: { state: EditingState; actions: DeviceOverrideCardActions }) => {
  const { draft, range, error, busy, smartTaskNote, endLine, changing } = state;
  return (
    <div class="device-detail-override__form">
      <MdFilledTextField type="number" inputmode="decimal" label={OVERRIDE_COPY.temperatureLabel}
        value={draft.temperature} min={range.min ?? undefined} max={range.max ?? undefined} step={String(range.step)}
        disabled={busy} data-override-field="temperature"
        onInput={(event: Event) => actions.onDraftChange({ temperature: inputValue(event) })} />
      <div class="field">
        <span class="field__label pels-text-settings-label">{OVERRIDE_COPY.endLabel}</span>
        <SegmentedControl options={OVERRIDE_END_OPTIONS} value={draft.end} ariaLabel={OVERRIDE_COPY.endLabel}
          onChange={(end) => actions.onDraftChange({ end })} />
        {endLine !== null && draft.end !== 'custom' && <small class="field__hint" data-override-end-line>{endLine}</small>}
      </div>
      {draft.end === 'custom' && <div class="device-detail-override__custom">
        <label class="field"><span class="field__label pels-text-settings-label">Date</span>
          <input type="date" class="smart-task-edit__time-input" value={draft.date} disabled={busy}
            data-override-field="date" onInput={(event) => actions.onDraftChange({ date: inputValue(event) })} /></label>
        <label class="field"><span class="field__label pels-text-settings-label">Time</span>
          <input type="time" class="smart-task-edit__time-input" value={draft.at} disabled={busy}
            data-override-field="time" onInput={(event) => actions.onDraftChange({ at: inputValue(event) })} /></label>
        {endLine !== null && <small class="field__hint device-detail-override__custom-end" data-override-end-line>
          {endLine}
        </small>}
      </div>}
      {smartTaskNote !== null && <p class="pels-notice-info" data-override-smart-task-note>{smartTaskNote}</p>}
      {error !== null && <small class="field__hint smart-task-edit__error" role="alert">{error}</small>}
      <div class="device-detail-override__actions">
        <MdFilledButton type="button" disabled={busy} data-override-action="save" onClick={actions.onSave}>
          {changing ? OVERRIDE_COPY.saveChange : OVERRIDE_COPY.save}
        </MdFilledButton>
        {changing && <MdTextButton type="button" disabled={busy} data-override-action="end" onClick={actions.onEndNow}>
          {OVERRIDE_COPY.end}
        </MdTextButton>}
        <MdTextButton type="button" disabled={busy} data-override-action="cancel" onClick={actions.onCancel}>
          {OVERRIDE_COPY.cancel}
        </MdTextButton>
      </div>
    </div>
  );
};
