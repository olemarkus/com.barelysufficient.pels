import {
  modeSelect,
  modeNewInput,
  addModeButton,
  deleteModeButton,
  renameModeButton,
  modeNameEditor,
  modeNameConfirm,
  modeNameCancel,
  modeDeleteDialog,
  modeDeleteMessage,
  priorityList,
} from './dom.ts';
import { state } from './state.ts';

// The always-visible "New mode name" field is retired in favour of an on-demand
// inline editor: "+ New mode" and "Rename" reveal the same field with the right
// confirm label, and Cancel/confirm hide it again. Delete opens a confirmation
// dialog. This keeps a lone blank input off the page while all three flows share
// one affordance.

export type ModeEditorHandlers = {
  addMode: () => Promise<void>;
  renameMode: () => Promise<void>;
  deleteMode: () => Promise<void>;
};

let modeEditorMode: 'add' | 'rename' | null = null;

export const setModeEditorPending = (pending: boolean): void => {
  [
    addModeButton,
    renameModeButton,
    deleteModeButton,
    modeNameConfirm,
    modeNameCancel,
    modeNewInput,
    modeSelect,
  ].forEach((control) => control?.toggleAttribute('disabled', pending));
  priorityList?.toggleAttribute('inert', pending);
  priorityList?.querySelectorAll('.mode-target-input').forEach((input) => {
    input.toggleAttribute('disabled', pending);
  });
};

export const closeModeNameEditor = () => {
  modeEditorMode = null;
  if (modeNameEditor) modeNameEditor.hidden = true;
  if (modeNewInput) modeNewInput.value = '';
};

const openModeNameEditor = (mode: 'add' | 'rename') => {
  if (!modeNameEditor || !modeNewInput) return;
  modeEditorMode = mode;
  modeNameEditor.hidden = false;
  if (mode === 'rename') {
    modeNewInput.value = modeSelect?.value || state.editingMode || '';
    if (modeNameConfirm) modeNameConfirm.textContent = 'Rename';
  } else {
    modeNewInput.value = '';
    if (modeNameConfirm) modeNameConfirm.textContent = 'Create';
  }
  window.setTimeout(() => (modeNewInput as HTMLElement & { focus?: () => void }).focus?.(), 0);
};

export const initModeEditor = (handlers: ModeEditorHandlers) => {
  const confirmModeNameEditor = async () => {
    const value = (modeNewInput?.value || '').trim();
    if (!value) return;
    if (modeEditorMode === 'add') await handlers.addMode();
    else if (modeEditorMode === 'rename') await handlers.renameMode();
    closeModeNameEditor();
  };

  const openModeDeleteDialog = () => {
    const mode = modeSelect?.value || state.editingMode;
    if (!mode || !state.capacityPriorities[mode]) return;
    if (!modeDeleteDialog) {
      void handlers.deleteMode();
      return;
    }
    const message = `Delete “${mode}”? This removes its saved priorities and temperatures, and can’t be undone.`;
    if (modeDeleteMessage) modeDeleteMessage.textContent = message;
    // md-dialog does not reset returnValue on show(): after one confirmed delete
    // (returnValue='delete'), a later Escape/scrim dismiss re-fires `close` with
    // the stale 'delete' and would delete without confirmation. Clear it before
    // every open so only the dialog's Delete button can set it back.
    modeDeleteDialog.returnValue = '';
    modeDeleteDialog.show();
  };

  addModeButton?.addEventListener('click', () => openModeNameEditor('add'));
  renameModeButton?.addEventListener('click', () => openModeNameEditor('rename'));
  deleteModeButton?.addEventListener('click', openModeDeleteDialog);
  modeNameConfirm?.addEventListener('click', () => void confirmModeNameEditor());
  modeNameCancel?.addEventListener('click', closeModeNameEditor);
  modeNewInput?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      void confirmModeNameEditor();
    }
  });
  modeDeleteDialog?.addEventListener('close', () => {
    if (modeDeleteDialog.returnValue === 'delete') void handlers.deleteMode();
  });
};
