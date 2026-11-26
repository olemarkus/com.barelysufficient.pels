import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { DevicePowerSetupEntry } from '../../../contracts/src/settingsUi/devices.ts';
import {
  DEVICE_POWER_HISTORY_IMPORT,
  readDevicePowerHistoryImport,
  type DevicePowerHistoryImportOutcome,
  type DevicePowerHistoryImportRequest,
} from '../../../shared-domain/src/settings/devicePowerHistoryImport.ts';
import { setupControl } from './devicePowerSetupMarkup.ts';
import { getSettingFresh, setSetting, sleep } from './homey.ts';

type ImportSource = Pick<DevicePowerHistoryImportRequest, 'deviceId' | 'sourceDeviceId'>;
type ImportButton = HTMLElement & { disabled: boolean };

const IMPORT_WAIT_MS = 30_000;

const OUTCOME_TEXT: Record<DevicePowerHistoryImportOutcome, string> = {
  imported: 'Running power imported from meter history.',
  already_learned: 'PELS already has a running power estimate from this meter.',
  history_unavailable: 'PELS couldn’t find enough meter history to estimate running power.',
  source_changed: 'The power source changed. Refresh devices and try again.',
  save_failed: 'PELS couldn’t save the imported running power. Try again.',
};
const UNCONFIRMED_IMPORT = 'PELS couldn’t confirm the import. Refresh devices to check the running power.';

function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const octets = Array.from(crypto.getRandomValues(new Uint8Array(16)), (octet, index) => {
    if (index === 6) return (octet & 0x0f) | 0x40;
    return index === 8 ? (octet & 0x3f) | 0x80 : octet;
  });
  const hex = octets.map((octet) => octet.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function waitForImport(
  request: DevicePowerHistoryImportRequest,
): Promise<DevicePowerHistoryImportOutcome | undefined> {
  const deadline = Date.now() + IMPORT_WAIT_MS;
  await setSetting(DEVICE_POWER_HISTORY_IMPORT, request);
  while (Date.now() < deadline) {
    const raw = await getSettingFresh(DEVICE_POWER_HISTORY_IMPORT).catch(() => undefined);
    const result = readDevicePowerHistoryImport(raw);
    if (result?.kind === 'result' && result.id === request.id) return result.outcome;
    await sleep(500);
  }
  return undefined;
}

async function importHistory(source: ImportSource): Promise<DevicePowerHistoryImportOutcome | undefined> {
  let timer: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = window.setTimeout(() => resolve(undefined), IMPORT_WAIT_MS);
  });
  try {
    return await Promise.race([waitForImport({ kind: 'request', id: requestId(), ...source }), timeout]);
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}

type ImportControls = {
  row: HTMLElement;
  button: ImportButton;
  status: HTMLElement;
  dialog: MdDialog;
  cancel: HTMLElement;
  confirm: HTMLElement;
};

class DevicePowerHistoryImport {
  private source: ImportSource | undefined;
  private confirming: ImportSource | undefined;
  private importing = false;
  private message = '';

  constructor(private readonly controls: ImportControls, private readonly refresh: () => Promise<void>) {
    const { button, dialog, cancel, confirm } = controls;
    button.onclick = () => this.openConfirmation();
    cancel.onclick = () => { void dialog.close(); };
    confirm.onclick = () => { void dialog.close('confirm'); };
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') event.stopPropagation();
    });
    dialog.addEventListener('close', () => {
      const source = this.confirming;
      this.confirming = undefined;
      if (source && this.source === source && dialog.returnValue === 'confirm') void this.submit(source);
    });
  }

  show(entry: DevicePowerSetupEntry | undefined, selectedSource: string, saving: boolean): void {
    const savedSocket = entry?.sourceId;
    const ready = selectedSource === savedSocket && !saving && entry?.configured && entry.sourceReady
      && entry.sources.some(({ id, state }) => id === savedSocket && state === 'selectable');
    this.setSource(ready && savedSocket ? { deviceId: entry.id, sourceDeviceId: savedSocket } : undefined);
  }

  hide(): void {
    this.setSource(undefined);
  }

  private setSource(source: ImportSource | undefined): void {
    if (source?.deviceId !== this.source?.deviceId || source?.sourceDeviceId !== this.source?.sourceDeviceId) {
      this.source = source;
      this.message = '';
      const confirmationActive = this.confirming !== undefined;
      this.confirming = undefined;
      if (confirmationActive) void this.controls.dialog.close();
    }
    this.render();
  }

  private render(): void {
    const { row, button, status } = this.controls;
    row.hidden = this.source === undefined;
    button.disabled = this.importing;
    status.textContent = this.importing ? 'Importing from meter history…' : this.message;
  }

  private openConfirmation(): void {
    const { dialog } = this.controls;
    if (!this.source || this.importing || dialog.open) return;
    this.confirming = this.source;
    dialog.returnValue = '';
    void dialog.show();
  }

  private async submit(source: ImportSource): Promise<void> {
    this.importing = true;
    this.render();
    const outcome = await importHistory(source);
    if (this.source === source) this.message = outcome ? OUTCOME_TEXT[outcome] : UNCONFIRMED_IMPORT;
    this.importing = false;
    this.render();
    if (outcome === 'imported') void this.refresh().catch(() => {});
  }
}

export function mountDevicePowerHistoryImport(root: HTMLElement, refresh: () => Promise<void>) {
  const row = setupControl(root, 'history');
  const button = setupControl<ImportButton>(root, 'history-import');
  const status = setupControl(root, 'history-status');
  const dialog = setupControl<MdDialog>(root, 'history-confirmation');
  const cancel = setupControl(root, 'history-cancel');
  const confirm = setupControl(root, 'history-confirm');
  if (!row || !button || !status || !dialog || !cancel || !confirm) return undefined;
  return new DevicePowerHistoryImport({ row, button, status, dialog, cancel, confirm }, refresh);
}
