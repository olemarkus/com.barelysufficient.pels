import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderHomesSettingsSection,
  type HomesEditorView,
  type HomesSettingsSectionProps,
} from '../src/ui/views/HomesSettingsSection.tsx';
import {
  composeDeleteConfirmBody,
  HOMES_ADD_BUTTON,
  HOMES_CONFIG_DEGRADED,
  HOMES_EMPTY_EXPLAINER,
  HOMES_LOAD_FAILED,
  HOMES_MAIN_HOME_NOTE,
  HOMES_MAIN_METER_NOTICE,
  HOMES_MAIN_METER_NOTICE_LINK,
  HOMES_METER_MISSING_OPTION,
  HOMES_NO_METER_DEVICES,
  HOMES_ZONES_UNAVAILABLE,
} from '../../shared-domain/src/homesManagementCopy';

/* -------------------------------------------------------------------------- *
 * Multiple meters section render tests: the progressive-disclosure branches
 * (empty explainer vs management list), the inline delete-confirm step, and
 * the create/edit form's pickers + validation lines. Copy assertions pin the
 * rendered text to the shared-domain homesManagementCopy helpers.
 * -------------------------------------------------------------------------- */

const noop = (): void => {};

const baseProps = (): HomesSettingsSectionProps => ({
  status: 'ready',
  homes: [],
  zonesAvailable: true,
  configDegraded: false,
  mutationsLocked: false,
  showMainMeterNotice: false,
  editor: null,
  confirmingDeleteHomeId: null,
  deleteBusy: false,
  onAddClick: noop,
  onEditClick: noop,
  onDeleteClick: noop,
  onDeleteConfirm: noop,
  onDeleteCancel: noop,
});

type DisableableElement = (HTMLElement & { disabled?: unknown }) | null;

const rentalRow = {
  homeId: 'h_11111111',
  name: 'Utleie',
  supportingLine: 'Måler utleie · Utleie · 3 devices',
};

const baseEditor = (): HomesEditorView => ({
  mode: 'create',
  meterId: null,
  meterOptions: [
    { id: 'dev_a', label: 'Måler utleie · Bod' },
    { id: 'dev_b', label: 'Water Heater' },
  ],
  metersLoaded: true,
  zoneId: null,
  zoneOptions: [
    { id: 'home', label: 'Home' },
    { id: 'utleie', label: '  Utleie' },
  ],
  zoneDeviceCountLine: null,
  areaGone: false,
  name: '',
  meterErrors: [],
  zoneErrors: [],
  zoneWarnings: [],
  nameErrors: [],
  busy: false,
  onMeterChange: noop,
  onZoneChange: noop,
  onNameInput: noop,
  onSave: noop,
  onCancel: noop,
});

const mountWith = (props: HomesSettingsSectionProps): HTMLElement => {
  const surface = document.createElement('div');
  document.body.append(surface);
  renderHomesSettingsSection(surface, props);
  return surface;
};

// Leaked mounts leave duplicate ids behind, and jsdom's `#id` fast-path then
// resolves against the FIRST document-wide match — scrub between tests.
afterEach(() => {
  document.body.innerHTML = '';
});

describe('progressive disclosure', () => {
  it('shows only the explainer and Add affordance while no meter area exists', () => {
    const surface = mountWith(baseProps());
    expect(surface.textContent).toContain(HOMES_EMPTY_EXPLAINER);
    expect(surface.textContent).toContain(HOMES_ADD_BUTTON);
    expect(surface.querySelector('#homes-list')).toBeNull();
    expect(surface.textContent).not.toContain(HOMES_MAIN_HOME_NOTE);
  });

  it('shows the management list once an area exists', () => {
    const surface = mountWith({ ...baseProps(), homes: [rentalRow] });
    expect(surface.textContent).not.toContain(HOMES_EMPTY_EXPLAINER);
    expect(surface.textContent).toContain('Utleie');
    expect(surface.textContent).toContain(rentalRow.supportingLine);
    expect(surface.textContent).toContain(HOMES_MAIN_HOME_NOTE);
    expect(surface.textContent).toContain(HOMES_ADD_BUTTON);
  });

  it('disables Add and explains when zones are unavailable', () => {
    const surface = mountWith({ ...baseProps(), zonesAvailable: false });
    // Preact sets `disabled` as a PROPERTY on the (unregistered-in-jsdom)
    // Material custom element; the registered production element reflects it.
    const addButton = surface.querySelector('#homes-add-button') as DisableableElement;
    expect(addButton?.disabled).toBe(true);
    expect(surface.textContent).toContain(HOMES_ZONES_UNAVAILABLE);
  });
});

describe('degraded config lockout', () => {
  it('disables every mutation control and shows the lockout line on the list', () => {
    const surface = mountWith({ ...baseProps(), homes: [rentalRow], configDegraded: true });
    const addButton = surface.querySelector('#homes-add-button') as DisableableElement;
    expect(addButton?.disabled).toBe(true);
    const rowButtons = [...surface.querySelectorAll('.homes-settings__actions md-text-button')];
    expect(rowButtons.length).toBeGreaterThan(0);
    for (const button of rowButtons) {
      expect((button as HTMLElement & { disabled?: unknown }).disabled).toBe(true);
    }
    expect(surface.textContent).toContain(HOMES_CONFIG_DEGRADED);
    // The lockout owns the moment — no zones hint alongside it.
    expect(surface.textContent).not.toContain(HOMES_ZONES_UNAVAILABLE);
  });

  it('disables Save and shows the lockout line in the editor', () => {
    const surface = mountWith({ ...baseProps(), configDegraded: true, editor: baseEditor() });
    const saveButton = surface.querySelector('#homes-editor-save') as DisableableElement;
    expect(saveButton?.disabled).toBe(true);
    expect(surface.textContent).toContain(HOMES_CONFIG_DEGRADED);
  });
});

describe('activation load lock (mutationsLocked)', () => {
  it('disables Add, Edit, and Remove while the fresh read is in flight — without the lockout copy', () => {
    const surface = mountWith({ ...baseProps(), homes: [rentalRow], mutationsLocked: true });
    const addButton = surface.querySelector('#homes-add-button') as DisableableElement;
    expect(addButton?.disabled).toBe(true);
    const rowButtons = [...surface.querySelectorAll('.homes-settings__actions md-text-button')];
    expect(rowButtons.length).toBeGreaterThan(0);
    for (const button of rowButtons) {
      expect((button as HTMLElement & { disabled?: unknown }).disabled).toBe(true);
    }
    // A transient load lock, not the runtime-can't-vouch lockout: no degraded copy.
    expect(surface.textContent).not.toContain(HOMES_CONFIG_DEGRADED);
  });

  it('disables Save in the editor while locked, without the lockout copy', () => {
    const surface = mountWith({ ...baseProps(), mutationsLocked: true, editor: baseEditor() });
    const saveButton = surface.querySelector('#homes-editor-save') as DisableableElement;
    expect(saveButton?.disabled).toBe(true);
    expect(surface.textContent).not.toContain(HOMES_CONFIG_DEGRADED);
  });
});

describe('main-home meter notice', () => {
  it('renders the notice with the Limits cross-link only when the prop is set', () => {
    const withNotice = mountWith({ ...baseProps(), homes: [rentalRow], showMainMeterNotice: true });
    expect(withNotice.textContent).toContain(HOMES_MAIN_METER_NOTICE);
    const link = withNotice.querySelector('#homes-main-meter-notice md-text-button');
    expect(link?.textContent).toBe(HOMES_MAIN_METER_NOTICE_LINK);
    expect(link?.getAttribute('data-settings-target')).toBe('limits');
    document.body.innerHTML = '';
    const without = mountWith({ ...baseProps(), homes: [rentalRow] });
    expect(without.textContent).not.toContain(HOMES_MAIN_METER_NOTICE);
  });
});

describe('load states', () => {
  it('renders the failure line when ui_homes could not load', () => {
    const surface = mountWith({ ...baseProps(), status: 'error' });
    expect(surface.textContent).toContain(HOMES_LOAD_FAILED);
    expect(surface.querySelector('#homes-add-button')).toBeNull();
  });
});

describe('delete confirm step', () => {
  it('swaps the row actions for a confirm strip naming the consequence', () => {
    const onDeleteConfirm = vi.fn();
    const surface = mountWith({
      ...baseProps(),
      homes: [rentalRow],
      confirmingDeleteHomeId: rentalRow.homeId,
      onDeleteConfirm,
    });
    expect(surface.textContent).toContain(composeDeleteConfirmBody('Utleie'));
    expect(surface.textContent).toContain('Main home');
    const buttons = [...surface.querySelectorAll('.homes-settings__confirm md-text-button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Remove']);
    (buttons[1] as HTMLElement).click();
    expect(onDeleteConfirm).toHaveBeenCalledWith(rentalRow.homeId);
  });
});

describe('editor form', () => {
  it('renders the pickers, placeholder options, and name field', () => {
    const surface = mountWith({ ...baseProps(), editor: baseEditor() });
    const meterSelect = surface.querySelector<HTMLSelectElement>('#homes-meter-select');
    const zoneSelect = surface.querySelector<HTMLSelectElement>('#homes-zone-select');
    expect(meterSelect).not.toBeNull();
    expect([...meterSelect!.options].map((option) => option.textContent))
      .toEqual(['Choose a meter', 'Måler utleie · Bod', 'Water Heater']);
    expect([...zoneSelect!.options].map((option) => option.value)).toEqual(['', 'home', 'utleie']);
    expect(surface.querySelector('#homes-name-input')).not.toBeNull();
    expect(surface.textContent).toContain('New meter area');
  });

  it('keeps an orphaned configured meter selectable', () => {
    const surface = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), mode: 'edit', meterId: 'gone-device' },
    });
    const options = [...surface.querySelectorAll<HTMLOptionElement>('#homes-meter-select option')];
    const orphan = options.find((option) => option.value === 'gone-device');
    expect(orphan?.textContent).toBe(HOMES_METER_MISSING_OPTION);
    expect(surface.textContent).toContain('Edit meter area');
  });

  it('shows the no-power-devices empty state once the list has loaded empty', () => {
    const surface = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), meterOptions: [], metersLoaded: true },
    });
    expect(surface.textContent).toContain(HOMES_NO_METER_DEVICES);
  });

  it('renders validation errors and the non-blocking warning', () => {
    const surface = mountWith({
      ...baseProps(),
      editor: {
        ...baseEditor(),
        zoneErrors: ['This zone overlaps “Utleie”. Pick a zone outside it.'],
        zoneWarnings: ['This meter sits outside the chosen zone. You can still save — but check that the zone is right.'],
        nameErrors: ['Give this meter area a name.'],
      },
    });
    const alerts = [...surface.querySelectorAll('.field__hint--alert')].map((el) => el.textContent);
    expect(alerts).toContain('This zone overlaps “Utleie”. Pick a zone outside it.');
    expect(alerts).toContain('Give this meter area a name.');
    expect(alerts.some((text) => text?.includes('You can still save'))).toBe(true);
  });

  it('shows the live zone sweep preview instead of the static hint once available', () => {
    const surface = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), zoneId: 'utleie', zoneDeviceCountLine: '3 devices in this zone and its sub-zones' },
    });
    const preview = surface.querySelector('#homes-zone-device-count');
    expect(preview?.textContent).toBe('3 devices in this zone and its sub-zones');
    expect(surface.textContent).not.toContain('count as part of this meter area');
    document.body.innerHTML = '';
    const withoutPreview = mountWith({ ...baseProps(), editor: baseEditor() });
    expect(withoutPreview.querySelector('#homes-zone-device-count')).toBeNull();
    expect(withoutPreview.textContent).toContain('count as part of this meter area');
  });

  it('demotes the preview to metadata tone while the outside-zone warning shows', () => {
    const warned = mountWith({
      ...baseProps(),
      editor: {
        ...baseEditor(),
        zoneId: 'utleie',
        zoneDeviceCountLine: '2 devices in this zone and its sub-zones',
        zoneWarnings: ['This meter sits outside the chosen zone. You can still save — but check that the zone is right.'],
      },
    });
    expect(warned.querySelector('#homes-zone-device-count')?.classList.contains('pels-hint-ok')).toBe(false);
    document.body.innerHTML = '';
    const calm = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), zoneId: 'utleie', zoneDeviceCountLine: '2 devices in this zone and its sub-zones' },
    });
    expect(calm.querySelector('#homes-zone-device-count')?.classList.contains('pels-hint-ok')).toBe(true);
  });

  it('reconciles a vanished edited area: banner line + Add again label', () => {
    const surface = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), mode: 'edit', areaGone: true },
    });
    expect(surface.querySelector('#homes-editor-area-gone')?.textContent)
      .toContain('Saving adds it again');
    expect(surface.querySelector('#homes-editor-save')?.textContent?.trim()).toBe('Add again');
  });

  it('wires save and cancel', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const surface = mountWith({
      ...baseProps(),
      editor: { ...baseEditor(), onSave, onCancel },
    });
    (surface.querySelector('#homes-editor-save') as HTMLElement).click();
    (surface.querySelector('#homes-editor-cancel') as HTMLElement).click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
