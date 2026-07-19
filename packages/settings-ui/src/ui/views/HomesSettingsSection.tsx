import { render } from 'preact';
import {
  composeDeleteConfirmBody,
  HOMES_ADD_BUTTON,
  HOMES_CANCEL_BUTTON,
  HOMES_CONFIG_DEGRADED,
  HOMES_DELETE_BUTTON,
  HOMES_DELETE_CANCEL_BUTTON,
  HOMES_DELETE_CONFIRM_BUTTON,
  HOMES_EDIT_BUTTON,
  HOMES_EDITOR_AREA_GONE,
  HOMES_EDITOR_TITLE_EDIT,
  HOMES_EDITOR_TITLE_NEW,
  HOMES_EMPTY_EXPLAINER,
  HOMES_LOAD_FAILED,
  HOMES_MAIN_HOME_NOTE,
  HOMES_MAIN_METER_NOTICE,
  HOMES_MAIN_METER_NOTICE_LINK,
  HOMES_METER_HINT,
  HOMES_METER_LABEL,
  HOMES_METER_LOADING_OPTION,
  HOMES_METER_MISSING_OPTION,
  HOMES_METER_PLACEHOLDER,
  HOMES_NAME_LABEL,
  HOMES_NO_METER_DEVICES,
  HOMES_SAVE_AGAIN_BUTTON,
  HOMES_SAVE_BUTTON,
  HOMES_ZONE_HINT,
  HOMES_ZONE_LABEL,
  HOMES_ZONE_PLACEHOLDER,
  HOMES_ZONES_UNAVAILABLE,
} from '../../../../shared-domain/src/homesManagementCopy.ts';
import { MdFilledButton, MdTextButton } from './materialWebJSX.tsx';

// "Multiple meters" sub-page body: progressive disclosure (explainer + Add
// until the first meter area exists), then the management list and the shared
// create/edit form. Native select/input wrapped in `.field` per the
// form-styling rule; buttons are Material Web per views/AGENTS.md. Rendered
// into `#homes-settings-mount` by the homesSettings controller — all data and
// callbacks arrive as props, nothing global.

export type HomesListEntryView = {
  homeId: string;
  name: string;
  /** Pre-composed `⟨meter⟩ · ⟨zone⟩ · N devices` line (controller-resolved). */
  supportingLine: string;
};

export type HomesPickerOption = { id: string; label: string };

export type HomesEditorView = {
  mode: 'create' | 'edit';
  meterId: string | null;
  /** Power-reporting devices; `metersLoaded` gates the no-devices empty state. */
  meterOptions: HomesPickerOption[];
  metersLoaded: boolean;
  zoneId: string | null;
  /** Flattened zone forest, labels pre-indented by depth. */
  zoneOptions: HomesPickerOption[];
  /**
   * Live membership preview ("N devices in this zone and its sub-zones");
   * null while no zone is chosen or the device zones are still loading — the
   * static zone hint shows instead.
   */
  zoneDeviceCountLine: string | null;
  /**
   * The edited area vanished from the fresh list (removed elsewhere while
   * editing): a reconciliation line shows and Save reads "Add again".
   */
  areaGone: boolean;
  name: string;
  meterErrors: string[];
  zoneErrors: string[];
  /** Non-blocking (`meter outside zone`) — saving stays allowed. */
  zoneWarnings: string[];
  nameErrors: string[];
  busy: boolean;
  onMeterChange: (deviceId: string | null) => void;
  onZoneChange: (zoneId: string | null) => void;
  onNameInput: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

export type HomesSettingsSectionProps = {
  status: 'loading' | 'error' | 'ready';
  homes: HomesListEntryView[];
  /** False until the zone tree has arrived — adding needs zones to pick from. */
  zonesAvailable: boolean;
  /**
   * True while the runtime cannot vouch for the served config (`ui_homes`
   * `configDegraded`): every mutation control disables and the lockout line
   * shows — a save composed from a stale view could erase areas.
   */
  configDegraded: boolean;
  /**
   * Transient load lock (distinct from `configDegraded`): while a panel
   * (re)activation's fresh `ui_homes` read is still in flight, every mutation
   * control disables — a cached payload renders ready before the refetch lands,
   * and a mutation composed from it could clobber newer same-area edits. No
   * lockout copy: this is a brief wait, not the runtime-can't-vouch state.
   */
  mutationsLocked: boolean;
  /** Main-home meter nudge (areas exist ∧ Homey Energy ∧ no explicit whole-home meter). */
  showMainMeterNotice: boolean;
  editor: HomesEditorView | null;
  confirmingDeleteHomeId: string | null;
  deleteBusy: boolean;
  onAddClick: () => void;
  onEditClick: (homeId: string) => void;
  onDeleteClick: (homeId: string) => void;
  onDeleteConfirm: (homeId: string) => void;
  onDeleteCancel: () => void;
};

const HintLines = ({ lines, alert }: { lines: string[]; alert: boolean }) => (
  <>
    {lines.map((line) => (
      <small key={line} class={alert ? 'field__hint field__hint--alert' : 'field__hint'}>{line}</small>
    ))}
  </>
);

const MeterField = ({ editor }: { editor: HomesEditorView }) => {
  const knownSelection = editor.meterId === null
    || editor.meterOptions.some((option) => option.id === editor.meterId);
  const onChange = (event: Event) => {
    const raw = (event.currentTarget as HTMLSelectElement).value;
    editor.onMeterChange(raw === '' ? null : raw);
  };
  return (
    <label class="field">
      <span class="field__label pels-text-settings-label">{HOMES_METER_LABEL}</span>
      <select id="homes-meter-select" class="pels-select hy-nostyle" value={editor.meterId ?? ''} onChange={onChange}>
        <option value="">{HOMES_METER_PLACEHOLDER}</option>
        {/* A configured meter absent from the list stays selectable so the
            select can't silently snap to the placeholder and lose the setting
            (same orphan discipline as the weather + whole-home meter pickers). */}
        {!knownSelection && editor.meterId !== null && (
          <option value={editor.meterId}>
            {editor.metersLoaded ? HOMES_METER_MISSING_OPTION : HOMES_METER_LOADING_OPTION}
          </option>
        )}
        {editor.meterOptions.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
      {editor.metersLoaded && editor.meterOptions.length === 0
        ? <small class="field__hint">{HOMES_NO_METER_DEVICES}</small>
        : <small class="field__hint">{HOMES_METER_HINT}</small>}
      <HintLines lines={editor.meterErrors} alert />
    </label>
  );
};

const ZoneField = ({ editor }: { editor: HomesEditorView }) => {
  const onChange = (event: Event) => {
    const raw = (event.currentTarget as HTMLSelectElement).value;
    editor.onZoneChange(raw === '' ? null : raw);
  };
  return (
    <label class="field">
      <span class="field__label pels-text-settings-label">{HOMES_ZONE_LABEL}</span>
      <select id="homes-zone-select" class="pels-select hy-nostyle" value={editor.zoneId ?? ''} onChange={onChange}>
        <option value="">{HOMES_ZONE_PLACEHOLDER}</option>
        {editor.zoneOptions.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
      {/* Live sweep preview once a zone is chosen (the static rule hint until
          then) — the consequence is checkable BEFORE saving. While the amber
          outside-zone warning shows, the preview demotes to metadata tone so
          the warning is the group's only coloured line. */}
      {editor.zoneDeviceCountLine !== null
        ? (
          <small
            class={editor.zoneWarnings.length > 0 ? 'field__hint' : 'field__hint pels-hint-ok'}
            id="homes-zone-device-count"
          >
            {editor.zoneDeviceCountLine}
          </small>
        )
        : <small class="field__hint">{HOMES_ZONE_HINT}</small>}
      <HintLines lines={editor.zoneErrors} alert />
      <HintLines lines={editor.zoneWarnings} alert />
    </label>
  );
};

const NameField = ({ editor }: { editor: HomesEditorView }) => (
  <label class="field">
    <span class="field__label pels-text-settings-label">{HOMES_NAME_LABEL}</span>
    <input
      id="homes-name-input"
      class="pels-input hy-nostyle"
      type="text"
      autocomplete="off"
      value={editor.name}
      onInput={(event: Event) => editor.onNameInput((event.currentTarget as HTMLInputElement).value)}
    />
    <HintLines lines={editor.nameErrors} alert />
  </label>
);

/** Railed lockout notice — the page-level warn moment while `configDegraded`. */
const DegradedNotice = () => (
  <div class="pels-notice-warning homes-settings__degraded" id="homes-config-degraded">
    {HOMES_CONFIG_DEGRADED}
  </div>
);

const EditorForm = ({ editor, configDegraded, mutationsLocked }: {
  editor: HomesEditorView;
  configDegraded: boolean;
  mutationsLocked: boolean;
}) => (
  <section class="settings-form-card homes-settings__editor" id="homes-editor">
    <h3 class="pels-text-card-title homes-settings__editor-title">
      {editor.mode === 'create' ? HOMES_EDITOR_TITLE_NEW : HOMES_EDITOR_TITLE_EDIT}
    </h3>
    <MeterField editor={editor} />
    <ZoneField editor={editor} />
    <NameField editor={editor} />
    {configDegraded && <DegradedNotice />}
    {editor.areaGone && (
      <small class="field__hint field__hint--alert" id="homes-editor-area-gone">
        {HOMES_EDITOR_AREA_GONE}
      </small>
    )}
    <div class="inline-actions homes-settings__actions">
      <MdTextButton id="homes-editor-cancel" disabled={editor.busy || undefined} onClick={editor.onCancel}>
        {HOMES_CANCEL_BUTTON}
      </MdTextButton>
      <MdFilledButton
        id="homes-editor-save"
        disabled={editor.busy || configDegraded || mutationsLocked || undefined}
        onClick={editor.onSave}
      >
        {editor.areaGone ? HOMES_SAVE_AGAIN_BUTTON : HOMES_SAVE_BUTTON}
      </MdFilledButton>
    </div>
  </section>
);

const DeleteConfirmStrip = ({ entry, deleteBusy, mutationsLocked, onConfirm, onCancel }: {
  entry: HomesListEntryView;
  deleteBusy: boolean;
  mutationsLocked: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => (
  <div class="pels-notice-warning homes-settings__confirm" role="group">
    <p class="homes-settings__confirm-body">{composeDeleteConfirmBody(entry.name)}</p>
    <div class="inline-actions homes-settings__actions">
      {/* Cancel stays live as an escape even while locked. */}
      <MdTextButton disabled={deleteBusy || undefined} onClick={onCancel}>
        {HOMES_DELETE_CANCEL_BUTTON}
      </MdTextButton>
      <MdTextButton
        class="md-text-button--destructive"
        disabled={deleteBusy || mutationsLocked || undefined}
        onClick={onConfirm}
      >
        {HOMES_DELETE_CONFIRM_BUTTON}
      </MdTextButton>
    </div>
  </div>
);

const HomesList = (props: HomesSettingsSectionProps) => (
  <section class="settings-form-card homes-settings__list" id="homes-list">
    {props.homes.map((entry) => (
      <div key={entry.homeId} class="homes-settings__row" data-home-id={entry.homeId}>
        <div class="homes-settings__row-main">
          <span class="homes-settings__row-name pels-text-card-title">{entry.name}</span>
          <small class="homes-settings__row-supporting muted">{entry.supportingLine}</small>
        </div>
        {props.confirmingDeleteHomeId === entry.homeId
          ? (
            <DeleteConfirmStrip
              entry={entry}
              deleteBusy={props.deleteBusy}
              mutationsLocked={props.mutationsLocked}
              onConfirm={() => props.onDeleteConfirm(entry.homeId)}
              onCancel={props.onDeleteCancel}
            />
          )
          : (
            <div class="inline-actions homes-settings__actions">
              <MdTextButton
                disabled={props.configDegraded || props.mutationsLocked || undefined}
                onClick={() => props.onEditClick(entry.homeId)}
              >
                {HOMES_EDIT_BUTTON}
              </MdTextButton>
              <MdTextButton
                class="md-text-button--destructive"
                disabled={props.configDegraded || props.mutationsLocked || undefined}
                onClick={() => props.onDeleteClick(entry.homeId)}
              >
                {HOMES_DELETE_BUTTON}
              </MdTextButton>
            </div>
          )}
      </div>
    ))}
  </section>
);

const AddButtonRow = ({ zonesAvailable, configDegraded, mutationsLocked, onAddClick }: {
  zonesAvailable: boolean;
  configDegraded: boolean;
  mutationsLocked: boolean;
  onAddClick: () => void;
}) => (
  <div class="homes-settings__add">
    <MdFilledButton
      id="homes-add-button"
      disabled={!zonesAvailable || configDegraded || mutationsLocked || undefined}
      onClick={onAddClick}
    >
      {HOMES_ADD_BUTTON}
    </MdFilledButton>
    {/* The page-level DegradedNotice owns the lockout moment; the zones hint
        only shows on a healthy read. */}
    {!configDegraded && !zonesAvailable
      && <small class="field__hint">{HOMES_ZONES_UNAVAILABLE}</small>}
  </div>
);

/**
 * Main-home meter nudge: Homey Energy homes with meter areas but no explicit
 * whole-home meter read the combined total of every meter. Links to the real
 * control's panel (Limits & safety) via the global settings-target handler.
 */
const MainMeterNotice = () => (
  <section class="pels-notice-warning homes-settings__notice" id="homes-main-meter-notice">
    <p class="homes-settings__notice-body">{HOMES_MAIN_METER_NOTICE}</p>
    <MdTextButton class="homes-settings__notice-link" data-settings-target="limits">
      {HOMES_MAIN_METER_NOTICE_LINK}
    </MdTextButton>
  </section>
);

const HomesSettingsSectionView = (props: HomesSettingsSectionProps) => {
  if (props.status === 'loading') {
    return (
      <div class="pels-skeleton-stack" aria-hidden="true">
        <span class="pels-skeleton pels-skeleton--card" />
      </div>
    );
  }
  if (props.status === 'error') {
    return <p class="muted" id="homes-load-failed">{HOMES_LOAD_FAILED}</p>;
  }
  if (props.editor !== null) {
    return (
      <div class="homes-settings">
        <EditorForm
          editor={props.editor}
          configDegraded={props.configDegraded}
          mutationsLocked={props.mutationsLocked}
        />
      </div>
    );
  }
  // Progressive disclosure: until the first meter area exists the page is
  // only the explainer and the Add affordance. The degraded lockout leads the
  // page in either branch — it is the most important message in that state.
  if (props.homes.length === 0) {
    return (
      <div class="homes-settings">
        {props.configDegraded && <DegradedNotice />}
        <section class="settings-form-card">
          <p class="pels-card-supporting" id="homes-empty-explainer">{HOMES_EMPTY_EXPLAINER}</p>
        </section>
        <AddButtonRow
          zonesAvailable={props.zonesAvailable}
          configDegraded={props.configDegraded}
          mutationsLocked={props.mutationsLocked}
          onAddClick={props.onAddClick}
        />
      </div>
    );
  }
  return (
    <div class="homes-settings">
      {props.configDegraded && <DegradedNotice />}
      <HomesList {...props} />
      {/* Deliberately a bare footnote BELOW the card: it describes the
          complement of every area, not the last row (M3 placement decision). */}
      <small class="muted homes-settings__main-note" id="homes-main-note">{HOMES_MAIN_HOME_NOTE}</small>
      {props.showMainMeterNotice && <MainMeterNotice />}
      <AddButtonRow
        zonesAvailable={props.zonesAvailable}
        configDegraded={props.configDegraded}
        mutationsLocked={props.mutationsLocked}
        onAddClick={props.onAddClick}
      />
    </div>
  );
};

export const renderHomesSettingsSection = (
  surface: HTMLElement,
  props: HomesSettingsSectionProps,
): void => {
  render(<HomesSettingsSectionView {...props} />, surface);
};
