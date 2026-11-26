import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { DevicePowerSetupEntry } from '../../../contracts/src/settingsUi/devices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { sourceChangeWarning } from './devicePowerSetupChoices.ts';
import type { SetupDraft } from './devicePowerSetupWrites.ts';

export type GuidedControls = {
  dialog: MdDialog;
  title: HTMLElement;
  review: HTMLElement;
  simulation: HTMLElement;
  status: HTMLElement;
  dismiss: HTMLButtonElement;
};

export const readGuidedControls = (dialog: MdDialog): GuidedControls | undefined => {
  const title = dialog.querySelector<HTMLElement>('[slot="headline"]');
  const review = dialog.querySelector<HTMLElement>('[data-setup-review]');
  const simulation = dialog.querySelector<HTMLElement>('[data-setup-simulation]');
  const status = dialog.querySelector<HTMLElement>('[data-setup-status]');
  const dismiss = dialog.querySelector<HTMLButtonElement>('[data-setup-dismiss]');
  if (!title || !review || !simulation || !status || !dismiss) return undefined;
  return { dialog, title, review, simulation, status, dismiss };
};

function describeGuidedSetup(entry: DevicePowerSetupEntry, draft: SetupDraft): string {
  const socket = entry.sources.find(({ id }) => id === draft.source);
  const switchName = entry.binarySwitches?.find(({ id }) => id === draft.switchId)?.name;
  const switchLabel = switchName ?? (entry.defaultBinarySwitchAvailable ? 'the default on/off switch' : null);
  const control = switchLabel ? `PELS can turn off ${switchLabel}.` : '';
  if (draft.lastResort && !socket) {
    const watts = Number(draft.maximum).toLocaleString();
    const cut = `PELS can turn off ${switchLabel ?? 'this device'} as a last resort.`;
    return `${cut} Resuming requires room for ${watts} W.`;
  }
  if (draft.source && !socket) return 'The selected metering socket is unavailable.';
  const measurement = socket ? `PELS measures power using ${formatDisplayDeviceName(socket.name)}.`
    : 'PELS uses the device’s own power reading.';
  const watts = socket ? socket.measuredPowerW : entry.ownPowerW;
  const reading = watts === undefined ? 'No power reading yet.' : `Latest reading: ${watts.toLocaleString()} W.`;
  return [measurement, reading, control].filter(Boolean).join(' ');
}

export function describeSetupReadbackError(submitted: SetupDraft, accepted?: SetupDraft): string {
  let field = 'the saved setup';
  if (accepted) {
    if (submitted.switchId !== accepted.switchId) field = 'the on/off control';
    else if (submitted.source !== accepted.source) field = 'the power source';
    else if (submitted.maximum !== accepted.maximum) field = 'the maximum power draw';
  }
  return `Could not confirm ${field}. Try again or go back to check your choices.`;
}

export function renderGuidedReview(
  controls: GuidedControls, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
  reviewing: boolean, isSimulation: boolean, message: string,
): void {
  const { title, review, simulation, status, dismiss } = controls;
  if (entry) {
    const label = `Set up ${formatDisplayDeviceName(entry.name)}`;
    title.textContent = label;
    controls.dialog.setAttribute('aria-label', label);
  }
  review.hidden = !reviewing;
  review.textContent = reviewing && entry
    ? [describeGuidedSetup(entry, draft), sourceChangeWarning(entry, draft.source, true)].filter(Boolean).join(' ')
    : '';
  simulation.hidden = !reviewing || !isSimulation;
  status.hidden = !message;
  status.textContent = message;
  dismiss.textContent = reviewing ? 'Back' : 'Cancel';
}

const socketActions = new WeakMap<HTMLElement, string>();

export function renderManagedSockets(
  root: HTMLElement, entry: DevicePowerSetupEntry | undefined, saving: boolean, onRelease: (id: string) => void,
): void {
  const managed = entry?.sources.filter(({ state }) => state === 'managed') ?? [];
  const signature = JSON.stringify(managed.map(({ id, name }) => [id, name]));
  if (signature !== socketActions.get(root)) {
    socketActions.set(root, signature);
    root.replaceChildren(...managed.map(({ id, name }) => {
      const row = document.createElement('div');
      const note = document.createElement('p');
      const socketName = formatDisplayDeviceName(name);
      note.className = 'field__hint';
      note.textContent = `This immediately stops PELS switching ${socketName}.`
        + ' If the socket is off, turn it on in Homey.';
      const button = document.createElement('md-text-button');
      button.setAttribute('type', 'button');
      button.setAttribute('aria-label', `Use ${socketName} only as a meter`);
      button.textContent = 'Use only as a meter';
      button.onclick = () => onRelease(id);
      row.append(note, button);
      return row;
    }));
  }
  root.querySelectorAll('md-text-button').forEach((button) => button.toggleAttribute('disabled', saving));
}
