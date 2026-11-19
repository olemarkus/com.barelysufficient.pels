import {
  changeOverrideDraft,
  formatActiveOverride,
  formatOverrideEndLine,
  formatOverrideSmartTaskCreateNote,
  newOverrideDraft,
  OVERRIDE_COPY,
  OVERRIDE_END_OPTIONS,
  resolveOverrideDraft,
  resolveOverrideSmartTaskNote,
  type OverrideDraft,
  type OverrideEndChoice,
} from '../../../../packages/shared-domain/src/settings/deviceOverrideDraft';
import { isDeviceOverrideInForce } from '../../../../packages/shared-domain/src/settings/deviceOverrides';
import { setLine, setVisible } from '../../../_shared/widgetDom';
import type {
  DeviceWidgetOverride,
  DeviceWidgetOverrideCommand,
  DeviceWidgetOverrideResponse,
} from '../deviceWidgetTypes';

const C = OVERRIDE_COPY;

const resolveFormTargets = (form: HTMLFormElement) => {
  const fields = form.querySelector<HTMLFieldSetElement>('[data-override-fields]');
  const temperature = form.querySelector<HTMLInputElement>('[name="temperature"]');
  const end = form.querySelector<HTMLSelectElement>('[name="end"]');
  const date = form.querySelector<HTMLInputElement>('[name="date"]');
  const at = form.querySelector<HTMLInputElement>('[name="at"]');
  const custom = form.querySelector<HTMLElement>('[data-override-custom]');
  const until = form.querySelector<HTMLElement>('[data-override-until]');
  const taskNote = form.querySelector<HTMLElement>('[data-override-task-note]');
  const error = form.querySelector<HTMLElement>('[data-override-error]');
  const endNow = form.querySelector<HTMLButtonElement>('[data-override-end]');
  const save = form.querySelector<HTMLButtonElement>('[data-override-save]');
  if (!fields || !temperature || !end || !date || !at || !custom || !until || !taskNote || !error || !endNow || !save) {
    return null;
  }
  return { fields, temperature, end, date, at, custom, until, taskNote, error, endNow, save };
};

type OverrideFormTargets = NonNullable<ReturnType<typeof resolveFormTargets>>;

export const resolveOverrideEditorTargets = (document: Document) => {
  const summary = document.querySelector<HTMLElement>('[data-override-summary]');
  const line = document.querySelector<HTMLElement>('[data-override-line]');
  const open = document.querySelector<HTMLButtonElement>('[data-override-open]');
  const message = document.querySelector<HTMLElement>('[data-override-message]');
  const view = document.querySelector<HTMLElement>('[data-override-view]');
  const form = document.querySelector<HTMLFormElement>('[data-override-form]');
  const back = document.querySelector<HTMLButtonElement>('[data-override-back]');
  const createNote = document.querySelector<HTMLElement>('[data-override-create-note]');
  if (!summary || !line || !open || !message || !view || !form || !back || !createNote) return null;
  const formTargets = resolveFormTargets(form);
  return formTargets === null ? null : { ...formTargets, summary, line, open, message, view, form, back, createNote };
};

export type OverrideEditorTargets = NonNullable<ReturnType<typeof resolveOverrideEditorTargets>>;

type CurrentOverride = { deviceId: string; override: DeviceWidgetOverride };

type OverrideEditorHost = {
  readCurrent: () => CurrentOverride | null;
  change: (command: DeviceWidgetOverrideCommand) => Promise<DeviceWidgetOverrideResponse>;
  update: (command: DeviceWidgetOverrideCommand, response: DeviceWidgetOverrideResponse) => void;
  onViewChange: () => void;
  focusTile: () => void;
};

const activeAt = (override: DeviceWidgetOverride, nowMs: number) => (
  override.active !== null && isDeviceOverrideInForce(override.active, nowMs) ? override.active : null
);

const readDraft = ({ temperature, end, date, at }: OverrideFormTargets): OverrideDraft => ({
  temperature: temperature.value, end: end.value as OverrideEndChoice, date: date.value, at: at.value,
});

const paintDraft = (targets: OverrideFormTargets, override: DeviceWidgetOverride): void => {
  const { custom, until, taskNote } = targets;
  const draft = readDraft(targets);
  const nowMs = Date.now();
  const resolved = resolveOverrideDraft(draft, override.range, nowMs, override.timeZone);
  setVisible(custom, draft.end === 'custom');
  setLine(until, resolved.ok ? formatOverrideEndLine(resolved.untilMs, nowMs, override.timeZone) : null);
  const { taskDeadlineAtMs } = override;
  const draftEnd = resolved.ok ? resolved.untilMs : null;
  setLine(taskNote, taskDeadlineAtMs === null ? null : resolveOverrideSmartTaskNote(draftEnd, taskDeadlineAtMs));
};

const fillDraft = (targets: OverrideFormTargets, override: DeviceWidgetOverride, nowMs: number): void => {
  const { temperature, end, date, at, endNow, save, error } = targets;
  const { active, range, timeZone } = override;
  const draft = active === null
    ? newOverrideDraft(override.defaultTemperatureC, nowMs, timeZone)
    : changeOverrideDraft(active, timeZone);
  temperature.value = draft.temperature;
  temperature.min = range.min === null ? '' : String(range.min);
  temperature.max = range.max === null ? '' : String(range.max);
  end.value = draft.end;
  date.value = draft.date;
  at.value = draft.at;
  setVisible(endNow, active !== null);
  save.textContent = active !== null ? C.saveChange : C.save;
  setLine(error, null);
  paintDraft(targets, override);
};

const populateEndOptions = (end: HTMLSelectElement): void => {
  for (const choice of OVERRIDE_END_OPTIONS) {
    const option = end.ownerDocument.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    end.append(option);
  }
};

const renderCreateNote = (
  note: HTMLElement,
  current: CurrentOverride | null,
  widgetView: string | undefined,
): void => {
  if (current === null || (widgetView !== 'quick' && widgetView !== 'compose' && widgetView !== 'preview')) {
    setLine(note, null);
    return;
  }
  const { override } = current;
  const nowMs = Date.now();
  const active = activeAt(override, nowMs);
  setLine(note, active === null ? null : formatOverrideSmartTaskCreateNote(active.untilMs, nowMs, override.timeZone));
};

export const createOverrideEditor = (targets: OverrideEditorTargets, host: OverrideEditorHost) => {
  const { view, form, fields, summary, line, open, back, end, error, message, endNow, save } = targets;
  let editing: CurrentOverride | null = null;

  const render = (current: CurrentOverride | null, widgetView: string | undefined): void => {
    const onTile = widgetView === 'tile';
    renderCreateNote(targets.createNote, current, widgetView);
    const openHadFocus = open.ownerDocument.activeElement === open;
    setVisible(view, editing !== null);
    setVisible(summary, onTile && current !== null);
    if (!current) {
      if (onTile && openHadFocus) host.focusTile();
      return;
    }
    const nowMs = Date.now();
    const { override } = current;
    const active = activeAt(override, nowMs);
    setLine(line, active !== null ? `${C.title} · ${formatActiveOverride(active, nowMs, override.timeZone)}` : null);
    open.textContent = active !== null ? `${C.change} override` : C.start;
  };

  const show = (): void => {
    const current = host.readCurrent();
    if (!current) return;
    const nowMs = Date.now();
    const { override } = current;
    const active = activeAt(override, nowMs);
    editing = { ...current, override: { ...override, active } };
    setLine(message, null);
    fillDraft(targets, editing.override, nowMs);
    host.onViewChange();
    back.focus();
  };

  const close = (): void => {
    if (!editing || fields.disabled) return;
    editing = null;
    host.onViewChange();
    if (summary.hidden) host.focusTile();
    else open.focus();
  };

  const setBusy = (value: boolean): void => {
    fields.disabled = value;
    back.disabled = value;
  };

  const send = async (command: DeviceWidgetOverrideCommand): Promise<void> => {
    const session = editing;
    setBusy(true);
    const reply = await host.change(command).catch((): DeviceWidgetOverrideResponse => (
      { ok: false, error: C.saveFailed }
    ));
    if (editing !== session) return;
    setBusy(false);
    if (!reply.ok && !reply.refresh) {
      setLine(error, reply.error);
      (command.action === 'save' ? save : endNow).focus();
      return;
    }
    host.update(command, reply);
    const savedMessage = command.expected === null ? C.started : C.changed;
    const confirmation = command.action === 'end' ? C.ended : savedMessage;
    message.classList.toggle('visually-hidden', reply.ok);
    setLine(message, reply.ok ? confirmation : reply.error);
    close();
  };

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!editing || fields.disabled) return;
    const { deviceId, override } = editing;
    const draft = readDraft(targets);
    const resolved = resolveOverrideDraft(draft, override.range, Date.now(), override.timeZone);
    if (!resolved.ok) {
      setLine(error, resolved.error);
      return;
    }
    void send({ deviceId, expected: override.active, action: 'save', draft });
  };

  const stop = (): void => {
    if (!editing?.override.active || fields.disabled) return;
    void send({ deviceId: editing.deviceId, expected: editing.override.active, action: 'end' });
  };

  populateEndOptions(end);
  const changeDraft = (): void => {
    setLine(error, null);
    if (editing) paintDraft(targets, editing.override);
  };
  const dismiss = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };
  open.addEventListener('click', show);
  back.addEventListener('click', close);
  form.addEventListener('input', changeDraft);
  // Some widget WebViews commit select changes without an input event.
  end.addEventListener('change', changeDraft);
  form.addEventListener('submit', submit);
  endNow.addEventListener('click', stop);
  view.addEventListener('keydown', dismiss);

  const destroy = (): void => {
    editing = null;
    open.removeEventListener('click', show);
    back.removeEventListener('click', close);
    form.removeEventListener('input', changeDraft);
    end.removeEventListener('change', changeDraft);
    form.removeEventListener('submit', submit);
    endNow.removeEventListener('click', stop);
    view.removeEventListener('keydown', dismiss);
  };
  return { render, isOpen: () => editing !== null, destroy };
};
